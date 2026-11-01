// 终端池聚焦测试：共享数据库协调、用户亲和、容量、隔离、回收与围栏。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-pool-'));

const db = require('../src/db');
const { ApiError } = require('../src/gateway');
const SECRET = 'a'.repeat(40);

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

function fakeRequest(id) {
  const req = new EventEmitter();
  req.userId = id;
  req.aborted = false;
  req.requestId = 'test-request';
  return req;
}

function fakeResponse() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.write = chunk => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  res.chunks = [];
  return res;
}

// 真实回环执行器桩：健康、执行、回收都走 HTTP。
function createStub(id) {
  const stubs = createStub.all;
  const state = {
    id,
    ready: true,
    sessions: 0,
    exec: [],
    resets: [],
    events: [],
    execBehavior: null,
    streamBehavior: null,
    resetBehavior: null,
    requests: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = req.url;
    if (req.method === 'GET' && url === '/health') {
      state.requests.push('health');
      const ready = state.ready;
      res.statusCode = ready ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ready, capacity: {
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
    if (url === '/v1/session' && req.method === 'DELETE') {
      state.resets.push(body.userId);
      state.events.push(`reset:${body.userId}`);
      if (state.resetBehavior) return state.resetBehavior(req, res, body);
      state.sessions = 0;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, reset: true }));
      return;
    }
    if (url === '/v1/exec') {
      state.exec.push(body);
      state.events.push(`exec:${body.userId}`);
      if (state.execBehavior) return state.execBehavior(req, res, body, state);
      state.sessions = 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' }));
      return;
    }
    if (url === '/v1/exec/stream') {
      state.exec.push(body);
      state.events.push(`exec:${body.userId}`);
      if (state.streamBehavior) return state.streamBehavior(req, res, body, state);
      state.sessions = 1;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const result = { type: 'result', stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' };
      res.end(`${JSON.stringify(result)}\n`);
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
      stubs.push(stub);
      resolve(stub);
    });
  });
}
createStub.all = [];

function loadPool() {
  const modulePath = require.resolve('../src/terminal-pool');
  delete require.cache[modulePath];
  return require('../src/terminal-pool');
}

let pool;

function configure(...nodes) {
  const explicit = nodes.filter(node => !node.legacy);
  if (explicit.length) {
    process.env.QFLI_TERMINAL_NODES = JSON.stringify(explicit.map(node => ({
      id: node.id, url: node.url, secret: SECRET, ...(node.draining ? { draining: true } : {}),
    })));
  } else {
    delete process.env.QFLI_TERMINAL_NODES;
  }
  const legacy = nodes.find(node => node.legacy);
  if (legacy) {
    process.env.QFLI_TERMINAL_URL = legacy.url;
    process.env.QFLI_TERMINAL_SECRET = SECRET;
  } else {
    delete process.env.QFLI_TERMINAL_URL;
    delete process.env.QFLI_TERMINAL_SECRET;
  }
}

async function slot(nodeId) {
  return db.prepare('SELECT * FROM terminal_slots WHERE node_id = ?').get(nodeId);
}

async function expireSlot(nodeId, { idle = true, session = true } = {}) {
  const past = Date.now() - 60 * 60 * 1000;
  await db.prepare(`UPDATE terminal_slots SET idle_deadline = ?, session_deadline = ?
    WHERE node_id = ?`)
    .run(idle ? past : null, session ? past : null, nodeId);
}

async function expireOperation(nodeId) {
  await db.prepare('UPDATE terminal_slots SET operation_deadline = ? WHERE node_id = ?')
    .run(Date.now() - 1000, nodeId);
}

async function run(poolInstance, id, command = 'echo hi') {
  const req = fakeRequest(id);
  const res = fakeResponse();
  const result = await poolInstance.execute(command, req, res);
  return { result, req, res };
}

test.before(async () => { await db.ready; });

test.after(async () => {
  await Promise.all(createStub.all.map(stub => stub.close()));
});

test.beforeEach(async () => {
  await db.prepare('DELETE FROM terminal_slots').run();
  pool = loadPool();
  pool._resetState();
  delete process.env.QFLI_TERMINAL_NODES;
  delete process.env.QFLI_TERMINAL_URL;
  delete process.env.QFLI_TERMINAL_SECRET;
});

test('users are spread across free nodes, sticky afterwards, then rejected', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const userA = userId(1);
  const userB = userId(2);
  const userC = userId(3);

  await run(pool, userA);
  await run(pool, userB);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 1);
  assert.equal((await slot('alpha')).user_id, userA);
  assert.equal((await slot('beta')).user_id, userB);

  // 同一用户的后续命令复用原节点。
  await run(pool, userA, 'echo again');
  assert.equal(alpha.exec.length, 2);
  assert.equal(beta.exec.length, 1);
  assert.equal(alpha.resets.length, 0);

  await assert.rejects(run(pool, userC), error => {
    assert.equal(error.status, 429);
    assert.match(error.message, /会话已满/);
    return true;
  });
  await alpha.close();
  await beta.close();
});

test('separate pool instances reject a second in-flight request for one user', async () => {
  const alpha = await createStub('alpha');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.execBehavior = async (_req, res) => { await gate; res.end(JSON.stringify(
    { stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' })); };
  configure({ id: 'alpha', url: alpha.url });
  const other = loadPool();
  other._resetState();
  const user = userId(4);

  const first = run(pool, user, 'long build');
  while (alpha.exec.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(run(other, user), error => error.status === 409);
  release();
  await first;
  assert.equal(alpha.exec.length, 1);
  await alpha.close();
});

test('unhealthy and draining nodes are excluded from new placement', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  beta.ready = false;
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  await run(pool, userId(5));
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 0);
  await assert.rejects(run(pool, userId(6)), error => error.status === 429);

  beta.ready = true;
  pool._resetState();
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url, draining: true });
  await assert.rejects(run(pool, userId(7)), error => error.status === 429);
  assert.equal(beta.exec.length, 0);
  await alpha.close();
  await beta.close();
});

test('reset is token fenced and idempotent; stale completions cannot free a new operation', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(8);
  const placement = await pool._place(user);
  assert.equal(placement.node.id, 'alpha');

  const req = fakeRequest(user);
  const res = fakeResponse();
  assert.deepEqual(await pool.reset(req, res), { ok: true });
  assert.deepEqual(alpha.resets, [user]);
  assert.equal((await slot('alpha')).phase, 'free');
  // 没有绑定时重复回收仍幂等成功。
  assert.deepEqual(await pool.reset(fakeRequest(user), fakeResponse()), { ok: true });

  // 迟到的旧结果不能释放新操作。
  assert.equal(await pool._finalize(placement, 'idle'), false);
  const next = await pool._place(user);
  assert.equal(await pool._finalize(placement, 'release'), false);
  const row = await slot('alpha');
  assert.equal(row.phase, 'reserved');
  assert.equal(row.operation_token, next.token);
  assert.equal(await pool._finalize(next, 'release'), true);
  assert.equal((await slot('alpha')).phase, 'free');
  await alpha.close();
});

test('assignment survives a business restart through the shared database', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(9);
  await run(pool, user);
  const restarted = loadPool();
  restarted._resetState();
  const placement = await restarted._place(user);
  assert.equal(placement.node.id, 'alpha');
  assert.equal(placement.reused, true);
  assert.equal(alpha.resets.length, 0);
  await alpha.close();
});

test('ambiguous transport failure quarantines the node and never retries the command', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  alpha.execBehavior = (_req, res) => { res.destroy(); };
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const user = userId(10);
  await assert.rejects(run(pool, user), error => error.status === 503);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 0);
  const row = await slot('alpha');
  assert.equal(row.phase, 'quarantine');
  assert.equal(row.user_id, user);

  // 隔离期内本人得到可恢复错误，任务不会悄悄重放。
  await assert.rejects(run(pool, user), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /待恢复/);
    return true;
  });
  assert.equal(alpha.exec.length, 1);

  // 其他节点继续服务无关用户，命令不会重放到另一台机器。
  await run(pool, userId(11));
  assert.equal(beta.exec.length, 1);
  assert.equal(alpha.exec.length, 1);
  await alpha.close();
  await beta.close();
});

test('truncated stream quarantines the assignment without replay', async () => {
  const alpha = await createStub('alpha');
  alpha.streamBehavior = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ type: 'progress', stage: 'running' })}\n`);
    res.destroy();
  };
  configure({ id: 'alpha', url: alpha.url });
  const req = fakeRequest(userId(12));
  const res = fakeResponse();
  assert.equal(await pool.executeStream({ command: 'build' }, req, res), null);
  assert.equal(alpha.exec.length, 1);
  const events = res.chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.equal((await slot('alpha')).phase, 'quarantine');
  await alpha.close();
});

test('expired idle affinity is reclaimed only after a confirmed delete', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const userA = userId(13);
  const userB = userId(14);
  await run(pool, userA);
  await expireSlot('alpha');

  await run(pool, userB);
  assert.deepEqual(alpha.resets, [userA]);
  assert.equal(alpha.events[0], `exec:${userA}`);
  assert.equal(alpha.events[1], `reset:${userA}`);
  assert.equal(alpha.events[2], `exec:${userB}`);
  const row = await slot('alpha');
  assert.equal(row.user_id, userB);
  assert.equal(row.phase, 'idle');
  await alpha.close();
});

test('failed reclaim keeps the old assignment quarantined and uses other nodes', async () => {
  const alpha = await createStub('alpha');
  alpha.resetBehavior = (_req, res) => { res.statusCode = 500; res.end('{"error":"boom"}'); };
  configure({ id: 'alpha', url: alpha.url });
  const userA = userId(15);
  const userB = userId(16);
  await run(pool, userA);
  await expireSlot('alpha');

  await assert.rejects(run(pool, userB), error => error.status === 503);
  assert.deepEqual(alpha.resets, [userA]);
  const row = await slot('alpha');
  assert.equal(row.phase, 'quarantine');
  assert.equal(row.user_id, userA);

  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  pool._resetState();
  await run(pool, userB);
  assert.equal(beta.exec.length, 1);
  assert.equal(alpha.exec.length, 1);
  await alpha.close();
  await beta.close();
});

test('executor refusal before admission releases the reservation', async () => {
  const alpha = await createStub('alpha');
  alpha.execBehavior = (_req, res) => {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: 'queue_full' }));
  };
  configure({ id: 'alpha', url: alpha.url });
  await assert.rejects(run(pool, userId(17)), error => error.status === 429);
  const row = await slot('alpha');
  assert.equal(row.phase, 'free');
  assert.equal(row.user_id, null);

  // 释放后其他用户可以直接复用。
  alpha.execBehavior = null;
  await run(pool, userId(18));
  assert.equal(alpha.exec.length, 2);
  await alpha.close();
});

test('a removed node keeps its reservation and returns a recoverable error', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(19);
  await run(pool, user);

  configure({ id: 'beta', url: beta.url });
  pool._resetState();
  await assert.rejects(run(pool, user), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /移除/);
    return true;
  });
  assert.equal((await slot('alpha')).user_id, user);
  assert.equal((await slot('alpha')).phase, 'idle');

  await assert.rejects(pool.reset(fakeRequest(user), fakeResponse()), error => error.status === 503);
  assert.equal((await slot('alpha')).phase, 'quarantine');
  assert.equal((await slot('alpha')).user_id, user);
  await alpha.close();
  await beta.close();
});

test('a request during reset conflicts instead of starting a second session', async () => {
  const alpha = await createStub('alpha');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.resetBehavior = async (_req, res) => {
    await gate;
    res.end(JSON.stringify({ ok: true, reset: true }));
  };
  configure({ id: 'alpha', url: alpha.url });
  const user = userId(22);
  await run(pool, user);

  const pending = pool.reset(fakeRequest(user), fakeResponse());
  while (alpha.resets.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(run(pool, user), error => error.status === 409);
  release();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(alpha.exec.length, 1);
  await alpha.close();
});

test('a draining node cleans expired slots without admitting a new session', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const userA = userId(23);
  await run(pool, userA);

  configure({ id: 'alpha', url: alpha.url, draining: true });
  pool._resetState();
  await expireSlot('alpha');
  await assert.rejects(run(pool, userId(24)), error => error.status === 503);
  assert.deepEqual(alpha.resets, [userA]);
  assert.equal(alpha.exec.length, 1);
  const row = await slot('alpha');
  assert.equal(row.phase, 'free');
  assert.equal(row.user_id, null);
  await alpha.close();
});

test('a quarantined user is pinned to the old node until it confirms reset', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  let failNext = true;
  alpha.execBehavior = (req, res, state) => {
    if (failNext) {
      failNext = false;
      res.destroy();
      return;
    }
    state.sessions = 1;
    res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, cwd: '/workspace' }));
  };
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const user = userId(25);
  await assert.rejects(run(pool, user), error => error.status === 503);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 0);
  assert.equal((await slot('alpha')).phase, 'quarantine');

  // 立即重试仍是旧状态：闲置的 beta 不得接管该用户。
  await assert.rejects(run(pool, user), error => error.status === 503);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 0);

  // deadline 过期只触发恢复。恢复失败也不能改派 beta。
  await expireOperation('alpha');
  alpha.resetBehavior = (_req, res) => { res.statusCode = 500; res.end('{"error":"boom"}'); };
  await assert.rejects(run(pool, user), error => error.status === 503);
  assert.deepEqual(alpha.resets, [user]);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 0);
  assert.equal((await slot('alpha')).phase, 'quarantine');

  // 恢复进行中：同用户只能冲突等待，不能去 beta。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.resetBehavior = async (_req, res) => {
    await gate;
    res.end(JSON.stringify({ ok: true, reset: true }));
  };
  await expireOperation('alpha');
  const recovering = run(pool, user);
  while (alpha.resets.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(run(pool, user), error => error.status === 409);
  assert.equal(beta.exec.length, 0);
  release();
  const { result } = await recovering;
  assert.equal(result.exitCode, 0);
  assert.equal(alpha.resets.length, 2);
  assert.equal(alpha.exec.length, 2);
  assert.equal(beta.exec.length, 0);
  assert.equal((await slot('alpha')).user_id, user);

  // 恢复后继续复用原节点。
  await run(pool, user);
  assert.equal(alpha.exec.length, 3);
  assert.equal(beta.exec.length, 0);
  await alpha.close();
  await beta.close();
});

for (const [status, code, expectedPhase] of [
  [413, 'payload_too_large', 'quarantine'],
  [429, 'unknown_limit', 'quarantine'],
  [500, 'command_timeout', 'quarantine'],
  [409, 'user_command_busy', 'quarantine'],
  [410, 'session_expired', 'free'],
  [503, 'terminal_unavailable', 'free'],
  [401, null, 'free'],
]) {
  test(`executor ${status} ${code || 'unauthorized'} settles as ${expectedPhase}`, async () => {
    const node = await createStub('node');
    node.execBehavior = (_req, res) => {
      res.statusCode = status;
      res.end(JSON.stringify(code ? { error: code } : {}));
    };
    configure({ id: 'node', url: node.url });
    const user = userId(26);
    await assert.rejects(run(pool, user));
    const row = await slot('node');
    assert.equal(row.phase, expectedPhase);
    assert.equal(row.user_id, expectedPhase === 'free' ? null : user);
    await node.close();
  });
}

test('a delayed reclaim cannot bind one user to two nodes', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const oldA = userId(30);
  const oldB = userId(31);
  const fresh = userId(32);
  await run(pool, oldA);
  await run(pool, oldB);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 1);
  await expireSlot('alpha');
  await expireSlot('beta');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gatedReset = async (_req, res) => {
    await gate;
    res.end(JSON.stringify({ ok: true, reset: true }));
  };
  alpha.resetBehavior = gatedReset;
  beta.resetBehavior = gatedReset;

  const other = loadPool();
  other._resetState();
  const pending = pool._place(fresh);
  while (alpha.resets.length + beta.resets.length < 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  // 第二个网关必须看到新用户的回收预留并拒绝，不得同时回收另一台。
  await assert.rejects(other._place(fresh), error => error.status === 409);
  release();
  const placement = await pending;
  const resetNode = alpha.resets.length ? alpha : beta;
  const idleNode = resetNode === alpha ? beta : alpha;
  assert.equal(placement.node.id, resetNode.id);
  assert.equal(idleNode.resets.length, 0);

  const bound = await db.prepare('SELECT * FROM terminal_slots WHERE user_id = ?').all(fresh);
  assert.equal(bound.length, 1);
  const otherRow = await slot(idleNode.id);
  assert.notEqual(otherRow.user_id, fresh);

  await pool._finalize(placement, 'idle');
  await run(pool, fresh);
  assert.equal(resetNode.exec.length, 2);
  assert.equal(idleNode.exec.length, 1);
  await alpha.close();
  await beta.close();
});

test('completeReclaim atomically refuses a second node for one user', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  await run(pool, userId(33));
  await run(pool, userId(34));
  const fresh = userId(35);

  // 人为构造旧版本可能留下的双重回收状态。
  const tokenA = 'a'.repeat(48);
  const tokenB = 'b'.repeat(48);
  const deadline = Date.now() + 60000;
  for (const [nodeId, token] of [['alpha', tokenA], ['beta', tokenB]]) {
    await db.prepare(`UPDATE terminal_slots SET phase = 'reclaiming', operation_token = ?,
      operation_deadline = ?, reclaim_user_id = ? WHERE node_id = ?`)
      .run(token, deadline, fresh, nodeId);
  }
  const first = await pool._completeReclaim('alpha', tokenA, fresh);
  const second = await pool._completeReclaim('beta', tokenB, fresh);
  assert.equal([first, second].filter(Boolean).length, 1);
  const bound = await db.prepare('SELECT * FROM terminal_slots WHERE user_id = ?').all(fresh);
  assert.equal(bound.length, 1);
  const released = first ? 'beta' : 'alpha';
  const freed = await slot(released);
  assert.equal(freed.phase, 'free');
  assert.equal(freed.user_id, null);
  assert.equal(freed.reclaim_user_id, '');
  await alpha.close();
  await beta.close();
});

async function waitFor(check, label, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`等待超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('reset cancels a pending reclaim and the stale completion cannot dispatch', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const oldA = userId(36);
  const oldB = userId(40);
  const fresh = userId(37);
  await run(pool, oldA);
  await run(pool, oldB);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 1);
  // 占满 beta，否则新用户会直接使用空闲节点，不触发回收。
  await expireSlot('alpha');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.resetBehavior = async (_req, res) => {
    await gate;
    res.end(JSON.stringify({ ok: true, reset: true }));
  };

  const pending = pool.execute('must not run', fakeRequest(fresh), fakeResponse());
  const seen = () => alpha.resets.length >= 1 && beta.resets.length === 0;
  await waitFor(seen, '等待 alpha 回收 DELETE');
  assert.equal((await slot('alpha')).phase, 'reclaiming');

  // 等待期间 reset 必须取消请求者预留，并保留旧用户清理债。
  assert.deepEqual(await pool.reset(fakeRequest(fresh), fakeResponse()), { ok: true });
  const cancelled = await slot('alpha');
  assert.equal(cancelled.phase, 'quarantine');
  assert.equal(cancelled.user_id, oldA);
  assert.equal(cancelled.reclaim_user_id, '');

  release();
  await assert.rejects(pending, error => error.status === 409);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 1);

  // 取消后新请求可在另一节点执行，且不会回到 alpha。
  await expireSlot('beta');
  await run(pool, fresh);
  assert.equal(beta.exec.length, 2);
  assert.equal(beta.exec.at(-1).userId, fresh);
  assert.equal(alpha.exec.length, 1);
});

test('a disconnect while waiting for reclaim cleanup never dispatches the command', async () => {
  const alpha = await createStub('alpha');
  configure({ id: 'alpha', url: alpha.url });
  const oldA = userId(38);
  const fresh = userId(39);
  await run(pool, oldA);
  await expireSlot('alpha');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.resetBehavior = async (_req, res) => {
    await gate;
    res.end(JSON.stringify({ ok: true, reset: true }));
  };

  const req = fakeRequest(fresh);
  const pending = pool.execute('must not run', req, fakeResponse());
  await waitFor(() => alpha.resets.length >= 1, '等待 alpha 回收 DELETE');
  req.aborted = true;
  release();
  await assert.rejects(pending, error => error.status === 499);
  assert.equal(alpha.exec.length, 1);
  const row = await slot('alpha');
  assert.equal(row.phase, 'free');
  assert.equal(row.user_id, null);
});

test('a cancelled reclaim whose DELETE fails must not retry on another node', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const oldA = userId(41);
  const oldB = userId(42);
  const fresh = userId(43);
  await run(pool, oldA);
  await run(pool, oldB);
  await expireSlot('alpha');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  alpha.resetBehavior = async (_req, res) => {
    await gate;
    res.statusCode = 500;
    res.end('{}');
  };

  const pending = pool.execute('must not run', fakeRequest(fresh), fakeResponse());
  await waitFor(() => alpha.resets.length >= 1, '等待 alpha 回收 DELETE');
  assert.deepEqual(await pool.reset(fakeRequest(fresh), fakeResponse()), { ok: true });
  release();
  await assert.rejects(pending, error => error.status === 409);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 1);
  const row = await slot('alpha');
  assert.equal(row.phase, 'quarantine');
  assert.equal(row.user_id, oldA);
  assert.equal(row.reclaim_user_id, '');

  // 取消后新请求仍能使用另一节点，alpha 保持旧用户清理债。
  await expireSlot('beta');
  await run(pool, fresh);
  assert.equal(beta.exec.length, 2);
  assert.equal(alpha.exec.length, 1);
});

test('a failed reclaim without cancellation quarantines the node and continues elsewhere', async () => {
  const alpha = await createStub('alpha');
  const beta = await createStub('beta');
  configure({ id: 'alpha', url: alpha.url }, { id: 'beta', url: beta.url });
  const oldA = userId(44);
  const oldB = userId(45);
  const fresh = userId(46);
  await run(pool, oldA);
  await run(pool, oldB);
  await expireSlot('alpha');
  await expireSlot('beta');
  alpha.resetBehavior = async (_req, res) => {
    res.statusCode = 500;
    res.end('{}');
  };

  await run(pool, fresh);
  assert.equal(alpha.exec.length, 1);
  assert.equal(beta.exec.length, 2);
  assert.equal(beta.exec.at(-1).userId, fresh);
  const alphaRow = await slot('alpha');
  assert.equal(alphaRow.phase, 'quarantine');
  assert.equal(alphaRow.user_id, oldA);
  const betaRow = await slot('beta');
  assert.equal(betaRow.phase, 'idle');
  assert.equal(betaRow.user_id, fresh);
});

test('missing configuration fails closed', async () => {
  assert.throws(() => pool.configuration(), error => error instanceof ApiError && error.status === 503);
  await assert.rejects(run(pool, userId(20)), error => error.status === 503);
});

test('legacy single-node variables keep working', async () => {
  const legacy = await createStub('legacy');
  configure({ url: legacy.url, legacy: true });
  await run(pool, userId(21));
  assert.equal(legacy.exec.length, 1);
  const rows = await db.prepare('SELECT * FROM terminal_slots WHERE user_id = ?').all(userId(21));
  assert.equal(rows.length, 1);
  assert.match(rows[0].node_id, /^legacy-[0-9a-f]{12}$/);
  await legacy.close();
});
