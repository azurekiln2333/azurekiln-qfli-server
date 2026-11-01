// 审核接入的路由级测试：真实 Express + 真实 SQLite + 注入的审核服务替身。
// 替身（transport）只实现 W1 契约里的方法，验证的是 QFLI 侧的行为：
// failClosed、错误码、限流、封停、先审后发、可见性、管理员处置与举报。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-moderation-'));
process.env.PUBLISH_RATE_PER_MINUTE = '3';
process.env.PUBLISH_RATE_PER_DAY = '100';
process.env.COMMENT_RATE_PER_MINUTE = '100';
process.env.COMMENT_RATE_PER_DAY = '1000';
delete process.env.MODERATION_BASE_URL;
delete process.env.MODERATION_API_KEY;

const db = require('../src/db');
const moderationClient = require('../src/moderation-client');
const moderation = require('../src/moderation-service');

// ---- 审核服务替身 ----

const calls = [];
const rules = { block: [], review: [], ipBlocked: [], fail: false, failMethods: new Set() };

function setRules(next) {
  Object.assign(rules, { block: [], review: [], ipBlocked: [], fail: false, ...next });
  rules.failMethods = new Set(next.failMethods || []);
}

// 模拟 W1 的规范化（NFKC + 去空格/符号）后再匹配，验证变体也能命中。
function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\u200b-\u200f\u2060\ufeff]+/gu, '');
}

const transport = async (operation, payload) => {
  calls.push({ operation, payload });
  if (rules.fail || rules.failMethods.has(operation)) {
    throw new moderationClient.ModerationUnavailableError();
  }
  if (operation === 'checkText') {
    const text = normalize(payload.text || '');
    const hit = rules.block.find((word) => text.includes(normalize(word)));
    if (hit) return { id: 'decision-1', decision: 'block', categories: ['prohibited_goods'], hits: [{ category: 'prohibited_goods' }] };
    const pending = rules.review.find((word) => text.includes(normalize(word)));
    if (pending) return { id: 'decision-2', decision: 'review', categories: [], hits: [], reviewId: 'review-1' };
    return { id: 'decision-3', decision: 'pass', categories: [], hits: [] };
  }
  if (operation === 'checkIp') {
    const blocked = rules.ipBlocked.includes(payload.ip);
    return { id: 'decision-4', decision: blocked ? 'block' : 'pass',
      categories: blocked ? ['ip_restricted'] : [], hits: [] };
  }
  if (operation === 'submitReport') {
    return { id: 'moderation-report-9', status: 'open' };
  }
  if (operation === 'listKeywords') return { items: [{ id: 'kw1', word: '测试' }], total: 1, limit: 50, offset: 0 };
  return { ok: true };
};

moderationClient.__setTransport(transport);

// ---- 假认证：只注入用户身份，路由逻辑全部走真实实现 ----

const userId = (n) => `user_${n.toString(16).padStart(32, '0')}`;
const ADMIN = userId(1);
const ALICE = userId(2);
const BOB = userId(3);
const accounts = new Map([
  [ADMIN, { is_admin: true }],
  [ALICE, { is_admin: false }],
  [BOB, { is_admin: false }],
]);

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authOptional(req, _res, next) {
      const header = req.headers.authorization || '';
      const id = header.startsWith('Bearer ') ? header.slice(7) : '';
      req.userId = accounts.has(id) ? id : null;
      if (req.userId) req.user = { id: req.userId, is_admin: accounts.get(req.userId).is_admin };
      next();
    },
    authRequired(req, res, next) {
      const header = req.headers.authorization || '';
      const id = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!accounts.has(id)) return res.status(401).json({ error: '未登录' });
      req.userId = id;
      req.user = { id, username: id, is_admin: accounts.get(id).is_admin };
      req.gatewayClaims = { sub: id };
      next();
    },
    publicUser: async () => ({}),
  },
};

const express = require('express');
const postRoutes = require('../src/routes/posts');
const commentRoutes = require('../src/routes/comments');
const reportRoutes = require('../src/routes/reports');
const adminRoutes = require('../src/routes/moderation-admin');
const { ApiError } = require('../src/gateway');

for (const router of [postRoutes, commentRoutes, reportRoutes, adminRoutes]) {
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
app.use('/api/admin', adminRoutes);
app.use('/api', postRoutes);
app.use('/api', commentRoutes);
app.use('/api', reportRoutes);
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ApiError ? error.status : 500;
  if (error instanceof ApiError) {
    return res.status(status).json({ error: error.message, ...error.details });
  }
  res.status(status).json({ error: '服务器内部错误', message: error.message });
});

let server;
let base;

test.before(async () => {
  await db.ready;
  for (const id of accounts.keys()) {
    await db.prepare('INSERT OR IGNORE INTO users (id, gateway_user_id) VALUES (?, ?)').run(id, `gw-${id}`);
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  moderationClient.__setTransport(null);
});

test.beforeEach(async () => {
  calls.length = 0;
  setRules({});
  await db.prepare('DELETE FROM posts').run();
  await db.prepare('DELETE FROM comments').run();
  await db.prepare('DELETE FROM reports').run();
  await db.prepare('DELETE FROM publish_rate').run();
  await db.prepare('DELETE FROM user_moderation').run();
  await db.prepare('DELETE FROM moderation_settings').run();
  await db.prepare('DELETE FROM audit_logs').run();
  await moderation.setPrePublish(false);
});

async function api(method, route, { user, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer ${user}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-real-ip': '203.0.113.7',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text };
}

async function zoneId() {
  const zone = await db.prepare('SELECT id FROM zones ORDER BY sort LIMIT 1').get();
  return zone.id;
}

async function createPost(user, overrides = {}) {
  return api('POST', '/api/posts', {
    user,
    body: {
      type: 'discussion',
      zoneId: await zoneId(),
      title: '一个正常的标题',
      content: '这是一段正常的技术讨论正文。',
      tags: ['flutter'],
      ...overrides,
    },
  });
}

// ---- 用例 ----

test('clean post publishes and is visible to everyone', async () => {
  const created = await createPost(ALICE);
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 'published');
  const list = await api('GET', '/api/posts');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.items[0].status, 'published');
});

test('blocked text returns 422 without echoing the keyword and stores nothing', async () => {
  setRules({ block: ['违禁品'] });
  const created = await createPost(ALICE, { content: '这里有违 禁 品　的变体写法' });
  assert.equal(created.status, 422);
  assert.equal(created.json.errorKey, 'moderation.blocked');
  assert.deepEqual(created.json.categories, ['prohibited_goods']);
  assert.ok(!created.text.includes('违禁品'), '响应不得回显命中词');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').get()).n, 0);
});

test('nickname and bio go through text moderation', async () => {
  // users 路由的鉴权与网关交互依赖外部服务，这里直接验证适配层函数。
  setRules({ block: ['广告'] });
  await assert.rejects(
    moderation.checkProfileFields({ userId: ALICE }, { nickname: '加 广 告 找我', ip: '203.0.113.7' }),
    (err) => err.status === 422 && err.details.errorKey === 'moderation.blocked',
  );
  setRules({});
  await moderation.checkProfileFields({ userId: ALICE }, { nickname: '正常昵称', bio: '写代码' });
});

test('review decision forces pending even when pre-publish is off', async () => {
  setRules({ review: ['待审'] });
  const created = await createPost(ALICE, { content: '这是一段待审的内容。' });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 'pending');
  const anonymous = await api('GET', '/api/posts');
  assert.equal(anonymous.json.total, 0, '待审内容不公开');
  const own = await api('GET', '/api/posts', { user: ALICE });
  assert.equal(own.json.total, 1, '作者可见自己的待审内容');
  const detail = await api('GET', `/api/posts/${created.json.id}`, { user: BOB });
  assert.equal(detail.status, 404, '他人看不到待审详情');
});

test('pre-publish switch hides new posts until approved', async () => {
  await api('PATCH', '/api/admin/settings/pre-publish', { user: ADMIN, body: { enabled: true } });
  const created = await createPost(ALICE);
  assert.equal(created.json.status, 'pending');
  assert.equal((await api('GET', '/api/posts')).json.total, 0);

  // 管理员批准后公开。
  const approved = await api('PATCH', `/api/admin/posts/${created.json.id}/status`, {
    user: ADMIN, body: { status: 'published', reason: '人工复核通过' },
  });
  assert.equal(approved.status, 200);
  assert.equal((await api('GET', '/api/posts')).json.total, 1);
});

test('moderation service outage fails closed with 503', async () => {
  setRules({ fail: true });
  const created = await createPost(ALICE);
  assert.equal(created.status, 503);
  assert.equal(created.json.errorKey, 'moderation.unavailable');
  assert.equal(created.json.error, '审核服务暂不可用');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').get()).n, 0);
  // 查询类不受影响。
  assert.equal((await api('GET', '/api/posts')).status, 200);
});

test('IP rule blocks publishing', async () => {
  setRules({ ipBlocked: ['203.0.113.7'] });
  const created = await createPost(ALICE);
  assert.equal(created.status, 403);
  assert.equal(created.json.errorKey, 'moderation.ip_blocked');
});

test('per-minute publish limit returns 429 with retryAfter', async () => {
  const first = await createPost(ALICE);
  assert.equal(first.status, 200);
  await createPost(ALICE);
  await createPost(ALICE);
  const limited = await createPost(ALICE);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.errorKey, 'rate.limited');
  assert.ok(Number.isInteger(limited.json.retryAfter) && limited.json.retryAfter > 0);
  // 其他用户不受影响。
  assert.equal((await createPost(BOB)).status, 200);
});

test('banned accounts cannot publish; muted accounts cannot comment', async () => {
  const bannedRes = await api('POST', `/api/admin/users/${ALICE}/ban`, { user: ADMIN, body: { reason: '多次违规' } });
  assert.equal(bannedRes.status, 200);
  assert.deepEqual(bannedRes.json, { userId: ALICE, banned: true, muted: false });
  const banned = await createPost(ALICE);
  assert.equal(banned.status, 403);
  assert.equal(banned.json.errorKey, 'account.banned');

  // 禁言只挡发布，不挡浏览。
  const mutedRes = await api('POST', `/api/admin/users/${BOB}/mute`, { user: ADMIN, body: { reason: '刷评论' } });
  assert.equal(mutedRes.status, 200);
  const bannedPost = await createPost(ALICE);
  assert.equal(bannedPost.status, 403, 'ALICE 仍被封停');
  const unban = await api('DELETE', `/api/admin/users/${ALICE}/ban`, { user: ADMIN, body: { reason: '申诉通过' } });
  assert.equal(unban.status, 200);
  const recreated = await createPost(ALICE);
  assert.equal(recreated.status, 200);

  const muted = await api('POST', `/api/posts/${recreated.json.id}/comments`, { user: BOB, body: { content: '我来评论' } });
  assert.equal(muted.status, 403);
  assert.equal(muted.json.errorKey, 'account.muted');
  // 禁言不影响发帖以外的行为：解除后可以评论。
  await api('DELETE', `/api/admin/users/${BOB}/mute`, { user: ADMIN, body: { reason: '解除' } });
  const ok = await api('POST', `/api/posts/${recreated.json.id}/comments`, { user: BOB, body: { content: '正常评论' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.comment.status, 'published');
  // 处置写审计。
  const actions = (await db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'admin.account_%' ORDER BY action").all())
    .map((row) => row.action);
  assert.deepEqual(actions, ['admin.account_ban', 'admin.account_mute', 'admin.account_unban', 'admin.account_unmute']);
});

test('admin takedown requires a reason and writes audit', async () => {
  const created = await createPost(ALICE);
  const missing = await api('DELETE', `/api/admin/posts/${created.json.id}`, { user: ADMIN, body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.errorKey, 'admin.reason_required');

  const removed = await api('DELETE', `/api/admin/posts/${created.json.id}`, {
    user: ADMIN, body: { reason: '含违规内容' },
  });
  assert.equal(removed.status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').get()).n, 0);
  const rows = await db.prepare("SELECT action, detail FROM audit_logs WHERE action = 'admin.post_delete'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /含违规内容/);
});

test('admin comment takedown writes audit and needs admin role', async () => {
  const created = await createPost(ALICE);
  const comment = await api('POST', `/api/posts/${created.json.id}/comments`, { user: BOB, body: { content: '正常评论' } });
  const forbidden = await api('DELETE', `/api/admin/comments/${comment.json.comment.id}`, {
    user: BOB, body: { reason: '我不喜欢' },
  });
  assert.equal(forbidden.status, 403);
  const removed = await api('DELETE', `/api/admin/comments/${comment.json.comment.id}`, {
    user: ADMIN, body: { reason: '广告' },
  });
  assert.equal(removed.status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin.comment_delete'").get()).n, 1);
});

test('reports are stored locally then forwarded; outage keeps the record', async () => {
  const created = await createPost(ALICE);
  const ok = await api('POST', '/api/reports', {
    user: BOB, body: { targetType: 'post', targetId: created.json.id, reason: '疑似广告' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.status, 'open');
  assert.equal(ok.json.moderationReportId, 'moderation-report-9');
  const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(ok.json.id);
  assert.equal(row.forwarded, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'report.create'").get()).n, 1);

  setRules({ fail: true });
  const queued = await api('POST', '/api/reports', {
    user: BOB, body: { targetType: 'post', targetId: created.json.id, reason: '再举报一次' },
  });
  assert.equal(queued.status, 201);
  assert.equal(queued.json.status, 'queued');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM reports').get()).n, 2, '审核服务故障不丢举报');
});

test('report rejects unknown targets and empty reasons', async () => {
  const bad = await api('POST', '/api/reports', {
    user: BOB, body: { targetType: 'post', targetId: 'post_00000000000000000000000000000000', reason: 'x' },
  });
  assert.equal(bad.status, 404);
  const created = await createPost(ALICE);
  const empty = await api('POST', '/api/reports', {
    user: BOB, body: { targetType: 'post', targetId: created.json.id, reason: '  ' },
  });
  assert.equal(empty.status, 400);
});

test('admin can list and handle reports', async () => {
  const created = await createPost(ALICE);
  const report = await api('POST', '/api/reports', {
    user: BOB, body: { targetType: 'post', targetId: created.json.id, reason: '疑似广告' },
  });
  const list = await api('GET', '/api/admin/reports?status=open', { user: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  const handled = await api('PATCH', `/api/admin/reports/${report.json.id}`, {
    user: ADMIN, body: { status: 'handled', resolution: '已删除并通知举报人' },
  });
  assert.equal(handled.status, 200);
  const again = await api('PATCH', `/api/admin/reports/${report.json.id}`, {
    user: ADMIN, body: { status: 'rejected', resolution: '重复处理' },
  });
  assert.equal(again.status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin.report_handle'").get()).n, 1);
});

test('admin moderation proxies reach W1 without local storage', async () => {
  const list = await api('GET', '/api/admin/moderation/keywords', { user: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.ok(calls.some((c) => c.operation === 'listKeywords'));
  setRules({ fail: true });
  const down = await api('GET', '/api/admin/moderation/ip-rules', { user: ADMIN });
  assert.equal(down.status, 503);
  assert.equal(down.json.errorKey, 'moderation.unavailable');
});

test('pending comments stay visible only to their author', async () => {
  await moderation.setPrePublish(true);
  const created = await createPost(ALICE);
  // 帖子本身也是 pending，先让管理员放行，单看评论行为。
  await api('PATCH', `/api/admin/posts/${created.json.id}/status`, {
    user: ADMIN, body: { status: 'published', reason: '先放行帖子' },
  });
  const comment = await api('POST', `/api/posts/${created.json.id}/comments`, { user: BOB, body: { content: '排队中的评论' } });
  assert.equal(comment.json.comment.status, 'pending');
  const anonymous = await api('GET', `/api/posts/${created.json.id}/comments`);
  assert.equal(anonymous.json.items.length, 0);
  const own = await api('GET', `/api/posts/${created.json.id}/comments/mine`, { user: BOB });
  assert.equal(own.json.items.length, 1);
});
