// 复测回归：必须在"真实中间件 + 真实路由"下通过。
// 上一轮的测试替身自己填了 req.user.is_admin，掩盖了 authOptional 不设 req.user 的事实，
// 因此本文件不再替换 src/util，而是用真实 authOptional/authRequired，
// 只把网关 HTTP 与 identity 的远端调用换成替身。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-acceptance-real-'));
process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = DATA_DIR;
process.env.AZK_OAUTH2_BASE_URL = 'https://gateway.example.test';
process.env.AZK_OAUTH2_CLIENT_ID = 'qfli-client';
process.env.AZK_OAUTH2_CLIENT_SECRET = 'test-client-secret';
process.env.PUBLIC_BASE_URL = 'https://app.example.test';
process.env.MODERATION_BASE_URL = '';
process.env.PUBLISH_RATE_PER_MINUTE = '20';
process.env.PUBLISH_RATE_PER_DAY = '200';
process.env.COMMENT_RATE_PER_MINUTE = '50';
process.env.COMMENT_RATE_PER_DAY = '500';

const db = require('../src/db');
const identity = require('../src/identity');
const adminAccess = require('../src/admin-access');
const moderationClient = require('../src/moderation-client');
const moderation = require('../src/moderation-service');

// 审核服务替身：发布类必须能通过，才谈得上验证可见性。
moderationClient.__setTransport(async (operation) => {
  if (operation === 'checkText' || operation === 'checkIp' || operation === 'checkImage') {
    return { id: 'decision-x', decision: 'pass', categories: [], hits: [] };
  }
  if (operation === 'submitReport') return { id: 'moderation-report-x', status: 'open' };
  return { ok: true };
});

const ADMIN = `user_${'1'.repeat(32)}`;
const AUTHOR = `user_${'2'.repeat(32)}`;
const READER = `user_${'3'.repeat(32)}`;
const ADMIN_SUB = 'gateway-sub-admin';
const AUTHOR_SUB = 'gateway-sub-author';
const READER_SUB = 'gateway-sub-reader';

// 真实 identity.authenticatedProfile 会访问网关；只替换它的远端结果。
const roleBySub = new Map([
  [ADMIN_SUB, { isAdmin: true }],
  [AUTHOR_SUB, { isAdmin: false }],
  [READER_SUB, { isAdmin: false }],
]);
const realProfile = identity.authenticatedProfile;
identity.authenticatedProfile = async (row) => {
  const extra = roleBySub.get(row.gateway_user_id) || { isAdmin: false };
  return { sub: row.gateway_user_id, preferred_username: row.gateway_user_id, ...extra };
};

const express = require('express');
const postRoutes = require('../src/routes/posts');
const commentRoutes = require('../src/routes/comments');
const { ApiError } = require('../src/gateway');

for (const router of [postRoutes, commentRoutes]) {
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
app.use('/api', postRoutes);
app.use('/api', commentRoutes);
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ApiError ? error.status : 500;
  if (error instanceof ApiError) return res.status(status).json({ error: error.message, ...error.details });
  res.status(status).json({ error: '服务器内部错误', message: error.message });
});

let server;
const tokens = new Map();

test.before(async () => {
  await db.ready;
  for (const [id, sub] of [[ADMIN, ADMIN_SUB], [AUTHOR, AUTHOR_SUB], [READER, READER_SUB]]) {
    await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(id, sub);
    await db.prepare('INSERT OR IGNORE INTO user_state (user_id) VALUES (?)').run(id);
  }
  // 真实会话：authOptional 走 identity.session，需要 auth_sessions 行。
  const { signToken } = require('../src/util');
  for (const [id, sub] of [[ADMIN, ADMIN_SUB], [AUTHOR, AUTHOR_SUB], [READER, READER_SUB]]) {
    const sessionId = `session-${id.slice(-4)}`;
    await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
    await db.prepare(`INSERT INTO auth_sessions (id, user_id, credentials, access_expires_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(sessionId, id, 'ciphertext', Date.now() + 600000, Date.now() + 6000000);
    tokens.set(id, signToken({ uid: id, sid: sessionId }));
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});

test.after(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  identity.authenticatedProfile = realProfile;
  moderationClient.__setTransport(null);
});

test.beforeEach(async () => {
  adminAccess.forget();
  await db.prepare('DELETE FROM posts').run();
  await db.prepare('DELETE FROM comments').run();
  await db.prepare('DELETE FROM publish_rate').run();
  await db.prepare('DELETE FROM audit_logs').run();
  await moderation.setPrePublish(false);
});

function api(method, route, { user, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens.get(user)}` } : {}),
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

async function zoneId() {
  return (await db.prepare('SELECT id FROM zones ORDER BY sort LIMIT 1').get()).id;
}

async function createPendingPost() {
  await moderation.setPrePublish(true);
  const created = await api('POST', '/api/posts', {
    user: AUTHOR,
    body: {
      type: 'discussion', zoneId: await zoneId(),
      title: '待审帖子标题', content: '这是一段正常的讨论正文内容。', tags: [],
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 'pending');
  return created.json.id;
}

// 真实 authOptional 不设置 req.user，管理员视角必须靠自身判定。
test('admin sees and opens a pending post through the real authOptional middleware', async () => {
  const postId = await createPendingPost();

  const list = await api('GET', '/api/posts', { user: ADMIN });
  assert.equal(list.status, 200);
  const pending = list.json.items.filter((item) => item.status === 'pending');
  assert.equal(pending.length, 1, '管理员列表必须包含待审帖');
  assert.equal(pending[0].id, postId);

  const detail = await api('GET', `/api/posts/${postId}`, { user: ADMIN });
  assert.equal(detail.status, 200, '管理员必须能打开待审帖详情');
  assert.equal(detail.json.post.status, 'pending');
});

test('a non-admin still cannot see a pending post in list or detail', async () => {
  const postId = await createPendingPost();

  const readerList = await api('GET', '/api/posts', { user: READER });
  assert.equal(readerList.json.items.filter((item) => item.status === 'pending').length, 0);

  const readerDetail = await api('GET', `/api/posts/${postId}`, { user: READER });
  assert.equal(readerDetail.status, 404);

  const anonymous = await api('GET', `/api/posts/${postId}`);
  assert.equal(anonymous.status, 404);

  // 作者本人仍然可见。
  const authorDetail = await api('GET', `/api/posts/${postId}`, { user: AUTHOR });
  assert.equal(authorDetail.status, 200);
});

// 管理员判定结果要缓存，但拿不到网关或会话失效时必须回落为非管理员。
test('the admin check fails closed when the session cannot be resolved', async () => {
  const postId = await createPendingPost();
  const fake = { headers: { authorization: 'Bearer not-a-real-token' }, userId: READER };
  assert.equal(await adminAccess.isAdmin(fake), false);
  const anonymous = { headers: {}, userId: null };
  assert.equal(await adminAccess.isAdmin(anonymous), false);
  // 真实管理员正向用例。
  const adminReq = { headers: { authorization: `Bearer ${tokens.get(ADMIN)}` }, userId: ADMIN };
  assert.equal(await adminAccess.isAdmin(adminReq), true);
  adminAccess.forget();
  void postId;
});
