// 审计日志查询（仅管理员）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../util');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

router.get('/audit', authRequired, requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));
  const where = [];
  const params = [];
  if (req.query.user) {
    where.push('username LIKE ?');
    params.push(`%${String(req.query.user).slice(0, 32)}%`);
  }
  if (req.query.action) {
    where.push('action = ?');
    params.push(String(req.query.action).slice(0, 64));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`).get(...params)
  ).n;
  const rows = await db
    .prepare(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items: rows, total, page, pageSize });
});

module.exports = router;
