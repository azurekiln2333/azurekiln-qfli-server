// 身份侧公共件：客户端平台解析、可信代理地址、实名判定与实名门槛中间件。
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  clientPlatform, hasVerifiedPhone, gatedPath, realnameRequired, GATED_PREFIXES,
  auditIp, auditPort, requestPath,
} = require('../src/client-context');

function request(headers = {}, socket = {}) {
  return { headers, socket: { remoteAddress: '198.51.100.7', remotePort: 33445, ...socket } };
}

// ---- 客户端平台 ----

test('clientPlatform keeps the name and drops the version', () => {
  assert.equal(clientPlatform(request({ 'x-client-platform': 'harmonyos-app/1.2.0' })), 'harmonyos-app');
  assert.equal(clientPlatform(request({ 'x-client-platform': 'web' })), 'web');
  assert.equal(clientPlatform(request({ 'x-client-platform': 'HARMONYOS-APP/1' })), 'harmonyos-app');
});

test('clientPlatform rejects unknown platforms and junk', () => {
  assert.equal(clientPlatform(request({})), null);
  assert.equal(clientPlatform(request({ 'x-client-platform': 'curl/8.0' })), null);
  assert.equal(clientPlatform(request({ 'x-client-platform': 'x'.repeat(200) })), null);
  assert.equal(clientPlatform(request({ 'x-client-platform': 42 })), null);
});

// ---- 可信代理 ----

test('only X-Real-IP / X-Real-Port written by the proxy are used', () => {
  const req = request({ 'x-real-ip': '203.0.113.20', 'x-real-port': '51000' });
  assert.equal(auditIp(req), '203.0.113.20');
  assert.equal(auditPort(req), 51000);
});

test('X-Forwarded-For is ignored entirely', () => {
  const req = request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, { remoteAddress: '198.51.100.7' });
  assert.equal(auditIp(req), '198.51.100.7', 'the socket address is the only fallback');
});

test('invalid address and port values are dropped, not stored', () => {
  // X-Real-IP 只由 nginx 写入；带端口时剥掉端口，不是 IP 时回落到 socket 地址。
  assert.equal(auditIp(request({ 'x-real-ip': '1.1.1.1:99' })), '1.1.1.1');
  assert.equal(auditIp(request({ 'x-real-ip': '[2001:db8::1]:443' })), '2001:db8::1');
  assert.equal(auditIp(request({ 'x-real-ip': 'not-an-ip' })), '198.51.100.7');
  assert.equal(auditPort(request({ 'x-real-port': '0' })), 33445);
  assert.equal(auditPort(request({ 'x-real-port': '99999' })), 33445);
  assert.equal(auditPort(request({ 'x-real-port': 'abc' })), 33445);
});

test('IPv4-mapped IPv6 addresses are normalized', () => {
  assert.equal(auditIp(request({}, { remoteAddress: '::ffff:203.0.113.9' })), '203.0.113.9');
});

// ---- 实名判定 ----

test('a verified phone makes the account real-name verified', () => {
  assert.equal(hasVerifiedPhone({ phone_number: '+8613800000000' }), true);
  assert.equal(hasVerifiedPhone({ phone_number: '+8613800000000', phone_number_verified: true }), true);
  assert.equal(hasVerifiedPhone({ phone_verified: true }), true);
});

test('a missing or unverified phone does not', () => {
  assert.equal(hasVerifiedPhone({}), false);
  assert.equal(hasVerifiedPhone({ phone_number: '' }), false);
  assert.equal(hasVerifiedPhone({ phone_number: '   ' }), false);
  assert.equal(hasVerifiedPhone({ phone_number: '+8613800000000', phone_number_verified: false }), false);
  assert.equal(hasVerifiedPhone(null), false);
  assert.equal(hasVerifiedPhone(undefined), false);
});

// ---- 受保护前缀 ----

test('community, cloud, terminal, AI and SQL paths are gated', () => {
  for (const path of [
    '/api/posts', '/api/posts/post_1/like', '/api/comments/comment_1',
    '/api/zones', '/api/tags', '/api/reports', '/api/cloud/projects',
    '/api/terminal/exec', '/api/sql/query', '/api/ai/chat',
  ]) {
    assert.equal(gatedPath(path), true, path);
  }
  assert.ok(GATED_PREFIXES.includes('/api/ai'));
});

test('account settings, auth, health and admin are not gated', () => {
  for (const path of [
    '/api/users/me', '/api/users/me/deactivate', '/api/auth/login',
    '/api/health', '/api/audit', '/api/zonesx',
  ]) {
    assert.equal(gatedPath(path), false, path);
  }
});

// ---- 中间件 ----

function startApp() {
  const app = express();
  app.use(express.json());
  // 替身：用请求头模拟已解析会话与网关 claims。
  app.use((req, _res, next) => {
    if (req.get('x-test-user') === undefined) return next();
    req.userId = `user_${'1'.repeat(32)}`;
    req.authSession = { gateway_user_id: 'gw-1' };
    req.gatewayClaims = req.get('x-test-phone')
      ? { phone_number: req.get('x-test-phone'), phone_number_verified: true }
      : {};
    next();
  });
  app.use(realnameRequired);
  app.get('/api/posts', (_req, res) => res.json({ ok: true }));
  app.get('/api/users/me', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 与 src/server.js 完全相同的挂载形状：app.use('/api', realnameRequired, router)。
// Express 会把挂载前缀从 req.path 剥掉，这是曾经绕过实名门槛的根因。
function startMountedApp() {
  const app = express();
  app.use((req, _res, next) => {
    if (req.get('x-test-user') === undefined) return next();
    req.userId = `user_${'1'.repeat(32)}`;
    req.authSession = { gateway_user_id: 'gw-1' };
    req.gatewayClaims = req.get('x-test-phone')
      ? { phone_number: req.get('x-test-phone'), phone_number_verified: true }
      : {};
    next();
  });
  const community = express.Router();
  community.get('/posts', (_req, res) => res.json({ ok: true }));
  community.get('/cloud/projects', (_req, res) => res.json({ ok: true }));
  community.get('/reports', (_req, res) => res.json({ ok: true }));
  community.get('/zones', (_req, res) => res.json({ ok: true }));
  const terminal = express.Router();
  terminal.get('/exec', (_req, res) => res.json({ ok: true }));
  const sql = express.Router();
  sql.get('/query', (_req, res) => res.json({ ok: true }));
  const ai = express.Router();
  ai.get('/chat', (_req, res) => res.json({ ok: true }));
  const users = express.Router();
  users.get('/me', (_req, res) => res.json({ ok: true }));

  app.use('/api', realnameRequired, community);
  app.use('/api/terminal', realnameRequired, terminal);
  app.use('/api/sql', realnameRequired, sql);
  app.use('/api/ai', realnameRequired, ai);
  app.use('/api/users', users);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(server, path, headers = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('realnameRequired blocks a signed-in account without a verified phone', async () => {
  const server = await startApp();
  try {
    const denied = await call(server, '/api/posts', { 'x-test-user': '1' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.errorKey, 'realname.required');
    assert.ok(denied.body.message);
  } finally {
    server.close();
  }
});

test('realnameRequired leaves anonymous requests to authRequired', async () => {
  const server = await startApp();
  try {
    const anonymous = await call(server, '/api/posts');
    assert.equal(anonymous.status, 200, 'the gate must not answer 403 for anonymous callers');
  } finally {
    server.close();
  }
});

test('realnameRequired lets a verified account through', async () => {
  const server = await startApp();
  try {
    const allowed = await call(server, '/api/posts', {
      'x-test-user': '1', 'x-test-phone': '+8613800000000',
    });
    assert.equal(allowed.status, 200);
  } finally {
    server.close();
  }
});

test('realnameRequired does not gate account settings', async () => {
  const server = await startApp();
  try {
    const settings = await call(server, '/api/users/me');
    assert.equal(settings.status, 200, 'an unverified account can still delete itself');
  } finally {
    server.close();
  }
});

// ---- 回归：真实挂载形状不得绕过实名门槛 ----

test('mounted under /api, an unverified session is still blocked', async () => {
  const server = await startMountedApp();
  try {
    for (const path of [
      '/api/posts', '/api/cloud/projects', '/api/reports', '/api/zones',
      '/api/terminal/exec', '/api/sql/query', '/api/ai/chat',
      // query 变形
      '/api/posts?x=1', '/api/cloud/projects?page=2', '/api/terminal/exec?stream=1',
      '/api/sql/query?a=b', '/api/ai/chat?x=1', '/api/reports?targetType=post',
      // 大小写变形（Express 路由默认忽略大小写）
      '/API/POSTS', '/Api/Posts', '/API/CLOUD/PROJECTS', '/API/TERMINAL/EXEC',
      '/API/SQL/QUERY', '/API/AI/CHAT', '/API/REPORTS', '/API/ZONES',
    ]) {
      const denied = await call(server, path, { 'x-test-user': '1' });
      assert.equal(denied.status, 403, `${path} must be blocked`);
      assert.equal(denied.body.errorKey, 'realname.required', path);
    }
  } finally {
    server.close();
  }
});

test('mounted under /api, a verified session reaches the router', async () => {
  const server = await startMountedApp();
  try {
    for (const path of [
      '/api/posts', '/api/cloud/projects', '/api/reports', '/api/zones',
      '/api/terminal/exec', '/api/sql/query', '/api/ai/chat',
      '/api/posts?x=1', '/API/POSTS', '/Api/Cloud/Projects',
    ]) {
      const allowed = await call(server, path, {
        'x-test-user': '1', 'x-test-phone': '+8613800000000',
      });
      assert.equal(allowed.status, 200, `${path} must pass`);
    }
  } finally {
    server.close();
  }
});

test('mounted under /api, /api/users/me stays reachable without a phone', async () => {
  const server = await startMountedApp();
  try {
    const settings = await call(server, '/api/users/me', { 'x-test-user': '1' });
    assert.equal(settings.status, 200, 'deactivation must stay possible before real-name verification');
  } finally {
    server.close();
  }
});

test('requestPath prefers originalUrl over the stripped req.path', () => {
  // Express 在 app.use('/api', mw) 里把 req.url 剥成 '/posts'。
  assert.equal(requestPath({ originalUrl: '/api/posts?x=1', path: '/posts' }), '/api/posts?x=1');
  assert.equal(gatedPath(requestPath({ originalUrl: '/api/posts?x=1', path: '/posts' })), true);
  // 非 Express 场景回落到 req.path。
  assert.equal(requestPath({ path: '/api/posts' }), '/api/posts');
  assert.equal(gatedPath('/api/posts?a=1#b'), true);
  assert.equal(gatedPath('/api/postsx'), false);
  // 大小写不敏感，与 Express 路由行为一致。
  assert.equal(gatedPath('/API/POSTS'), true);
  assert.equal(gatedPath('/Api/Cloud/Projects?page=2'), true);
  assert.equal(gatedPath('/API/TERMINAL/EXEC'), true);
  // 非受限路径仍不拦截。
  assert.equal(gatedPath('/API/USERS/ME'), false);
  assert.equal(gatedPath('/API/AUTH/LOGIN'), false);
});
