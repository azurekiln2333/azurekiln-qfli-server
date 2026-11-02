// 审计落库：字段完整性、306/365 天保留口径，以及华为未绑定手机号时拒绝跳过/绑定。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-audit-log-'));

const db = require('../src/db');
const { audit, RETENTION_DAYS } = require('../src/audit');

// 测试结束后显式关库，避免 sqlite 句柄让进程不退出。
process.on('beforeExit', () => { try { db.close(); } catch (_) {} });
const retention = require('../src/audit-retention');

function request(overrides = {}) {
  return {
    headers: {
      'x-real-ip': '203.0.113.44',
      'x-real-port': '52000',
      'x-client-platform': 'harmonyos-app/2.1.0',
      'user-agent': 'QFLIStudio/2.1.0',
    },
    socket: { remoteAddress: '127.0.0.1', remotePort: 4000 },
    requestPath: '/api/auth/login',
    userId: null,
    user: null,
    ...overrides,
  };
}

test('the retention period is 365 days everywhere', async () => {
  assert.equal(RETENTION_DAYS, 365);
  assert.equal(retention.RETENTION_DAYS, 365);
  // db.js 的清理语句必须引用同一常量，不能再写死 90。
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  assert.ok(!/'-90 days'/.test(source), 'no hard-coded 90-day purge may remain');
  assert.ok(!/INTERVAL 90 DAY/.test(source), 'no hard-coded 90-day MySQL purge may remain');
  assert.ok(/\$\{RETENTION_DAYS\}/.test(source), 'purges read the shared constant');
});

test('login rows carry IP, port, platform and login type', async () => {
  await db.ready;
  const userId = `user_${'9'.repeat(32)}`;
  await audit(request(), {
    userId, username: 'alice', action: 'auth.password_login', loginType: 'password',
  });
  const row = await db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'auth.password_login' AND user_id = ?",
  ).get(userId);
  assert.equal(row.ip, '203.0.113.44');
  assert.equal(row.port, 52000);
  assert.equal(row.platform, 'harmonyos-app');
  assert.equal(row.login_type, 'password');
  assert.equal(row.username, 'alice');
  assert.ok(row.created_at);
});

test('register and logout rows are recorded with their login type', async () => {
  await db.ready;
  await audit(request({ requestPath: '/api/auth/register' }), {
    username: 'bob', action: 'auth.register', loginType: 'register',
  });
  const userId = `user_${'8'.repeat(32)}`;
  await audit(request({ requestPath: '/api/auth/logout', userId, user: { id: userId, username: 'bob' } }), {
    userId, username: 'bob', action: 'auth.logout', loginType: 'logout',
  });
  const register = await db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'auth.register' ORDER BY created_at DESC LIMIT 1",
  ).get();
  assert.equal(register.username, 'bob');
  assert.equal(register.platform, 'harmonyos-app');
  assert.equal(register.port, 52000);
  const logout = await db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'auth.logout' AND user_id = ?",
  ).get(userId);
  assert.equal(logout.login_type, 'logout');
  assert.equal(logout.ip, '203.0.113.44');
});

test('an unknown client platform is stored as NULL, not as a guess', async () => {
  await db.ready;
  const req = request({ headers: { 'x-real-ip': '203.0.113.44', 'x-client-platform': 'curl/8.0' } });
  await audit(req, { action: 'user.update_profile' });
  const row = await db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'user.update_profile' ORDER BY created_at DESC LIMIT 1",
  ).get();
  assert.equal(row.platform, null);
});

// ---- 华为登录：没有已验证手机号就不允许跳过或绑定 ----

const gateway = require('../src/gateway');
const authRouter = require('../src/routes/auth');

const saved = Object.fromEntries([
  'AZK_OAUTH2_BASE_URL', 'AZK_OAUTH2_CLIENT_ID', 'AZK_OAUTH2_CLIENT_SECRET', 'PUBLIC_BASE_URL',
].map(key => [key, process.env[key]]));

function configure() {
  process.env.AZK_OAUTH2_BASE_URL = 'https://gateway.example.test';
  process.env.AZK_OAUTH2_CLIENT_ID = 'qfli-client';
  process.env.AZK_OAUTH2_CLIENT_SECRET = 'test-client-secret';
  process.env.PUBLIC_BASE_URL = 'https://app.example.test';
}

function restore() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function expressApp() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  // 与 src/server.js 相同的包装：Express 4 不会自动转发路由 async 异常，
  // 否则 rejected promise 会变成 unhandledRejection，测试进程也随之挂住。
  for (const layer of authRouter.stack) {
    for (const handler of layer.route ? layer.route.stack : [layer]) {
      const original = handler.handle;
      if (original.length === 4) continue;
      handler.handle = (req, res, next) => {
        try { Promise.resolve(original(req, res, next)).catch(next); } catch (err) { next(err); }
      };
    }
  }
  app.use('/api/auth', authRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message, ...(err.details || {}) });
  });
  return app;
}

const http = require('node:http');

// 用 node:http 而不是 fetch：测试里 global.fetch 是上游网关替身。
// agent:false + server.closeAllConnections() 防止 keep-alive 连接把进程挂住。
function requestApp(app, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const finish = (result) => {
        server.closeAllConnections?.();
        server.close(() => (result.error ? reject(result.error) : resolve(result.value)));
      };
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: urlPath, method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
          finish({ value: { status: res.statusCode, body: parsed } });
        });
      });
      req.on('error', error => finish({ error }));
      req.end(payload);
    });
  });
}

async function post(app, urlPath, body) {
  return requestApp(app, urlPath, body);
}

test('a Huawei account without a phone cannot skip binding to create an account', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const urlPath = new URL(url).pathname;
    calls.push(urlPath);
    if (urlPath.endsWith('/quick-login')) {
      return Response.json({ binding_required: true, binding_token: 'pending-secret', phone_available: false });
    }
    throw new Error(`unexpected upstream call ${urlPath}`);
  };
  try {
    const app = expressApp();
    const started = await post(app, '/api/auth/huawei', { authorizationCode: 'one-use-code' });
    assert.equal(started.status, 200);
    assert.equal(started.body.bindingRequired, true);
    assert.equal(started.body.phoneAvailable, false);

    const skipped = await post(app, '/api/auth/huawei/skip', { bindingId: started.body.bindingId });
    assert.equal(skipped.status, 403);
    assert.equal(skipped.body.errorKey, 'huawei.phone_required');
    assert.equal(skipped.body.message, '请使用已绑定手机号的华为账号');
    assert.match(skipped.body.error, /已绑定手机号/);

    const bound = await post(app, '/api/auth/huawei/bind', {
      bindingId: started.body.bindingId, username: 'someone', password: 'correct-password',
    });
    assert.equal(bound.status, 400, 'the pending binding is consumed after the first refusal');
    assert.deepEqual(calls, ['/api/v1/auth/oauth/huawei/quick-login'],
      'no skip or bind call may ever reach the gateway');
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('a Huawei account with a phone can still skip binding', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const urlPath = new URL(url).pathname;
    calls.push(urlPath);
    if (urlPath.endsWith('/quick-login')) {
      return Response.json({ binding_required: true, binding_token: 'pending-secret', phone_available: true });
    }
    if (urlPath.endsWith('/skip')) {
      const body = JSON.parse(options.body);
      return Response.json({ redirect: `${body.redirect_uri}?code=gw-code&state=${body.state}` });
    }
    if (urlPath.endsWith('/token')) return Response.json({ access_token: 'a', refresh_token: 'r' });
    if (urlPath.endsWith('/userinfo')) return Response.json({ sub: 'gw-new-user' });
    throw new Error(`unexpected upstream call ${urlPath}`);
  };
  try {
    const app = expressApp();
    const started = await post(app, '/api/auth/huawei', { authorizationCode: 'one-use-code' });
    assert.equal(started.body.phoneAvailable, true);
    const skipped = await post(app, '/api/auth/huawei/skip', { bindingId: started.body.bindingId });
    assert.notEqual(skipped.status, 403, 'a phone-verified account is not blocked');
    assert.ok(calls.includes('/api/v1/auth/oauth/huawei/skip'));
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

module.exports = { gateway };

// ---- 网关 huawei_verified_phone_required 统一转换为 huawei.phone_required ----

for (const [label, urlPath, buildBody] of [
  ['quick login', '/api/auth/huawei', () => ({ authorizationCode: 'one-use-code' })],
  ['skip', '/api/auth/huawei/skip', bindingId => ({ bindingId })],
  ['bind', '/api/auth/huawei/bind', bindingId => ({
    bindingId, username: 'someone', password: 'correct-password',
  })],
]) {
  test(`gateway ${label} refusal becomes huawei.phone_required`, async () => {
    configure();
    const originalFetch = global.fetch;
    let upstream = 0;
    global.fetch = async (url) => {
      upstream += 1;
      const path = new URL(url).pathname;
      // quick-login 先成功签发 binding_token（phone_available 未知），
      // 之后 skip/bind 带着旧 token 才被网关以同一个 403 拒绝。
      if (path.endsWith('/quick-login') && label !== 'quick login') {
        return Response.json({ binding_required: true, binding_token: 'pending-secret' });
      }
      return Response.json(
        { error: 'huawei_verified_phone_required', error_description: 'Huawei account has no verified phone' },
        { status: 403 },
      );
    };
    try {
      const app = expressApp();
      let body;
      if (label === 'quick login') {
        body = buildBody();
      } else {
        const started = await post(app, '/api/auth/huawei', { authorizationCode: 'one-use-code' });
        assert.equal(started.body.bindingRequired, true, 'a binding token must be issued first');
        body = buildBody(started.body.bindingId);
      }
      const response = await post(app, urlPath, body);
      assert.equal(response.status, 403, label);
      assert.equal(response.body.errorKey, 'huawei.phone_required', label);
      assert.equal(response.body.message, '请使用已绑定手机号的华为账号', label);
      assert.ok(upstream >= 1);
    } finally {
      global.fetch = originalFetch;
      restore();
    }
  });
}
