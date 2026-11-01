// 路由级集成测试：真实 Express + 真实终端池，回环执行器桩，假认证只注入用户。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-routes-'));
process.env.TERMINAL_RATE_LIMIT = '1000';

const db = require('../src/db');
const SECRET = 'b'.repeat(40);

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

// 假认证只设置 req.userId/req.user，其余全部走真实路由与真实池。
const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authRequired(req, res, next) {
      const header = req.headers.authorization || '';
      const id = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!/^user_[a-f0-9]{32}$/.test(id)) return res.status(401).json({ error: '未登录' });
      req.userId = id;
      req.user = { id, username: 'route-test', is_admin: false };
      next();
    },
    publicUser: async () => ({}),
  },
};

// 包裹真实审计，只为断言调用顺序，不替换写入逻辑。
const realAudit = require('../src/audit');
const auditPath = require.resolve('../src/audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: {
    ...realAudit,
    audit: async (req, meta) => {
      req.trace?.push('audit:start');
      await realAudit.audit(req, meta);
      req.trace?.push('audit:done');
    },
  },
};

const router = require('../src/routes/terminal');

for (const layer of router.stack) {
  for (const handler of layer.route ? layer.route.stack : [layer]) {
    const original = handler.handle;
    if (original.length === 4) continue;
    handler.handle = (req, res, next) => {
      try { Promise.resolve(original(req, res, next)).catch(next); } catch (error) { next(error); }
    };
  }
}

const express = require('express');
const app = express();
const traces = new Map();

app.use((req, res, next) => {
  const id = req.get('x-test-trace');
  const trace = [];
  if (id) traces.set(id, trace);
  req.trace = trace;
  const originalWrite = res.write.bind(res);
  res.write = (chunk, ...args) => {
    const text = typeof chunk === 'string' ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    if (text.includes('"type":"progress"')) trace.push('write:progress');
    if (text.includes('"type":"stdout"')) trace.push('write:stdout');
    if (text.includes('"type":"result"')) trace.push('write:result');
    if (text.includes('"type":"error"')) trace.push('write:error');
    return originalWrite(chunk, ...args);
  };
  const originalEnd = res.end.bind(res);
  res.end = (chunk, ...args) => {
    const text = typeof chunk === 'string' ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    if (text.includes('"exitCode"')) trace.push('write:json');
    trace.push('end');
    return originalEnd(chunk, ...args);
  };
  res.once('finish', () => trace.push('finish'));
  res.once('close', () => trace.push('close'));
  next();
});
app.use('/api/terminal', express.json({ limit: '384kb' }), router);
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  res.status(error.status || 500).json({ error: error.message });
});

let server;
let base;

test.before(async () => {
  await db.ready;
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  await Promise.all(createStub.all.map(stub => stub.close()));
});

test.beforeEach(async () => {
  await db.prepare('DELETE FROM terminal_slots').run();
  await db.prepare('DELETE FROM audit_logs').run();
  delete process.env.QFLI_TERMINAL_URL;
  delete process.env.QFLI_TERMINAL_SECRET;
  delete process.env.QFLI_TERMINAL_NODES;
  // 路由持有首次加载的 pool 引用，复用同一实例并清空健康缓存。
  require('../src/terminal-pool')._resetState();
});

function createStub(id) {
  const state = {
    id, ready: true, sessions: 0, exec: [], resets: [], healthHits: 0,
    execBehavior: null, streamBehavior: null, resetBehavior: null,
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      state.healthHits += 1;
      res.statusCode = state.ready ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ready: state.ready, capacity: {
        sessions: state.sessions, running: 0, waiting: 0,
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
    if (req.url === '/v1/session' && req.method === 'DELETE') {
      state.resets.push(body.userId);
      if (state.resetBehavior) return state.resetBehavior(req, res, body);
      state.sessions = 0;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, reset: true }));
      return;
    }
    if (req.url === '/v1/exec') {
      state.exec.push(body);
      if (state.execBehavior) return state.execBehavior(req, res, body, state);
      state.sessions = 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' }));
      return;
    }
    if (req.url === '/v1/exec/stream') {
      state.exec.push(body);
      if (state.streamBehavior) return state.streamBehavior(req, res, body, state);
      state.sessions = 1;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ type: 'progress', stage: 'running' })}\n`);
      res.write(`${JSON.stringify({ type: 'stdout', text: 'ok' })}\n`);
      res.end(`${JSON.stringify({ type: 'result', stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' })}\n`);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      const stub = Object.assign(state, {
        url,
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
      createStub.all.push(stub);
      resolve(stub);
    });
  });
}
createStub.all = [];

function configure(...nodes) {
  process.env.QFLI_TERMINAL_NODES = JSON.stringify(nodes.map(node => ({
    id: node.id, url: node.url, secret: SECRET, ...(node.draining ? { draining: true } : {}),
  })));
}

let traceNumber = 0;
async function request(method, route, { user, body, trace, signal } = {}) {
  const id = trace || `t${++traceNumber}`;
  const response = await fetch(`${base}/api/terminal${route}`, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer ${user}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-test-trace': id,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal || AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json, id };
}

function traceOf(id) {
  return traces.get(id) || [];
}

function assertOrder(trace, expected) {
  let cursor = -1;
  for (const marker of expected) {
    const index = trace.indexOf(marker, cursor + 1);
    assert.ok(index > cursor, `缺少或乱序的标记 ${marker}: ${trace.join(',')}`);
    cursor = index;
  }
}

async function auditRows(user) {
  return db.prepare('SELECT action, detail FROM audit_logs WHERE user_id = ? ORDER BY rowid').all(user);
}

test('POST /exec audits before responding and settles the slot to idle', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(1);
  const reply = await request('POST', '/exec', { user, body: { command: 'echo hi' } });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' });
  const trace = traceOf(reply.id);
  assertOrder(trace, ['audit:start', 'audit:done', 'write:json', 'end']);
  assert.ok(trace.includes('finish'), trace.join(','));
  const rows = await auditRows(user);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'terminal.exec');
  assert.match(rows[0].detail, /exit=0/);
  const slot = await db.prepare('SELECT * FROM terminal_slots WHERE node_id = ?').get('alpha');
  assert.equal(slot.phase, 'idle');
  assert.equal(slot.user_id, user);
});

test('POST /exec/stream writes result before end and audits after the stream', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(2);
  const reply = await request('POST', '/exec/stream', { user, body: { command: 'echo hi' } });
  assert.equal(reply.status, 200);
  const events = reply.text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'progress');
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).stdout, 'ok');
  const trace = traceOf(reply.id);
  assertOrder(trace, ['write:progress', 'write:stdout', 'write:result', 'end', 'audit:start', 'audit:done']);
  assert.ok(trace.includes('finish'), trace.join(','));
  const rows = await auditRows(user);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'terminal.exec');
});

test('missing credentials are rejected before any pool work', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const reply = await request('POST', '/exec', { body: { command: 'echo hi' } });
  assert.equal(reply.status, 401);
  assert.equal(alpha.exec.length, 0);
  assert.equal(traceOf(reply.id).includes('audit:start'), false);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM terminal_slots').get();
  assert.equal(count.n, 0);
});

test('GET /pwd reports configured per-node capacity without probing or sandbox', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const user = userId(19);
  const before = alpha.healthHits + beta.healthHits;
  const reply = await request('GET', '/pwd', { user });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.cwd, '/workspace');
  assert.equal(reply.json.nodes, 2);
  assert.equal(reply.json.sessionsPerNode, 1);
  assert.equal(reply.json.workspaceMiB, 256);
  assert.equal(reply.json.idleSeconds, 120);
  assert.equal(reply.json.lifetimeSeconds, 1860);
  assert.equal(reply.json.sessions, undefined);
  assert.equal(alpha.healthHits + beta.healthHits, before);
  assert.equal(alpha.exec.length + beta.exec.length, 0);
  assert.equal(alpha.resets.length + beta.resets.length, 0);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM terminal_slots').get();
  assert.equal(count.n, 0);
});

test('capacity rejection is plain JSON, leaves no audit and no execution', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const owner = userId(3);
  const other = userId(4);
  assert.equal((await request('POST', '/exec', { user: owner, body: { command: 'one' } })).status, 200);
  const rejected = await request('POST', '/exec', { user: other, body: { command: 'two' } });
  assert.equal(rejected.status, 429);
  assert.match(rejected.json.error, /会话已满/);
  assert.equal(traceOf(rejected.id).includes('audit:start'), false);
  assert.equal((await auditRows(other)).length, 0);
  assert.equal(alpha.exec.length, 1);

  const streamRejected = await request('POST', '/exec/stream', { user: other, body: { command: 'three' } });
  assert.equal(streamRejected.status, 429);
  assert.match(streamRejected.json.error, /会话已满/);
  assert.equal(traceOf(streamRejected.id).includes('audit:start'), false);
});

test('DELETE /session is idempotent, routed to the owner and audited', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(5);

  const empty = await request('DELETE', '/session', { user });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { ok: true });
  assert.deepEqual(alpha.resets, []);

  await request('POST', '/exec', { user, body: { command: 'echo hi' } });
  const reset = await request('DELETE', '/session', { user });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { ok: true });
  assert.deepEqual(alpha.resets, [user]);
  const slot = await db.prepare('SELECT * FROM terminal_slots WHERE node_id = ?').get('alpha');
  assert.equal(slot.phase, 'free');
  assert.equal(slot.user_id, null);
  const rows = (await auditRows(user)).map(row => row.action);
  assert.deepEqual(rows, ['terminal.reset', 'terminal.exec', 'terminal.reset']);
});

test('aborted stream quarantines the owner and recovery requires a confirmed reset', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const user = userId(6);

  assert.equal((await request('POST', '/exec', { user, body: { command: 'warmup' } })).status, 200);
  assert.equal(alpha.exec.length, 1);

  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  let streamStarted;
  const started = new Promise(resolve => { streamStarted = resolve; });
  alpha.streamBehavior = (_req, res, _body, state) => {
    state.sessions = 1;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ type: 'progress', stage: 'running' })}\n`);
    res.once('close', upstreamClosed);
    streamStarted();
    // 故意不结束：客户端断线时业务端必须取消并隔离。
  };

  const controller = new AbortController();
  const pending = request('POST', '/exec/stream', {
    user, body: { command: 'long build' }, signal: controller.signal, trace: 'abort-stream',
  }).catch(error => error);
  await started;
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.name, 'AbortError');
  await closed;
  const abortTrace = traceOf('abort-stream');
  assert.equal(abortTrace.includes('audit:start'), false);
  const slot = await db.prepare('SELECT * FROM terminal_slots WHERE node_id = ?').get('alpha');
  assert.equal(slot.phase, 'quarantine');
  assert.equal(slot.user_id, user);

  // 隔离期内即使 beta 空闲也不得改派。
  const blocked = await request('POST', '/exec', { user, body: { command: 'retry' } });
  assert.equal(blocked.status, 503);
  assert.match(blocked.json.error, /待恢复/);
  assert.equal(beta.exec.length, 0);
  assert.equal(alpha.exec.length, 2);

  // 路由级确认清理后才恢复，并继续留在原节点。
  const reset = await request('DELETE', '/session', { user });
  assert.equal(reset.status, 200);
  assert.deepEqual(alpha.resets, [user]);
  const recovered = await request('POST', '/exec', { user, body: { command: 'after reset' } });
  assert.equal(recovered.status, 200);
  assert.equal(alpha.exec.length, 3);
  assert.equal(beta.exec.length, 0);
  const rows = (await auditRows(user)).map(row => row.action);
  assert.deepEqual(rows, ['terminal.exec', 'terminal.reset', 'terminal.exec']);
});