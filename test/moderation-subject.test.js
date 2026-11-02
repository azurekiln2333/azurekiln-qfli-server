// 去标识化补漏的回归测试：经过真实路由，断言送给审核服务的请求里不出现原始用户ID。
//
// 验收第 7 条要求"日志已去标识化"。审核服务的审计与举报中心留存 365 天，
// 若直接送本地用户ID，用户注销后仍可关联到个人，因此统一换 HMAC 假名。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-moderation-pseudonym-'));
const SALT = 'acceptance-only-moderation-subject-salt';
process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = DATA_DIR;
process.env.QFLI_MODERATION_SUBJECT_SALT = SALT;
process.env.PUBLISH_RATE_PER_MINUTE = '20';
process.env.PUBLISH_RATE_PER_DAY = '200';
process.env.COMMENT_RATE_PER_MINUTE = '50';
process.env.COMMENT_RATE_PER_DAY = '500';
delete process.env.MODERATION_BASE_URL;
delete process.env.MODERATION_API_KEY;

const db = require('../src/db');
const client = require('../src/moderation-client');
const subject = require('../src/moderation-subject');
const moderation = require('../src/moderation-service');

// 记录每一次到审核服务的调用载荷，供断言使用。
const calls = [];

client.__setTransport(async (operation, payload) => {
  calls.push({ operation, payload });
  if (operation === 'checkText' || operation === 'checkIp' || operation === 'checkImage') {
    return { id: 'decision-x', decision: 'pass', categories: [], hits: [] };
  }
  if (operation === 'submitReport') return { id: 'moderation-report-1', status: 'open' };
  return { ok: true };
});

const AUTHOR = `user_${'a'.repeat(32)}`;
const REPORTER = `user_${'b'.repeat(32)}`;
const VICTIM = `user_${'c'.repeat(32)}`;

// 假认证：只注入身份，路由与适配层全走真实实现。
const accounts = new Map([
  [AUTHOR, { is_admin: false }],
  [REPORTER, { is_admin: false }],
  [VICTIM, { is_admin: false }],
]);

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authOptional(req, _res, next) {
      req.userId = accounts.has(bearer(req)) ? bearer(req) : null;
      next();
    },
    authRequired(req, res, next) {
      const id = bearer(req);
      if (!accounts.has(id)) return res.status(401).json({ error: '未登录' });
      req.userId = id;
      req.user = { id, username: id, is_admin: accounts.get(id).is_admin };
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
const postRoutes = require('../src/routes/posts');
const commentRoutes = require('../src/routes/comments');
const reportRoutes = require('../src/routes/reports');
const { ApiError } = require('../src/gateway');

for (const router of [postRoutes, commentRoutes, reportRoutes]) {
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
app.use('/api', reportRoutes);
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ApiError ? error.status : 500;
  if (error instanceof ApiError) return res.status(status).json({ error: error.message, ...error.details });
  res.status(status).json({ error: '服务器内部错误', message: error.message });
});

let server;

test.before(async () => {
  await db.ready;
  for (const id of accounts.keys()) {
    await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(id, `gw-${id.slice(-4)}`);
    await db.prepare('INSERT OR IGNORE INTO user_state (user_id) VALUES (?)').run(id);
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});

test.after(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  client.__setTransport(null);
});

test.beforeEach(async () => {
  calls.length = 0;
  await db.prepare('DELETE FROM posts').run();
  await db.prepare('DELETE FROM comments').run();
  await db.prepare('DELETE FROM reports').run();
  await db.prepare('DELETE FROM publish_rate').run();
  await moderation.setPrePublish(false);
});

function api(method, route, { user, body } = {}) {
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

function expectedPseudonym(userId) {
  return `psn_${crypto.createHmac('sha256', SALT).update(userId).digest('hex')}`;
}

// 把载荷序列化后检查：任何原始用户 ID 都不得出现。
function assertNoRawIds() {
  const serialized = JSON.stringify(calls);
  for (const id of accounts.keys()) {
    assert.ok(!serialized.includes(id), `审核请求里出现了原始用户ID：${id}\n${serialized}`);
  }
}

test('publishing sends only pseudonyms to the moderation service', async () => {
  const created = await api('POST', '/api/posts', {
    user: AUTHOR,
    body: {
      type: 'discussion', zoneId: await zoneId(),
      title: '正常标题', content: '正常的技术讨论内容。', tags: ['flutter'],
    },
  });
  assert.equal(created.status, 200);
  assertNoRawIds();

  const textCalls = calls.filter((call) => call.operation === 'checkText');
  assert.ok(textCalls.length >= 2, '标题与正文都要送审');
  for (const call of textCalls) {
    assert.equal(call.payload.userId, expectedPseudonym(AUTHOR), '文本审核必须带假名');
  }
  const ipCalls = calls.filter((call) => call.operation === 'checkIp');
  assert.equal(ipCalls.length, 1);
  assert.equal(ipCalls[0].payload.userId, expectedPseudonym(AUTHOR));
});

test('comments and nickname checks also send pseudonyms', async () => {
  const created = await api('POST', '/api/posts', {
    user: AUTHOR,
    body: { type: 'discussion', zoneId: await zoneId(), title: '正常标题', content: '正常的技术讨论内容。', tags: [] },
  });
  assert.equal(created.status, 200);
  calls.length = 0;
  const comment = await api('POST', `/api/posts/${created.json.id}/comments`, {
    user: REPORTER, body: { content: '正常评论内容' },
  });
  assert.equal(comment.status, 200, comment.text);
  const textCalls = calls.filter((call) => call.operation === 'checkText');
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].payload.userId, expectedPseudonym(REPORTER));

  await moderation.checkProfileFields({ userId: REPORTER }, { nickname: '正常昵称', ip: '198.51.100.17' });
  assertNoRawIds();
});

test('reports send a pseudonymous reporterId and never the raw id', async () => {
  const created = await api('POST', '/api/posts', {
    user: AUTHOR,
    body: { type: 'discussion', zoneId: await zoneId(), title: '正常标题', content: '正常的技术讨论内容。', tags: [] },
  });
  calls.length = 0;
  const report = await api('POST', '/api/reports', {
    user: REPORTER, body: { targetType: 'post', targetId: created.json.id, reason: '疑似广告' },
  });
  assert.equal(report.status, 201);
  const forwarded = calls.filter((call) => call.operation === 'submitReport');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].payload.reporterId, expectedPseudonym(REPORTER));
  // 帖子目标本身不是个人标识，按原样送。
  assert.equal(forwarded[0].payload.targetId, created.json.id);
  assertNoRawIds();

  // 本地举报行仍存真实上报人，便于本站追责与通知。
  const row = await db.prepare('SELECT reporter_id FROM reports WHERE id = ?').get(report.json.id);
  assert.equal(row.reporter_id, REPORTER);
});

test('a user target is pseudonymised as well', async () => {
  calls.length = 0;
  const report = await api('POST', '/api/reports', {
    user: REPORTER, body: { targetType: 'user', targetId: VICTIM, reason: '冒名顶替' },
  });
  assert.equal(report.status, 201);
  const forwarded = calls.filter((call) => call.operation === 'submitReport');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].payload.reporterId, expectedPseudonym(REPORTER));
  assert.equal(forwarded[0].payload.targetId, expectedPseudonym(VICTIM));
  assertNoRawIds();
});

test('the pseudonym is stable so the moderation service can still correlate', async () => {
  assert.equal(subject.pseudonym(AUTHOR), subject.pseudonym(AUTHOR));
  assert.notEqual(subject.pseudonym(AUTHOR), subject.pseudonym(REPORTER));
  assert.match(subject.pseudonym(AUTHOR), /^psn_[0-9a-f]{64}$/);
});

test('a different salt yields a different pseudonym', async () => {
  const before = subject.pseudonym(AUTHOR);
  process.env.QFLI_MODERATION_SUBJECT_SALT = 'another-acceptance-salt-value';
  try {
    assert.notEqual(subject.pseudonym(AUTHOR), before, '换盐后旧假名无法关联');
  } finally {
    process.env.QFLI_MODERATION_SUBJECT_SALT = SALT;
  }
});

test('a missing salt fails closed instead of sending the raw id', async () => {
  const saved = process.env.QFLI_MODERATION_SUBJECT_SALT;
  const savedEnv = process.env.NODE_ENV;
  process.env.QFLI_MODERATION_SUBJECT_SALT = '';
  // 开发环境有默认盐（与服务端启动口径一致），要验证 failClosed 必须按生产配置。
  process.env.NODE_ENV = 'production';
  subject.forget();
  try {
    calls.length = 0;
    const created = await api('POST', '/api/posts', {
      user: AUTHOR,
      body: {
        type: 'discussion', zoneId: await zoneId(),
        title: '正常标题', content: '正常的技术讨论内容。', tags: [],
      },
    });
    assert.equal(created.status, 503, '缺盐必须拒绝发布');
    assert.equal(created.json.errorKey, 'moderation.unavailable');
    assert.equal(calls.length, 0, '不得向审核服务发出任何请求');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').get()).n, 0);
  } finally {
    process.env.QFLI_MODERATION_SUBJECT_SALT = saved;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    subject.forget();
  }
});

test('the salt must be long enough to be meaningful', async () => {
  const saved = process.env.QFLI_MODERATION_SUBJECT_SALT;
  process.env.QFLI_MODERATION_SUBJECT_SALT = 'short';
  subject.forget();
  try {
    assert.equal(subject.configured(), false);
    assert.throws(() => subject.requirePseudonym(AUTHOR), /未配置|至少/);
  } finally {
    process.env.QFLI_MODERATION_SUBJECT_SALT = saved;
    subject.forget();
  }
});

test('production without a salt refuses rather than falling back to the dev salt', async () => {
  const saved = process.env.QFLI_MODERATION_SUBJECT_SALT;
  const savedEnv = process.env.NODE_ENV;
  process.env.QFLI_MODERATION_SUBJECT_SALT = '';
  process.env.NODE_ENV = 'production';
  subject.forget();
  try {
    assert.equal(subject.pseudonym(AUTHOR), null);
    assert.throws(() => subject.requirePseudonym(AUTHOR));
  } finally {
    process.env.QFLI_MODERATION_SUBJECT_SALT = saved;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    subject.forget();
  }
});
