// 可选 MySQL 集成测试：需显式开启，避免误连生产库。
// 运行：QFLI_TEST_MYSQL=1 DB_DRIVER=mysql MYSQL_HOST=... MYSQL_PORT=... \
//       MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=qfli_pool_test \
//       node --test test/terminal-pool.mysql.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

if (process.env.QFLI_TEST_MYSQL !== '1') {
  test('MySQL terminal pool integration (opt-in)', {
    skip: '设置 QFLI_TEST_MYSQL=1 和 MYSQL_* 测试库后运行',
  }, () => {});
  return;
}

if (!/test/i.test(process.env.MYSQL_DATABASE || '')) {
  throw new Error('拒绝运行：MYSQL_DATABASE 必须包含 test');
}

const db = require('../src/db');
const SECRET = 'c'.repeat(40);
const NODE_IDS = ['mysql-a', 'mysql-b'];

function userId(number) {
  return `user_${number.toString(16).padStart(32, '0')}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createStub(id) {
  const state = { id, exec: [], resets: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ready: true, capacity: {
        sessions: 0, running: 0, waiting: 0,
        sessionsLimit: 1, runningLimit: 1, queueLimit: 8,
      } }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    const body = JSON.parse(await readBody(req));
    if (req.url === '/v1/session') {
      state.resets.push(body.userId);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, reset: true }));
      return;
    }
    state.exec.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(Object.assign(state, {
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
    })));
  });
}

function loadPool() {
  const modulePath = require.resolve('../src/terminal-pool');
  delete require.cache[modulePath];
  return require('../src/terminal-pool');
}

const stubs = [];

async function cleanup() {
  for (const id of NODE_IDS) {
    await db.prepare('DELETE FROM terminal_slots WHERE node_id = ?').run(id);
  }
}

test.before(async () => {
  await db.ready;
  stubs.push(await createStub(NODE_IDS[0]));
  stubs.push(await createStub(NODE_IDS[1]));
  process.env.QFLI_TERMINAL_NODES = JSON.stringify(stubs.map(stub => ({
    id: stub.id, url: stub.url, secret: SECRET,
  })));
  delete process.env.QFLI_TERMINAL_URL;
  delete process.env.QFLI_TERMINAL_SECRET;
  await cleanup();
});

test.after(async () => {
  await cleanup();
  await Promise.all(stubs.map(stub => stub.close()));
  if (db.close) await db.close();
});

test.beforeEach(async () => {
  await cleanup();
});

test('MySQL schema, shared placement and cross-replica concurrency hold', async () => {
  const rows = await db.prepare('SELECT * FROM terminal_coord WHERE `key` = ?').get('pool');
  assert.equal(Number(rows.version) >= 1, true);

  const replicaA = loadPool();
  const replicaB = loadPool();
  replicaA._resetState();
  replicaB._resetState();

  // 两个用户经两个业务实例同时放置，必须落在不同节点。
  const placed = await Promise.all([
    replicaA._place(userId(101)),
    replicaB._place(userId(102)),
  ]);
  const nodes = placed.map(entry => entry.node.id).sort();
  assert.deepEqual(nodes, [...NODE_IDS].sort());

  // 同一用户经两个实例并发请求：只能拿到一个预留。
  const settled = await Promise.allSettled([
    replicaA._place(userId(103)),
    replicaB._place(userId(103)),
  ]);
  const ok = settled.filter(result => result.status === 'fulfilled');
  const denied = settled.filter(result => result.status === 'rejected');
  assert.equal(ok.length, 0, '两个节点都已被占用时应全部拒绝');
  assert.equal(denied.length, 2);
  for (const result of denied) assert.equal(result.reason.status, 429);

  // 释放一个节点后，同一用户的并发请求仍只能有一个成功。
  const freeNode = placed[0].node.id;
  const stale = placed.find(entry => entry.node.id === freeNode);
  await replicaA._finalize(stale, 'release');
  const race = await Promise.allSettled([
    replicaA._place(userId(104)),
    replicaB._place(userId(104)),
  ]);
  const wins = race.filter(result => result.status === 'fulfilled');
  const losses = race.filter(result => result.status === 'rejected');
  assert.equal(wins.length, 1, JSON.stringify(race.map(r => r.status)));
  assert.equal(losses.length, 1);
  // 新用户看不到他人令牌，满载/被占用时得到容量拒绝。
  assert.ok([409, 429].includes(losses[0].reason.status));

  // 令牌围栏：旧令牌不能释放新操作。
  const winner = wins[0].value;
  const other = loadPool();
  other._resetState();
  assert.equal(await replicaA._finalize({ ...winner, token: 'stale-token' }, 'release'), false);
  const row = await db.prepare('SELECT * FROM terminal_slots WHERE node_id = ?').get(winner.node.id);
  assert.equal(row.phase, 'reserved');
  assert.equal(row.operation_token, winner.token);
  assert.equal(await replicaA._finalize(winner, 'release'), true);
});

test('MySQL dispatch path uses the shared reservation and confirms reset', async () => {
  const pool = loadPool();
  pool._resetState();
  const user = userId(105);
  const req = { userId: user, aborted: false, requestId: 'mysql-it',
    once() {}, off() {} };
  const res = { destroyed: false, writableEnded: false, once() {}, off() {} };
  const result = await pool.execute('echo hi', req, res);
  assert.deepEqual(result, { stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' });
  const used = stubs.find(stub => stub.exec.length === 1);
  assert.ok(used, '应当只有一个执行器收到命令');
  const row = await db.prepare('SELECT * FROM terminal_slots WHERE user_id = ?').get(user);
  assert.equal(row.phase, 'idle');

  const resetReq = { userId: user, aborted: false, requestId: 'mysql-it-reset',
    once() {}, off() {} };
  const resetRes = { destroyed: false, writableEnded: false, once() {}, off() {} };
  assert.deepEqual(await pool.reset(resetReq, resetRes), { ok: true });
  assert.deepEqual(used.resets, [user]);
  const cleared = await db.prepare('SELECT * FROM terminal_slots WHERE user_id = ?').get(user);
  assert.equal(cleared, undefined);
});
