// 管理员处置：删除他人内容、处理举报、开关先审后发、封停/禁言、转发词库与 IP 规则。
// 所有写操作都必须带原因并落审计（action 以 admin. 开头）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const moderation = require('../moderation-service');
const { ApiError } = require('../gateway');
const { isId } = require('../entity-id');

const router = express.Router();

function requireAdmin(req, _res, next) {
  if (!req.user?.is_admin) return next(new ApiError(403, '需要管理员权限', { errorKey: 'admin.required' }));
  next();
}

router.use(authRequired, requireAdmin);

function reasonText(value, label = '原因') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 2 || text.length > 500) {
    throw new ApiError(400, `请填写 2-500 字的${label}`, { errorKey: 'admin.reason_required' });
  }
  return text;
}

// ---- 内容删除 ----

router.delete('/posts/:id', async (req, res) => {
  const reason = reasonText(req.body?.reason, '删除原因');
  const post = await db.prepare('SELECT user_id, title FROM posts WHERE id = ?').get(req.params.id);
  if (!post) throw new ApiError(404, '内容不存在');
  await db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  await audit(req, {
    action: 'admin.post_delete',
    target: `post:${req.params.id}`,
    detail: `author=${post.user_id} reason=${reason}`,
  });
  res.json({ ok: true });
});

router.delete('/comments/:id', async (req, res) => {
  const reason = reasonText(req.body?.reason, '删除原因');
  const comment = await db.prepare('SELECT user_id, post_id FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) throw new ApiError(404, '评论不存在');
  await db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  await audit(req, {
    action: 'admin.comment_delete',
    target: `comment:${req.params.id}`,
    detail: `author=${comment.user_id} post=${comment.post_id} reason=${reason}`,
  });
  res.json({ ok: true });
});

// ---- 审核结果（改用 pending / rejected）----

router.patch('/posts/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['published', 'pending', 'rejected'].includes(status)) {
    throw new ApiError(400, '状态无效', { errorKey: 'admin.status_invalid' });
  }
  const changed = await db.prepare('UPDATE posts SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!changed.changes) throw new ApiError(404, '内容不存在');
  await audit(req, {
    action: 'admin.post_status', target: `post:${req.params.id}`,
    detail: `status=${status} reason=${reasonText(req.body?.reason, '处理原因')}`,
  });
  res.json({ ok: true, status });
});

// ---- 举报 ----

router.get('/reports', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const where = [];
  const params = [];
  if (['open', 'handled', 'rejected'].includes(req.query.status)) {
    where.push('r.status = ?');
    params.push(req.query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM reports r ${whereSql}`).get(...params)).n;
  const rows = await db.prepare(
    `SELECT r.* FROM reports r ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items: rows, total, page, pageSize });
});

router.patch('/reports/:id', async (req, res) => {
  const status = req.body?.status;
  if (!['handled', 'rejected'].includes(status)) {
    throw new ApiError(400, '处理结果无效', { errorKey: 'admin.report_status_invalid' });
  }
  const resolution = reasonText(req.body?.resolution, '处理说明');
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) throw new ApiError(404, '举报不存在');
  const changed = await db.prepare(
    "UPDATE reports SET status = ?, resolution = ?, handler_id = ?, handled_at = datetime('now') WHERE id = ? AND status = 'open'",
  ).run(status, resolution, req.userId, req.params.id);
  if (!changed.changes) throw new ApiError(409, '举报已处理', { errorKey: 'admin.report_closed' });
  await audit(req, {
    action: 'admin.report_handle', target: `report:${req.params.id}`,
    detail: `status=${status} target=${report.target_type}:${report.target_id}`,
  });
  res.json({ ok: true, status });
});

// ---- 先审后发 ----

router.get('/settings/pre-publish', async (_req, res) => {
  res.json({ prePublish: await moderation.prePublishEnabled() });
});

router.patch('/settings/pre-publish', async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') throw new ApiError(400, '开关取值无效', { errorKey: 'admin.pre_publish_invalid' });
  await moderation.setPrePublish(enabled);
  await audit(req, { action: 'admin.pre_publish_toggle', detail: `enabled=${enabled}` });
  res.json({ prePublish: enabled });
});

// ---- 封停 / 禁言 ----

router.get('/users/:id/moderation', async (req, res) => {
  const state = await moderation.accountState(req.params.id);
  const row = await db.prepare('SELECT reason, actor_id, updated_at FROM user_moderation WHERE user_id = ?')
    .get(req.params.id);
  res.json({ userId: req.params.id, ...state, reason: row?.reason || null,
    actorId: row?.actor_id || null, updatedAt: row?.updated_at || null });
});

async function setState(req, res, action, patch) {
  const userId = req.params.id;
  if (!isId('users', userId)) throw new ApiError(400, '用户编号无效', { errorKey: 'admin.user_invalid' });
  const exists = await db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!exists) throw new ApiError(404, '用户不存在');
  const reason = reasonText(req.body?.reason, '处置原因');
  const state = await moderation.setAccountState(userId, { ...patch, reason, actorId: req.userId });
  await audit(req, { action, target: `user:${userId}`, detail: `reason=${reason}` });
  res.json({ userId, ...state });
}

router.post('/users/:id/ban', (req, res) => setState(req, res, 'admin.account_ban', { banned: true }));
router.delete('/users/:id/ban', (req, res) => setState(req, res, 'admin.account_unban', { banned: false }));
router.post('/users/:id/mute', (req, res) => setState(req, res, 'admin.account_mute', { muted: true }));
router.delete('/users/:id/mute', (req, res) => setState(req, res, 'admin.account_unmute', { muted: false }));

// ---- 词库与 IP 规则：转发到审核服务的管理接口，本地不落任何判定数据 ----

function forward(operation, build) {
  return async (req, res) => {
    const result = await moderation.adminProxy(operation, build(req));
    await audit(req, {
      action: `admin.moderation_${operation}`, target: req.params.id ? `${req.params.id}` : null,
      detail: req.method,
    });
    res.json(result === undefined ? { ok: true } : result);
  };
}

router.get('/moderation/keywords', forward('listKeywords', (req) => ({
  limit: req.query.limit, offset: req.query.offset, category: req.query.category,
})));
router.post('/moderation/keywords', forward('createKeyword', (req) => ({
  word: req.body?.word, category: req.body?.category, enabled: req.body?.enabled,
})));
router.patch('/moderation/keywords/:id', forward('updateKeyword', (req) => ({
  id: req.params.id, patch: req.body || {},
})));
router.delete('/moderation/keywords/:id', forward('deleteKeyword', (req) => ({ id: req.params.id })));

router.get('/moderation/ip-rules', forward('listIpRules', (req) => ({
  limit: req.query.limit, offset: req.query.offset,
})));
router.post('/moderation/ip-rules', forward('createIpRule', (req) => ({ rule: req.body || {} })));
router.patch('/moderation/ip-rules/:id', forward('updateIpRule', (req) => ({
  id: req.params.id, patch: req.body || {},
})));
router.delete('/moderation/ip-rules/:id', forward('deleteIpRule', (req) => ({ id: req.params.id })));

router.get('/moderation/scenes', forward('listScenes', () => ({})));
router.put('/moderation/scenes/:scene', forward('putScene', (req) => ({
  scene: req.params.scene, preReview: req.body?.preReview === true,
})));

module.exports = router;
