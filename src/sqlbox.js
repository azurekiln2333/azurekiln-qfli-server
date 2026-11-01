// Cloud SQL practice: a separate, socket-only mysqld (deployment/sqlbox) that
// never hosts business data. Each app user maps to a derived MySQL account
// restricted to its own `qs_<tag>_*` schemas; the App never sees credentials.
const crypto = require('node:crypto');
const mysql = require('mysql2');
const db = require('./db');
const { ApiError } = require('./gateway');
const { log } = require('./logging');

const limits = Object.freeze({
  sourceBytes: 256 * 1024,
  params: 64,
  paramBytes: 256 * 1024,
  rows: 1000,
  resultBytes: 1024 * 1024,
  results: 128,
  deadlineMs: 8000,
  running: 2,
  waiting: 16,
  queueMs: 10_000,
  userPending: 4,
  userPerMinute: 30,
  quotaBytes: 32 * 1024 * 1024,
  quotaSchemas: 8,
  quotaTables: 64,
});

// MySQL type codes the native client renders as hex when charset is binary (63).
const BINARY_TYPES = new Set([15, 16, 249, 250, 251, 252, 253, 254, 255]);
const HEX = /^[0-9a-f]{64}$/;

function configuration() {
  const socketPath = process.env.QFLI_SQLBOX_SOCKET || '';
  const adminPassword = process.env.QFLI_SQLBOX_ADMIN_PASSWORD || '';
  const userSecret = process.env.QFLI_SQLBOX_USER_SECRET || '';
  if (!socketPath || !adminPassword || !userSecret) {
    throw new ApiError(503, '云 MySQL 练习库尚未部署');
  }
  if (!socketPath.startsWith('/') || !HEX.test(adminPassword) || !HEX.test(userSecret)) {
    throw new ApiError(503, '云 MySQL 练习库配置无效');
  }
  return { socketPath, adminPassword, userSecret };
}

function identity(userId, config = configuration()) {
  const tag = crypto.createHash('sha256').update(`qfli-sqlbox/${userId}`).digest('hex').slice(0, 20);
  return {
    user: `qs_${tag}`,
    prefix: `qs_${tag}_`,
    schema: `qs_${tag}_main`,
    // Underscores are wildcards in grants and LIKE; escape them literally.
    pattern: `qs\\_${tag}\\_%`,
    password: crypto.createHmac('sha256', config.userSecret).update(`qfli-sqlbox/${userId}`).digest('hex'),
  };
}

let adminPool;
function admin(config = configuration()) {
  adminPool ??= mysql.createPool({
    socketPath: config.socketPath, user: 'qfli_sqlbox', password: config.adminPassword,
    connectionLimit: 2, charset: 'utf8mb4', flags: ['-LOCAL_FILES'], connectTimeout: 5000,
  }).promise();
  return adminPool;
}

async function adminQuery(sql, params = []) {
  try {
    const [rows] = await admin().query(sql, params);
    return rows;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    log('sqlbox.admin_failed', { code: error.code, errno: error.errno }, 'error');
    throw new ApiError(503, '云 MySQL 练习库暂不可用');
  }
}

// Fail closed unless this is the hardened practice server, not the business one.
let verified = null;
let verifiedAt = 0;
async function verifyIsolation() {
  if (verified && (verified.ok || Date.now() - verifiedAt < 30_000)) {
    if (verified.ok) return verified;
    throw new ApiError(503, '云 MySQL 练习库未通过隔离检查');
  }
  verifiedAt = Date.now();
  try {
    const [row] = await adminQuery(`SELECT @@server_uuid AS \`uuid\`, @@version AS \`version\`,
      @@skip_networking AS \`network\`, @@local_infile AS \`infile\`,
      @@secure_file_priv AS \`filePriv\`, @@event_scheduler AS \`events\``);
    let businessUuid = null;
    if (db.driver === 'mysql') {
      businessUuid = (await db.prepare('SELECT @@server_uuid AS uuid').get()).uuid;
    }
    const ok = String(row.version).startsWith('8.4.') && Number(row.network) === 1 &&
      // secure_file_priv=NULL disables file I/O; 8.4 reports it as the string 'NULL'.
      Number(row.infile) === 0 && (row.filePriv === null || row.filePriv === 'NULL') &&
      row.events === 'OFF' &&
      typeof row.uuid === 'string' && row.uuid !== businessUuid;
    verified = { ok, version: row.version };
    if (!ok) log('sqlbox.isolation_failed', { sameServer: row.uuid === businessUuid }, 'error');
  } catch (error) {
    verified = { ok: false };
    if (error instanceof ApiError) throw error;
    log('sqlbox.isolation_error', { code: error.code }, 'error');
  }
  if (!verified.ok) throw new ApiError(503, '云 MySQL 练习库未通过隔离检查');
  return verified;
}

const FULL = 'SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, ' +
  'CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, ' +
  'EXECUTE, TRIGGER';
const RESTRICTED = 'SELECT, DELETE, DROP';

// Names and passwords are derived hex, so they are safe as SQL literals.
async function grant(account, restricted) {
  await adminQuery(`REVOKE IF EXISTS ALL PRIVILEGES ON \`${account.pattern}\`.* FROM '${account.user}'@'localhost'`);
  await adminQuery(`GRANT ${restricted ? RESTRICTED : FULL} ON \`${account.pattern}\`.* TO '${account.user}'@'localhost'`);
}

const provisioned = new Map();
async function provision(userId, { force = false } = {}) {
  const account = identity(userId);
  if (!force && provisioned.has(userId)) return { ...account, ...provisioned.get(userId) };
  await verifyIsolation();
  const resources = 'WITH MAX_QUERIES_PER_HOUR 3600 MAX_UPDATES_PER_HOUR 1800 ' +
    'MAX_CONNECTIONS_PER_HOUR 1800 MAX_USER_CONNECTIONS 2';
  await adminQuery(`CREATE USER IF NOT EXISTS '${account.user}'@'localhost' ` +
    `IDENTIFIED BY '${account.password}' ${resources}`);
  await adminQuery(`ALTER USER '${account.user}'@'localhost' IDENTIFIED BY '${account.password}' ` +
    `${resources} ACCOUNT UNLOCK`);
  const state = { restricted: false };
  await grant(account, false);
  await adminQuery(`CREATE DATABASE IF NOT EXISTS \`${account.schema}\` ` +
    'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  provisioned.set(userId, state);
  await enforceQuota(userId, account, state);
  return { ...account, ...state };
}

async function usage(account) {
  const like = account.pattern;
  const [schemas] = await adminQuery(
    'SELECT COUNT(*) AS count FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?', [like]);
  const [tables] = await adminQuery(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA LIKE ?', [like]);
  // Table statistics miss off-page LOBs; allocated tablespace size is the real disk use.
  const [space] = await adminQuery(`SELECT COALESCE(SUM(ALLOCATED_SIZE), 0) AS bytes
    FROM information_schema.INNODB_TABLESPACES WHERE NAME LIKE ?`, [`${like}/%`]);
  return { bytes: Number(space.bytes), schemas: Number(schemas.count), tables: Number(tables.count) };
}

// Over quota the account keeps SELECT/DELETE/DROP so the user can clean up.
async function enforceQuota(userId, account, state = provisioned.get(userId)) {
  const current = await usage(account);
  const over = current.bytes > limits.quotaBytes || current.schemas > limits.quotaSchemas ||
    current.tables > limits.quotaTables;
  if (state && over !== state.restricted) {
    await grant(account, over);
    state.restricted = over;
  }
  return { ...current, restricted: over };
}

// Global FIFO slots plus per-user serialization; queueing absorbs bursts only.
let running = 0;
const waiting = [];
const users = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [userId, user] of users) {
    user.times = user.times.filter(time => time > cutoff);
    if (!user.pending && !user.times.length) users.delete(userId);
  }
}, 60_000).unref();

function acquireSlot() {
  if (running < limits.running && !waiting.length) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= limits.waiting) throw new ApiError(429, '云 MySQL 繁忙，请稍后重试');
  return new Promise((resolve, reject) => {
    const item = { resolve, reject };
    item.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(item), 1);
      reject(new ApiError(429, '云 MySQL 排队超时，请稍后重试'));
    }, limits.queueMs);
    waiting.push(item);
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); } else running--;
}

async function admit(userId, work) {
  const now = Date.now();
  const user = users.get(userId) ?? { times: [], pending: 0, tail: Promise.resolve() };
  users.set(userId, user);
  user.times = user.times.filter(time => now - time < 60_000);
  if (user.times.length >= limits.userPerMinute) throw new ApiError(429, 'SQL 执行过于频繁，请稍后再试');
  if (user.pending >= limits.userPending) throw new ApiError(429, '上一条 SQL 仍在执行，请稍候');
  user.times.push(now);
  user.pending++;
  const previous = user.tail;
  const turn = previous.then(async () => {
    await acquireSlot();
    try { return await work(); } finally { releaseSlot(); }
  });
  user.tail = turn.catch(() => {});
  try { return await turn; } finally { user.pending--; }
}

function cellText(buffer, column) {
  if (buffer === null) return null;
  return column.binary ? buffer.toString('hex').toUpperCase() : buffer.toString('utf8');
}

function emptyResult() {
  return { available: true, exitCode: 0, error: '', sqlState: '', affectedRows: 0,
    truncated: false, columns: [], columnInfo: [], rows: [] };
}

const CONNECT_ERRORS = new Map([
  [1226, [429, '云 MySQL 每小时额度已用完，请稍后再试']],
  [1203, [429, '云 MySQL 连接数已满，请稍后重试']],
  [1040, [429, '云 MySQL 连接数已满，请稍后重试']],
]);

// One fresh connection per request: no session state (USE, variables, temp
// tables) leaks between requests. Output is bounded; execution is drained.
function run(account, { database, source, params, script }) {
  const config = configuration();
  const connection = mysql.createConnection({
    socketPath: config.socketPath, user: account.user, password: account.password,
    database: database || undefined, charset: 'utf8mb4', flags: ['-LOCAL_FILES'],
    multipleStatements: script, typeCast: false, rowsAsArray: true, connectTimeout: 5000,
  });
  connection.on('error', () => {});
  const results = [];
  let current = null, rows = 0, bytes = 0, truncated = false, statementError = null;
  let connected = false, timedOut = false;
  const push = result => {
    if (results.length < limits.results) results.push(result); else truncated = true;
  };
  return new Promise(resolve => {
    let settled = false, killTimer, destroyTimer;
    const finish = connectError => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(destroyTimer);
      connection.destroy();
      resolve({ results, truncated, statementError, connectError: connected ? null : connectError, timedOut });
    };
    killTimer = setTimeout(() => {
      timedOut = true;
      if (connection.threadId) adminQuery(`KILL QUERY ${Number(connection.threadId)}`).catch(() => {});
      destroyTimer = setTimeout(() => finish(null), 1500);
    }, limits.deadlineMs);
    connection.connect(error => { if (!error) connected = true; });
    const query = connection.query(params.length ? { sql: source, values: params } : source);
    query.on('fields', fields => {
      if (!fields) return;
      const columns = fields.map(field => ({ name: field.name, nativeType: field.columnType,
        binary: field.characterSet === 63 && BINARY_TYPES.has(field.columnType) }));
      const size = columns.reduce((sum, column) => sum + 16 + Buffer.byteLength(column.name), 0);
      current = { ...emptyResult(), columns: columns.map(column => column.name), columnInfo: columns };
      if (bytes + size > limits.resultBytes) { current.columns = []; current.columnInfo = []; current.truncated = true; }
      else bytes += size;
      push(current);
    });
    query.on('result', row => {
      if (!Array.isArray(row)) {
        push({ ...emptyResult(), affectedRows: row?.affectedRows ?? 0 });
        current = null;
        return;
      }
      if (!current || current.truncated || !current.columnInfo.length) return;
      const cells = row.map((value, index) => cellText(value, current.columnInfo[index]));
      const size = cells.reduce((sum, cell) => sum + 8 + (cell === null ? 0 : Buffer.byteLength(cell)), 0);
      if (rows >= limits.rows || bytes + size > limits.resultBytes) { current.truncated = true; return; }
      rows++;
      bytes += size;
      current.rows.push(cells);
    });
    query.on('error', error => {
      statementError = { errno: error.errno ?? 1, sqlState: error.sqlState ?? '',
        message: error.sqlMessage ?? error.message };
      if (error.fatal) finish(error);
    });
    query.on('end', () => finish(null));
  });
}

function failure(result, error) {
  result.exitCode = error.errno;
  result.error = error.message;
  result.sqlState = error.sqlState;
}

// Same JSON shape as the native SQLab client (SqlQueryResult/SqlScriptResult).
function shape(outcome, script) {
  const { results } = outcome;
  let error = outcome.statementError;
  if (outcome.timedOut) {
    error = { errno: 3024, sqlState: 'HY000', message: `SQL 执行超过 ${limits.deadlineMs / 1000} 秒，已停止` };
  }
  const truncated = outcome.truncated || results.some(result => result.truncated);
  const affectedRows = results.reduce((sum, result) => sum + result.affectedRows, 0);
  if (!script) {
    const summary = { ...(results.find(result => result.columns.length) ?? results[0] ?? emptyResult()) };
    summary.affectedRows = summary.columns.length ? 0 : affectedRows;
    summary.truncated = truncated;
    if (error) failure(summary, error);
    return summary;
  }
  if (error) {
    const failed = emptyResult();
    failure(failed, error);
    if (results.length < limits.results) results.push(failed);
  }
  const summary = { ...emptyResult(), affectedRows, truncated };
  if (error) failure(summary, error);
  return { ...summary, results };
}

function database(value, account) {
  if (value === undefined) return account.schema;
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 64 || !value.startsWith(account.prefix) ||
      !/^[A-Za-z0-9_$]+$/.test(value)) {
    throw new ApiError(400, `云 MySQL 数据库名必须以 ${account.prefix} 开头`);
  }
  return value;
}

function request(body, script) {
  const allowed = script ? ['database', 'source'] : ['database', 'source', 'params'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) {
    throw new ApiError(400, 'SQL 请求格式无效');
  }
  const { source, params = [] } = body;
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') ||
      Buffer.byteLength(source) > limits.sourceBytes) {
    throw new ApiError(400, `SQL 需为 1 字节到 ${limits.sourceBytes / 1024} KiB 的文本`);
  }
  let paramBytes = 0;
  if (!Array.isArray(params) || params.length > limits.params ||
      params.some(value => value !== null && typeof value !== 'string') ||
      params.some(value => (paramBytes += value === null ? 0 : Buffer.byteLength(value)) > limits.paramBytes)) {
    throw new ApiError(400, 'SQL 参数无效');
  }
  return { database: body.database, source, params };
}

const READ_ONLY = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b[^;]*;?\s*$/i;

async function execute(userId, body, { script = false } = {}) {
  const input = request(body, script);
  return admit(userId, async () => {
    let account = await provision(userId);
    const options = { database: database(input.database, account), source: input.source,
      params: input.params, script };
    let outcome = await run(account, options);
    if (outcome.connectError?.errno === 1045) {
      account = await provision(userId, { force: true });
      outcome = await run(account, options);
    }
    const connectError = outcome.connectError;
    if (connectError) {
      if ([1044, 1049].includes(connectError.errno)) outcome.statementError ??= { errno: connectError.errno,
        sqlState: connectError.sqlState ?? '', message: connectError.sqlMessage ?? connectError.message };
      else if (CONNECT_ERRORS.has(connectError.errno)) throw new ApiError(...CONNECT_ERRORS.get(connectError.errno));
      else {
        log('sqlbox.connect_failed', { code: connectError.code, errno: connectError.errno }, 'error');
        throw new ApiError(503, '云 MySQL 练习库暂不可用');
      }
    }
    if (!READ_ONLY.test(input.source)) await enforceQuota(userId, account);
    return shape(outcome, script);
  });
}

async function info(userId) {
  const account = await provision(userId);
  const current = await usage(account);
  return { engine: 'mysql', version: verified?.version ?? '', prefix: account.prefix,
    defaultDatabase: account.schema, restricted: account.restricted,
    usage: current, limits: { bytes: limits.quotaBytes, schemas: limits.quotaSchemas,
      tables: limits.quotaTables, rows: limits.rows, resultBytes: limits.resultBytes,
      seconds: limits.deadlineMs / 1000, perMinute: limits.userPerMinute } };
}

async function reset(userId) {
  return admit(userId, async () => {
    const account = await provision(userId);
    const schemas = await adminQuery(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?', [account.pattern]);
    for (const { name } of schemas) {
      if (!name.startsWith(account.prefix) || !/^[A-Za-z0-9_$]+$/.test(name)) continue;
      await adminQuery(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    provisioned.delete(userId);
    const fresh = await provision(userId);
    return { ok: true, dropped: schemas.length, defaultDatabase: fresh.schema };
  });
}

module.exports = { limits, identity, execute, info, reset, shape, cellText, _request: request };
