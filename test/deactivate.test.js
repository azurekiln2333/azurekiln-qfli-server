// 永久注销：网关调用、本站数据删除、用户目录清理、审计去标识化。
// 网关用替身 fetch；数据库用真实 sqlite 临时目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-deactivate-'));
process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = DATA_DIR;
process.env.AZK_OAUTH2_BASE_URL = 'https://gateway.example.test';
process.env.AZK_OAUTH2_CLIENT_ID = 'qfli-client';
process.env.AZK_OAUTH2_CLIENT_SECRET = 'test-client-secret';

const db = require('../src/db');
const deactivate = require('../src/deactivate');
const { audit } = require('../src/audit');

const userId = `user_${'a'.repeat(32)}`;
const otherUserId = `user_${'b'.repeat(32)}`;
const gatewayUserId = 'gateway-subject-1';

function fakeRequest() {
  return {
    headers: { 'x-real-ip': '203.0.113.9', 'x-real-port': '41000', 'x-client-platform': 'harmonyos-app/1.2.0' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 5000 },
    requestPath: '/api/users/me/deactivate',
    userId,
    user: { id: userId, username: 'alice' },
  };
}

async function seed() {
  await db.ready;
  await db.prepare('INSERT INTO users (id, gateway_user_id) VALUES (?, ?)').run(userId, gatewayUserId);
  await db.prepare('INSERT INTO users (id, gateway_user_id) VALUES (?, ?)').run(otherUserId, 'gateway-subject-2');
  await db.prepare('INSERT INTO user_state (user_id) VALUES (?)').run(userId);
  await db.prepare('INSERT INTO user_state (user_id) VALUES (?)').run(otherUserId);
  await db.prepare(`INSERT INTO auth_sessions (id, user_id, credentials, access_expires_at, expires_at)
    VALUES ('session-1', ?, 'ciphertext', ?, ?)`).run(userId, Date.now() + 1000, Date.now() + 100000);
  const zone = await db.prepare('SELECT id FROM zones LIMIT 1').get();
  const postId = `post_${'1'.repeat(32)}`;
  await db.prepare('INSERT INTO posts (id, user_id, type, zone_id, title, content) VALUES (?, ?, ?, ?, ?, ?)')
    .run(postId, userId, 'discussion', zone.id, '标题', '正文内容够长');
  await db.prepare('INSERT INTO post_tags (post_id, tag) VALUES (?, ?)').run(postId, 'flutter');
  await db.prepare('INSERT INTO comments (id, post_id, user_id, content) VALUES (?, ?, ?, ?)')
    .run(`comment_${'2'.repeat(32)}`, postId, userId, '评论');
  await db.prepare('INSERT INTO cloud_projects (id, user_id, name) VALUES (?, ?, ?)')
    .run(`proj_${'3'.repeat(32)}`, userId, 'demo');
  return postId;
}

test('gateway erase sends client credentials and the gateway subject', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ user_id: gatewayUserId, status: 'deleted', tokens_revoked: true });
  };
  try {
    const result = await deactivate.eraseGatewayAccount({ gatewayUserId, requestId: 'req-1' });
    assert.equal(result.status, 'deleted');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/oauth2/account/erase'));
    const expected = Buffer.from(
      `${encodeURIComponent('qfli-client')}:${encodeURIComponent('test-client-secret')}`,
    ).toString('base64');
    assert.equal(calls[0].options.headers.authorization, `Basic ${expected}`);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      user_id: gatewayUserId, reason: 'user_request', request_id: 'req-1',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('a gateway 404 for an unknown user is treated as already deleted', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ error: 'user_not_found' }, { status: 404 });
  try {
    const result = await deactivate.eraseGatewayAccount({ gatewayUserId, requestId: 'req-2' });
    assert.equal(result.status, 'already_deleted');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a rejected erase leaves local data and sessions untouched', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json(
    { error: 'insufficient_scope', error_description: 'scope required' }, { status: 403 },
  );
  try {
    await assert.rejects(
      () => deactivate.eraseGatewayAccount({ gatewayUserId, requestId: 'req-3' }),
      error => error.status === 403,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('an unreachable gateway fails closed without deleting anything', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(
      () => deactivate.eraseGatewayAccount({ gatewayUserId, requestId: 'req-4' }),
      error => error.status === 502,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('deactivation removes local data, directories and deidentifies audit rows', async () => {
  const postId = await seed();
  const cloudDir = path.join(DATA_DIR, 'cloud', `u${userId}`, 'proj-x');
  const terminalDir = path.join(DATA_DIR, 'terminals', `u${userId}`);
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.mkdirSync(terminalDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'main.py'), 'print(1)');
  const otherCloud = path.join(DATA_DIR, 'cloud', `u${otherUserId}`);
  fs.mkdirSync(otherCloud, { recursive: true });

  await audit(fakeRequest(), {
    userId, username: 'alice', action: 'auth.password_login', loginType: 'password',
    target: `post:${postId}`, detail: `owner=${userId}`,
  });
  await audit(fakeRequest(), {
    userId: otherUserId, username: 'bob', action: 'auth.password_login', loginType: 'password',
  });

  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ status: 'deleted', tokens_revoked: true });
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const result = await deactivate.deactivateUser(user);
    assert.equal(result.status, 'deactivated');
    assert.equal(result.removedDirectories, 2, 'cloud and terminals roots both removed');
    assert.equal(result.gatewayStatus, 'deleted');
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM user_state WHERE user_id = ?').get(userId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM auth_sessions WHERE user_id = ?').get(userId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM posts WHERE user_id = ?').get(userId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM comments WHERE user_id = ?').get(userId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM post_tags WHERE post_id = ?').get(postId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM cloud_projects WHERE user_id = ?').get(userId), undefined);

  assert.equal(fs.existsSync(path.join(DATA_DIR, 'cloud', `u${userId}`)), false);
  assert.equal(fs.existsSync(terminalDir), false);
  assert.equal(fs.existsSync(otherCloud), true, 'other users keep their files');

  // 审计保留但不含原用户ID，行为与网络来源仍在。
  const mine = await db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.password_login' AND user_id LIKE 'deleted_%'").all();
  assert.equal(mine.length, 1);
  assert.match(mine[0].user_id, /^deleted_[0-9a-f]{32}$/);
  assert.equal(mine[0].username, null);
  assert.equal(mine[0].port, 41000);
  assert.equal(mine[0].platform, 'harmonyos-app');
  assert.equal(mine[0].login_type, 'password');
  assert.ok(!String(mine[0].target).includes(userId));
  assert.ok(!String(mine[0].detail).includes(userId));
  assert.ok(!String(mine[0].detail).includes('alice'));

  // 其他用户的审计不受影响。
  const other = await db.prepare('SELECT * FROM audit_logs WHERE user_id = ?').all(otherUserId);
  assert.equal(other.length, 1);
  assert.equal(other[0].username, 'bob');

  // 其他用户仍然存在。
  assert.ok(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(otherUserId));
});

test('removeUserDirectory refuses symlinks and missing directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-rm-'));
  assert.equal(deactivate.removeUserDirectory(root, 'uuser_missing'), false);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'uuser_link');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch (_) {
    return; // Windows 上无权限时跳过
  }
  assert.equal(deactivate.removeUserDirectory(root, 'uuser_link'), false);
  assert.equal(fs.existsSync(real), true);
});
