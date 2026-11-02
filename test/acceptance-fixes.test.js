// 验收失败项的回归测试（2026-11 服务端验收 5 项）。
// 全部经过真实路由挂载：真实 Express + 真实 SQLite + 真实 audit 写入，
// 只把网关 HTTP 换成替身，因为验收环境里的网关是外部服务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-acceptance-fix-'));
process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = DATA_DIR;
process.env.AZK_OAUTH2_BASE_URL = 'https://gateway.example.test';
process.env.AZK_OAUTH2_CLIENT_ID = 'qfli-client';
process.env.AZK_OAUTH2_CLIENT_SECRET = 'test-client-secret';
process.env.PUBLIC_BASE_URL = 'https://app.example.test';

const db = require('../src/db');

const ENROLLED = `user_${'c'.repeat(32)}`;
const ENROLLED_GATEWAY_SUB = 'gateway-sub-enrolled';

// 假认证：只解析用户身份，其余（路由、审计、限流、注销）全走真实实现。
const accounts = new Map([[ENROLLED, { is_admin: false, gatewaySub: ENROLLED_GATEWAY_SUB }]]);

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authOptional(req, _res, next) {
      const id = bearer(req);
      req.userId = accounts.has(id) ? id : null;
      if (req.userId) req.user = { id: req.userId, is_admin: accounts.get(req.userId).is_admin };
      next();
    },
    authRequired(req, res, next) {
      const id = bearer(req);
      if (!accounts.has(id)) return res.status(401).json({ error: '未登录' });
      req.userId = id;
      req.user = { id, username: id, is_admin: accounts.get(id).is_admin };
      req.authSession = { id: 'session-1', user_id: id, gateway_user_id: accounts.get(id).gatewaySub };
      req.gatewayClaims = { sub: accounts.get(id).gatewaySub, preferred_username: id };
      next();
    },
    publicUser: async () => ({}),
  },
};

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

const express = require('express');
const authRoutes = require('../src/routes/auth');
const userRoutes = require('../src/routes/users');
const { ApiError } = require('../src/gateway');

for (const router of [authRoutes, userRoutes]) {
  for (const layer of router.stack) {
    for (const handler of layer.route ? layer.route.stack : [layer]) {
      const original = handler.handle;
      if (original.length === 4) continue;
      handler.handle = (req, res, next) => {
        try { Promise.resolve(original(req, res, next)).catch(next); } catch (error) { next(error); }
      };
    }
  }
}

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ApiError ? error.status : 500;
  if (error instanceof ApiError) {
    return res.status(status).json({ error: error.message, ...error.details });
  }
  res.status(status).json({ error: '服务器内部错误', message: error.message });
});

let server;

test.before(async () => {
  await db.ready;
  await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)')
    .run(ENROLLED, ENROLLED_GATEWAY_SUB);
  await db.prepare('INSERT OR IGNORE INTO user_state (user_id) VALUES (?)').run(ENROLLED);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});

test.after(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
});

test.beforeEach(async () => {
  await db.prepare('DELETE FROM audit_logs').run();
});

async function api(method, route, { user, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: {
        ...(user ? { authorization: `Bearer ${user}` } : {}),
        ...(payload === undefined ? {} : {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        }),
        'x-real-ip': '198.51.100.17',
        'x-real-port': '45678',
        'x-client-platform': 'harmonyos-app/acceptance',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// 验收第 1 条：注册审计必须带用户ID。首次注册时本地还没有 users 行，代码要自己建映射。
test('register creates the local user mapping and audits the new user id', async () => {
  const newSub = 'gateway-sub-first-time';
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlPath = new URL(String(url)).pathname;
    if (urlPath === '/oauth2/register') {
      return Response.json({ redirect: 'https://app.example.test/login?done=1' });
    }
    if (urlPath.startsWith('/oauth2/public-profile/')) {
      return Response.json({ sub: newSub, preferred_username: 'acceptance_first' });
    }
    throw new Error(`unexpected gateway call ${urlPath}`);
  };
  try {
    // 关键：本地没有该 sub 的 users 行，模拟真实首次注册。
    assert.equal(await db.prepare('SELECT 1 FROM users WHERE gateway_user_id = ?').get(newSub), undefined);
    const reply = await api('POST', '/api/auth/register', {
      body: { username: 'acceptance_first', email: 'first@example.test', password: 'Passw0rd!', emailCode: '123456' },
    });
    assert.equal(reply.status, 200);

    const row = await db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.register'").get();
    assert.ok(row, '注册必须写审计');
    assert.ok(row.user_id, '首次注册也必须带用户ID，不能是 null');
    assert.match(row.user_id, /^user_[0-9a-f]{32}$/);

    // 审计里的用户ID必须能在本地 users 表找到，并与网关 sub 对应。
    const local = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    assert.ok(local, '注册审计的 user_id 必须是本地真实用户');
    assert.equal(local.gateway_user_id, newSub);
    assert.equal(row.username, 'acceptance_first');
    assert.equal(row.login_type, 'register');
    assert.equal(row.port, 45678);
    assert.equal(row.platform, 'harmonyos-app');
  } finally {
    global.fetch = originalFetch;
  }
});

test('register reuses an existing local user instead of creating a duplicate', async () => {
  const existingSub = 'gateway-sub-existing';
  const existingId = `user_${'9'.repeat(32)}`;
  await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(existingId, existingSub);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlPath = new URL(String(url)).pathname;
    if (urlPath === '/oauth2/register') return Response.json({ redirect: 'https://app.example.test/login' });
    if (urlPath.startsWith('/oauth2/public-profile/')) return Response.json({ sub: existingSub });
    throw new Error(`unexpected gateway call ${urlPath}`);
  };
  try {
    const reply = await api('POST', '/api/auth/register', {
      body: { username: 'acceptance_existing', email: 'e@example.test', password: 'Passw0rd!', emailCode: '123456' },
    });
    assert.equal(reply.status, 200);
    const row = await db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.register'").get();
    assert.equal(row.user_id, existingId);
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE gateway_user_id = ?').get(existingSub)).n;
    assert.equal(count, 1, '不能重复建用户');
  } finally {
    global.fetch = originalFetch;
  }
});

test('register keeps user_id null when the gateway cannot resolve the account', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlPath = new URL(String(url)).pathname;
    if (urlPath === '/oauth2/register') return Response.json({ redirect: 'https://app.example.test/login' });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  try {
    const reply = await api('POST', '/api/auth/register', {
      body: { username: 'acceptance_unknown', email: 'u@example.test', password: 'Passw0rd!', emailCode: '123456' },
    });
    assert.equal(reply.status, 200);
    const row = await db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.register'").get();
    assert.equal(row.user_id, null, '解析不到时不假造 ID');
    assert.equal(row.username, 'acceptance_unknown');
  } finally {
    global.fetch = originalFetch;
  }
});

// 验收第 7 条：注销后审计以该用户为目标的记录也必须去标识化。
test('deactivation deidentifies audit rows where the user is the target', async () => {
  const target = `user_${'e'.repeat(32)}`;
  const adminId = `user_${'f'.repeat(32)}`;
  await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(target, 'gateway-sub-target');
  accounts.set(target, { is_admin: false, gatewaySub: 'gateway-sub-target' });
  await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(target);
  await db.prepare(`INSERT INTO auth_sessions (id, user_id, credentials, access_expires_at, expires_at)
    VALUES ('session-target', ?, 'ciphertext', ?, ?)`).run(target, Date.now() + 100000, Date.now() + 1000000);

  // 管理员对该用户的处置审计：user_id 是管理员，target 是目标用户。
  await db.prepare(`INSERT INTO audit_logs (id, user_id, username, action, target, detail, ip, port, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'audit_mute', adminId, 'accept_admin', 'admin.account_mute', `user:${target}`,
    `reason=mute ${target}`, '198.51.100.17', 45678, 'harmonyos-app',
  );
  await db.prepare(`INSERT INTO audit_logs (id, user_id, username, action, target, detail, ip, port, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'audit_unmute', adminId, 'accept_admin', 'admin.account_unmute', `user:${target}`,
    'reason=unmute', '198.51.100.17', 45678, 'harmonyos-app',
  );
  // 只在 detail 里提到目标用户的跨操作者记录：管理员删帖时把作者写在 detail。
  // 这条行 user_id 是管理员，target 是帖子编号，只有 detail 含原用户ID。
  await db.prepare(`INSERT INTO audit_logs (id, user_id, username, action, target, detail, ip, port, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'audit_post_delete', adminId, 'accept_admin', 'admin.post_delete', 'post:post_abc',
    `author=${target} reason=违规`, '198.51.100.17', 45678, 'harmonyos-app',
  );

  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ status: 'deleted', tokens_revoked: true });
  try {
    // 走真实路由：POST /api/users/me/deactivate。
    const reply = await api('POST', '/api/users/me/deactivate', {
      user: target, body: { confirm: 'DEACTIVATE' },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'deactivated');
  } finally {
    global.fetch = originalFetch;
  }

  const rows = await db.prepare('SELECT * FROM audit_logs ORDER BY id').all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(!String(row.target).includes(target), `target 仍含原用户ID：${row.target}`);
    assert.ok(!String(row.detail).includes(target), `detail 仍含原用户ID：${row.detail}`);
    // 管理员自己的身份保留。
    assert.equal(row.user_id, adminId);
    assert.equal(row.username, 'accept_admin');
  }
  // 目标不同的两行去标识化结果一致，仍可归并核对。
  const mute = rows.find((row) => row.id === 'audit_mute');
  const unmute = rows.find((row) => row.id === 'audit_unmute');
  assert.equal(mute.target, unmute.target);
  assert.match(mute.target, /^user:deleted_[0-9a-f]{32}$/);
  // 只在 detail 里提到目标的记录：target 不受影响，detail 已清洗。
  const deleted = rows.find((row) => row.id === 'audit_post_delete');
  assert.equal(deleted.target, 'post:post_abc');
  assert.match(deleted.detail, /^author=deleted_[0-9a-f]{32} reason=违规$/);
});

// 验收第 7 条：网关注销失败时必须留一条失败审计。
test('a rejected gateway erase keeps local data and writes a failure audit', async () => {
  const victim = `user_${'1'.repeat(32)}`;
  await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(victim, 'gateway-sub-victim');
  accounts.set(victim, { is_admin: false, gatewaySub: 'gateway-sub-victim' });
  await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(victim);
  await db.prepare(`INSERT INTO auth_sessions (id, user_id, credentials, access_expires_at, expires_at)
    VALUES ('session-victim', ?, 'ciphertext', ?, ?)`).run(victim, Date.now() + 100000, Date.now() + 1000000);

  const before = (await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).n;
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json(
    { error: 'insufficient_scope', error_description: 'missing qfli_account_erase' },
    { status: 403 },
  );
  try {
    const reply = await api('POST', '/api/users/me/deactivate', {
      user: victim, body: { confirm: 'DEACTIVATE' },
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.json.errorKey, 'gateway.insufficient_scope');
  } finally {
    global.fetch = originalFetch;
  }

  const after = (await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).n;
  assert.equal(after, before + 1, '失败也必须写一条审计');
  const row = await db.prepare("SELECT * FROM audit_logs WHERE action = 'user.deactivate_failed'").get();
  assert.ok(row);
  assert.equal(row.user_id, victim);
  assert.equal(row.target, `user:${victim}`);
  assert.match(row.detail, /status=403/);
  assert.match(row.detail, /errorKey=gateway.insufficient_scope/);

  // 本地数据与会话按设计保留。
  assert.ok(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(victim));
  assert.ok(await db.prepare('SELECT 1 FROM auth_sessions WHERE user_id = ?').get(victim));

  // 用户重试成功后，失败审计同样被去标识化。
  global.fetch = async () => Response.json({ status: 'deleted', tokens_revoked: true });
  try {
    const retry = await api('POST', '/api/users/me/deactivate', {
      user: victim, body: { confirm: 'DEACTIVATE' },
    });
    assert.equal(retry.status, 200);
  } finally {
    global.fetch = originalFetch;
  }
  const scrubbed = await db.prepare("SELECT * FROM audit_logs WHERE action = 'user.deactivate_failed'").get();
  assert.ok(!String(scrubbed.target).includes(victim));
  assert.ok(!String(scrubbed.detail).includes(victim));
  assert.match(scrubbed.user_id, /^deleted_[0-9a-f]{32}$/);
});

test('deactivation refuses to proceed without the confirm phrase and audits nothing', async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).n;
  const reply = await api('POST', '/api/users/me/deactivate', {
    user: ENROLLED, body: { confirm: 'nope' },
  });
  assert.equal(reply.status, 400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).n, before);
});
