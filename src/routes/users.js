// 用户资料与任务/签到路由。
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { authRequired, publicUser } = require('../util');
const { audit } = require('../audit');
const identity = require('../identity');
const gateway = require('../gateway');
const deactivate = require('../deactivate');
const { RETENTION_DAYS } = require('../audit-retention');
const { userGrowth } = require('../growth');
const { createId, isId } = require('../entity-id');
const moderation = require('../moderation-service');
const { clientIp } = require('../client-ip');

const router = express.Router();

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterday() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eventDay(value) {
  const day = value == null ? today() : value;
  const parsed = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day) {
    throw new gateway.ApiError(400, '任务日期无效');
  }
  const delta = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000;
  if (delta < -30 || delta > 1) throw new gateway.ApiError(400, '任务日期超出可同步范围');
  return day;
}

async function taskSnapshot(userId, day = today()) {
  const state = await db.prepare('SELECT * FROM user_state WHERE user_id = ?').get(userId);
  if (!state) throw new gateway.ApiError(404, '用户不存在');
  const checkedToday = !!(await db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND date = ?').get(userId, day));
  const [configs, counts, claims] = await Promise.all([
    db.prepare('SELECT * FROM task_config ORDER BY event_key, target_count').all(),
    db.prepare('SELECT event_key, COUNT(*) AS count FROM task_events WHERE user_id = ? AND date = ? GROUP BY event_key').all(userId, day),
    db.prepare('SELECT task_key FROM task_claims WHERE user_id = ? AND date = ?').all(userId, day),
  ]);
  const progress = new Map(counts.map(row => [row.event_key, Number(row.count)]));
  const completed = new Set(claims.map(row => row.task_key));
  return {
    day, checkedToday,
    streak: [today(), yesterday()].includes(state.last_checkin_date) ? state.checkin_streak : 0,
    points: state.points,
    growth: await userGrowth(userId),
    tasks: configs.filter(config => config.enabled).map(config => {
      const count = config.event_key === 'checkin' ? (checkedToday ? 1 : 0)
        : progress.get(config.event_key) || 0;
      return {
        key: config.key, eventKey: config.event_key, label: config.label,
        progress: count, target: config.target_count, reward: config.reward,
        done: config.event_key === 'checkin' ? checkedToday : completed.has(config.key),
      };
    }),
  };
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

async function recordPoints(tx, userId, amount, kind, referenceId) {
  const changed = await tx.prepare(
    'UPDATE user_state SET points = points + ? WHERE user_id = ? AND points + ? >= 0',
  ).run(amount, userId, amount);
  if (changed.changes !== 1) throw new gateway.ApiError(409, '积分不足');
  const state = await tx.prepare('SELECT points FROM user_state WHERE user_id = ?').get(userId);
  await tx.prepare(
    'INSERT INTO point_ledger (id, user_id, amount, balance_after, kind, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(createId('point_ledger'), userId, amount, state.points, kind, referenceId);
  return state.points;
}

router.get('/me', authRequired, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const stats = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM posts WHERE user_id = ?) AS posts,
        (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS comments,
        (SELECT COUNT(*) FROM likes WHERE user_id = ?) AS likes_given`,
    )
    .get(req.userId, req.userId, req.userId);
  res.json({ user: await publicUser(user, req.gatewayClaims), stats });
});

router.patch('/me', authRequired, async (req, res) => {
  const { nickname, bio } = req.body || {};
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const updates = {};
  if (nickname !== undefined) {
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 64) throw new gateway.ApiError(400, '昵称需为 1-64 字');
    updates.name = nickname.trim();
  }
  if (bio !== undefined) {
    if (typeof bio !== 'string' || bio.length > 200) throw new gateway.ApiError(400, '简介不能超过 200 字');
    updates.description = bio;
  }
  if (req.body?.avatarColor !== undefined) throw new gateway.ApiError(400, '头像颜色不单独存储，请使用网关头像');
  // 昵称与简介属于公开内容，必须先过文本审核（命中直接 422）。
  await moderation.checkProfileFields(req, {
    nickname: updates.name, bio: updates.description, ip: clientIp(req),
  });
  const claims = await gateway.updateProfile(await identity.accessToken(req.authSession), updates);
  if (gateway.subject(claims) !== user.gateway_user_id) throw new gateway.ApiError(502, '用户身份不匹配');
  identity.rememberProfile(user.gateway_user_id, claims);
  audit(req, { userId: req.userId, username: req.user.username, action: 'user.update_profile' });
  res.json({ user: await publicUser(user, claims) });
});

router.get('/me/tasks', authRequired, async (req, res) => {
  res.json(await taskSnapshot(req.userId));
});

// 永久注销账号：二次确认 + 网关统一账号注销 + 删除本站数据 + 审计去标识化。
// 未实名账号也必须能注销，因此本路由不在实名门槛的受限前缀里。
router.post('/me/deactivate', authRequired, async (req, res) => {
  if (req.body?.confirm !== deactivate.CONFIRM_PHRASE) {
    throw new gateway.ApiError(400, `注销需要二次确认：请在 confirm 字段提交 ${deactivate.CONFIRM_PHRASE}`);
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) throw new gateway.ApiError(404, '用户不存在');
  if (!user.gateway_user_id) throw new gateway.ApiError(409, '该账号未绑定登录网关，请联系管理员注销');
  const result = await deactivate.deactivateUser(user);
  res.json({
    status: result.status,
    deactivated: true,
    retentionDays: RETENTION_DAYS,
  });
});

router.get('/me/checkins', authRequired, async (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new gateway.ApiError(400, '月份格式无效');
  const rows = await db.prepare(
    'SELECT date, points FROM checkins WHERE user_id = ? AND date LIKE ? ORDER BY date',
  ).all(req.userId, `${month}-%`);
  res.json({ month, days: rows.map(row => ({ date: row.date, points: row.points })) });
});

router.post('/me/checkin', authRequired, async (req, res) => {
  const day = today();
  const result = await db.transaction(async tx => {
    const user = await tx.prepare(`SELECT * FROM user_state WHERE user_id = ?${db.driver === 'mysql' ? ' FOR UPDATE' : ''}`).get(req.userId);
    const existing = await tx.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND date = ?').get(req.userId, day);
    if (existing) return { alreadyChecked: true, streak: user.checkin_streak, points: user.points, reward: 0 };
    const config = await tx.prepare("SELECT reward, enabled FROM task_config WHERE `key` = 'checkin'").get();
    if (!config?.enabled) throw new gateway.ApiError(409, '签到任务暂未开放');
    const streak = user.last_checkin_date === yesterday() ? user.checkin_streak + 1 : 1;
    const reward = config.reward + Math.min(streak - 1, 6) * 2;
    await tx.prepare('INSERT INTO checkins (user_id, date, points) VALUES (?, ?, ?)').run(req.userId, day, reward);
    await tx.prepare('UPDATE user_state SET checkin_streak = ?, last_checkin_date = ? WHERE user_id = ?').run(streak, day, req.userId);
    const points = await recordPoints(tx, req.userId, reward, 'checkin', day);
    return { alreadyChecked: false, reward, streak, points };
  });
  if (!result.alreadyChecked) audit(req, { action: 'user.checkin', detail: `streak=${result.streak} reward=${result.reward}` });
  res.json({ ...result, ...(await taskSnapshot(req.userId)) });
});

router.post('/me/task-events', authRequired, async (req, res) => {
  const key = req.body?.key;
  if (!['create_project', 'open_project', 'save_file'].includes(key)) throw new gateway.ApiError(400, '任务类型无效');
  const day = eventDay(req.body?.day);
  const eventId = req.body?.eventId == null
    ? `event_${crypto.createHash('sha256').update(`${req.userId}:${day}:${key}:legacy`).digest('hex').slice(0, 32)}`
    : req.body.eventId;
  if (!isId('task_events', eventId)) throw new gateway.ApiError(400, '任务事件编号无效');
  const result = await db.transaction(async tx => {
    const state = await tx.prepare(`SELECT points FROM user_state WHERE user_id = ?${db.driver === 'mysql' ? ' FOR UPDATE' : ''}`).get(req.userId);
    if (!state) throw new gateway.ApiError(404, '用户不存在');
    const existing = await tx.prepare('SELECT 1 FROM task_events WHERE user_id = ? AND event_id = ?').get(req.userId, eventId);
    if (existing) return { awarded: false, reward: 0, duplicate: true };
    await tx.prepare('INSERT INTO task_events (user_id, event_id, date, event_key) VALUES (?, ?, ?, ?)').run(req.userId, eventId, day, key);
    const count = Number((await tx.prepare('SELECT COUNT(*) AS count FROM task_events WHERE user_id = ? AND date = ? AND event_key = ?').get(req.userId, day, key)).count);
    const milestones = await tx.prepare('SELECT `key`, reward FROM task_config WHERE event_key = ? AND enabled = 1 AND target_count <= ? ORDER BY target_count').all(key, count);
    let reward = 0;
    for (const milestone of milestones) {
      const claimed = await tx.prepare('SELECT 1 FROM task_claims WHERE user_id = ? AND date = ? AND task_key = ?').get(req.userId, day, milestone.key);
      if (claimed) continue;
      await tx.prepare('INSERT INTO task_claims (user_id, date, task_key, reward) VALUES (?, ?, ?, ?)').run(req.userId, day, milestone.key, milestone.reward);
      await recordPoints(tx, req.userId, milestone.reward, 'task', `${day}:${milestone.key}`);
      reward += milestone.reward;
    }
    return { awarded: reward > 0, reward, duplicate: false, count };
  });
  if (result.awarded) audit(req, { action: 'user.task_reward', target: key, detail: `reward=${result.reward} count=${result.count}` });
  res.json({ ...result, ...(await taskSnapshot(req.userId)) });
});

router.get('/me/points', authRequired, async (req, res) => {
  const state = await db.prepare('SELECT points FROM user_state WHERE user_id = ?').get(req.userId);
  const entries = await db.prepare(
    'SELECT id, amount, balance_after, kind, reference_id, created_at FROM point_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
  ).all(req.userId);
  res.json({ points: state?.points || 0, entries });
});

router.get('/me/rewards', authRequired, async (_req, res) => {
  const items = await db.prepare('SELECT id, title, description, cost, stock FROM reward_items WHERE enabled = 1 ORDER BY cost, title').all();
  res.json({ items });
});

router.get('/me/redemptions', authRequired, async (req, res) => {
  const items = await db.prepare('SELECT id, item_title, cost, status, created_at FROM redemptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.userId);
  res.json({ items });
});

router.post('/me/rewards/:id/redeem', authRequired, async (req, res) => {
  if (!isId('reward_items', req.params.id)) throw new gateway.ApiError(400, '兑换项无效');
  const result = await db.transaction(async tx => {
    const state = await tx.prepare(`SELECT points FROM user_state WHERE user_id = ?${db.driver === 'mysql' ? ' FOR UPDATE' : ''}`).get(req.userId);
    const item = await tx.prepare(`SELECT * FROM reward_items WHERE id = ?${db.driver === 'mysql' ? ' FOR UPDATE' : ''}`).get(req.params.id);
    if (!item?.enabled || item.stock === 0) throw new gateway.ApiError(404, '兑换项已下架或售罄');
    if (state.points < item.cost) throw new gateway.ApiError(409, '积分不足');
    const id = createId('redemptions');
    await tx.prepare('UPDATE reward_items SET stock = stock - 1 WHERE id = ? AND stock > 0').run(item.id);
    await tx.prepare('INSERT INTO redemptions (id, user_id, item_id, item_title, cost) VALUES (?, ?, ?, ?, ?)').run(id, req.userId, item.id, item.title, item.cost);
    const points = await recordPoints(tx, req.userId, -item.cost, 'redeem', id);
    return { id, points, cost: item.cost, status: 'pending' };
  });
  audit(req, { action: 'user.redeem', target: result.id, detail: `cost=${result.cost}` });
  res.json(result);
});

router.get('/admin/tasks', authRequired, requireAdmin, async (_req, res) => {
  res.json({ items: await db.prepare('SELECT * FROM task_config ORDER BY `key`').all() });
});

router.patch('/admin/tasks/:key', authRequired, requireAdmin, async (req, res) => {
  const { reward, enabled, targetCount } = req.body || {};
  if (!Number.isInteger(reward) || reward < 0 || reward > 1000 ||
      typeof enabled !== 'boolean' || !Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) {
    throw new gateway.ApiError(400, '任务配置无效');
  }
  const task = await db.prepare('SELECT event_key FROM task_config WHERE `key` = ?').get(req.params.key);
  if (!task) throw new gateway.ApiError(404, '任务不存在');
  if (task.event_key === 'checkin' && targetCount !== 1) throw new gateway.ApiError(400, '签到目标固定为 1 次');
  const duplicate = await db.prepare('SELECT 1 FROM task_config WHERE event_key = ? AND target_count = ? AND `key` <> ?').get(task.event_key, targetCount, req.params.key);
  if (duplicate) throw new gateway.ApiError(409, '同类任务已有相同目标次数');
  const changed = await db.prepare('UPDATE task_config SET reward = ?, enabled = ?, target_count = ? WHERE `key` = ?').run(reward, enabled ? 1 : 0, targetCount, req.params.key);
  if (!changed.changes) throw new gateway.ApiError(404, '任务不存在');
  audit(req, { action: 'admin.task_config', target: req.params.key, detail: `reward=${reward} enabled=${enabled} target=${targetCount}` });
  res.json({ ok: true });
});

router.get('/admin/rewards', authRequired, requireAdmin, async (_req, res) => {
  res.json({ items: await db.prepare('SELECT * FROM reward_items ORDER BY title').all() });
});

router.post('/admin/rewards', authRequired, requireAdmin, async (req, res) => {
  const { title, description = '', cost, stock = -1 } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || typeof description !== 'string' || description.length > 500 || !Number.isInteger(cost) || cost < 1 || cost > 1000000 || !Number.isInteger(stock) || stock < -1) throw new gateway.ApiError(400, '兑换项配置无效');
  const id = createId('reward_items');
  await db.prepare('INSERT INTO reward_items (id, title, description, cost, stock) VALUES (?, ?, ?, ?, ?)').run(id, title.trim(), description.trim(), cost, stock);
  audit(req, { action: 'admin.reward_create', target: id });
  res.json({ id });
});

router.patch('/admin/rewards/:id', authRequired, requireAdmin, async (req, res) => {
  const { title, description, cost, stock, enabled } = req.body || {};
  if (!isId('reward_items', req.params.id) || typeof title !== 'string' || !title.trim() || title.length > 80 || typeof description !== 'string' || description.length > 500 || !Number.isInteger(cost) || cost < 1 || cost > 1000000 || !Number.isInteger(stock) || stock < -1 || typeof enabled !== 'boolean') throw new gateway.ApiError(400, '兑换项配置无效');
  const changed = await db.prepare('UPDATE reward_items SET title = ?, description = ?, cost = ?, stock = ?, enabled = ? WHERE id = ?').run(title.trim(), description.trim(), cost, stock, enabled ? 1 : 0, req.params.id);
  if (!changed.changes) throw new gateway.ApiError(404, '兑换项不存在');
  audit(req, { action: 'admin.reward_update', target: req.params.id });
  res.json({ ok: true });
});

router.get('/admin/redemptions', authRequired, requireAdmin, async (_req, res) => {
  res.json({ items: await db.prepare('SELECT id, user_id, item_title, cost, status, created_at FROM redemptions ORDER BY created_at DESC LIMIT 100').all() });
});

router.patch('/admin/redemptions/:id', authRequired, requireAdmin, async (req, res) => {
  if (!isId('redemptions', req.params.id) || req.body?.status !== 'fulfilled') throw new gateway.ApiError(400, '兑换状态无效');
  const changed = await db.prepare("UPDATE redemptions SET status = 'fulfilled' WHERE id = ? AND status = 'pending'").run(req.params.id);
  if (!changed.changes) throw new gateway.ApiError(409, '兑换记录不存在或已处理');
  audit(req, { action: 'admin.redemption_fulfilled', target: req.params.id });
  res.json({ ok: true });
});

router.get('/me/posts', authRequired, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT p.*, z.name AS zone_name FROM posts p
       JOIN zones z ON z.id = p.zone_id
       WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    )
    .all(req.userId);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      zoneName: r.zone_name,
      createdAt: r.created_at,
    })),
  });
});

module.exports = router;
