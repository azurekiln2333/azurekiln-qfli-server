// 举报中心：POST /api/reports 转发到审核服务的举报中心，同时在本地留痕 365 天。
// 本地行先落库再转发：审核服务不可用时也不能丢举报。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const moderation = require('../moderation-service');
const { createId, isId } = require('../entity-id');

const router = express.Router();

const TARGET_TABLES = { post: 'posts', comment: 'comments', user: 'users' };

function targetExists(targetType, targetId) {
  const table = TARGET_TABLES[targetType];
  if (!table) return Promise.resolve(false);
  if (!isId(table, targetId)) return Promise.resolve(false);
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(targetId).then(Boolean);
}

router.post('/reports', authRequired, async (req, res) => {
  const { targetType, targetId, reason } = req.body || {};
  if (!Object.hasOwn(TARGET_TABLES, targetType)) {
    return res.status(400).json({ error: '举报对象类型无效', errorKey: 'report.target_invalid' });
  }
  if (!(await targetExists(targetType, targetId))) {
    return res.status(404).json({ error: '举报对象不存在', errorKey: 'report.target_missing' });
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 1 || text.length > 500) {
    return res.status(400).json({ error: '请填写 1-500 字的举报理由', errorKey: 'report.reason_invalid' });
  }
  const id = createId('reports');
  await db.prepare(
    `INSERT INTO reports (id, target_type, target_id, reporter_id, reason, status)
     VALUES (?, ?, ?, ?, ?, 'open')`,
  ).run(id, targetType, targetId, req.userId, text);

  // 转发审核服务；失败只影响 forwarded 标记，不影响受理结果。
  let moderationReportId = null;
  let forwarded = false;
  try {
    const result = await moderation.forwardReport({
      targetType, targetId, reporterId: req.userId, reason: text,
    });
    moderationReportId = result.id;
    forwarded = true;
    await db.prepare('UPDATE reports SET moderation_report_id = ?, forwarded = 1 WHERE id = ?')
      .run(moderationReportId, id);
  } catch (_) {
    // 审核服务暂不可用：本地记录保留，管理员仍可在本站受理。
  }

  await audit(req, {
    action: 'report.create',
    target: `${targetType}:${targetId}`,
    detail: `report=${id} forwarded=${forwarded}`,
  });
  res.status(201).json({
    id,
    status: forwarded ? 'open' : 'queued',
    moderationReportId,
  });
});

module.exports = router;
