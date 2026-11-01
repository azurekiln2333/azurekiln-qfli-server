// 内容审核的业务适配层：QFLI 只在这里决定"哪些内容要审、什么时候拒绝发布"。
// 判定本身全部在 W1 审核服务，本文件不含词库、正则或供应商细节。
const db = require('./db');
const client = require('./moderation-client');
const publishRate = require('./publish-rate');
const { ApiError } = require('./gateway');

const PRE_PUBLISH_KEY = 'pre_publish';

function flag(value) {
  return value === '1' || value === 'true';
}

// ---- 开关 ----

async function prePublishEnabled() {
  const row = await db.prepare('SELECT value FROM moderation_settings WHERE key = ?').get(PRE_PUBLISH_KEY);
  return flag(row?.value);
}

async function setPrePublish(enabled) {
  const value = enabled ? '1' : '0';
  if (db.driver === 'mysql') {
    await db.prepare(
      'INSERT INTO moderation_settings (`key`, value, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()',
    ).run(PRE_PUBLISH_KEY, value);
  } else {
    await db.prepare(
      `INSERT INTO moderation_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(PRE_PUBLISH_KEY, value);
  }
  return enabled;
}

// ---- 账号处置 ----

async function accountState(userId) {
  const row = await db.prepare('SELECT banned, muted FROM user_moderation WHERE user_id = ?').get(userId);
  return { banned: Boolean(row?.banned), muted: Boolean(row?.muted) };
}

async function setAccountState(userId, { banned, muted, reason, actorId }) {
  const current = await db.prepare('SELECT banned, muted FROM user_moderation WHERE user_id = ?').get(userId);
  const nextBanned = banned === undefined ? Boolean(current?.banned) : Boolean(banned);
  const nextMuted = muted === undefined ? Boolean(current?.muted) : Boolean(muted);
  const values = [userId, nextBanned ? 1 : 0, nextMuted ? 1 : 0, reason || null, actorId || null];
  if (db.driver === 'mysql') {
    await db.prepare(
      `INSERT INTO user_moderation (user_id, banned, muted, reason, actor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE banned = VALUES(banned), muted = VALUES(muted),
         reason = VALUES(reason), actor_id = VALUES(actor_id), updated_at = NOW()`,
    ).run(...values);
  } else {
    await db.prepare(
      `INSERT INTO user_moderation (user_id, banned, muted, reason, actor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET banned = excluded.banned, muted = excluded.muted,
         reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at`,
    ).run(...values);
  }
  return { banned: nextBanned, muted: nextMuted };
}

// ---- W1 调用封装 ----

function unavailable(err) {
  const message = err instanceof client.ModerationUnavailableError && err.message !== '审核服务暂不可用'
    ? err.message
    : '审核服务暂不可用';
  return new ApiError(503, '审核服务暂不可用', { errorKey: 'moderation.unavailable', cause: message });
}

function blocked(categories) {
  const list = Array.isArray(categories) ? categories.filter((c) => typeof c === 'string').slice(0, 8) : [];
  // 不回显命中词原文，只回分类。
  return new ApiError(422, '内容未通过审核', { errorKey: 'moderation.blocked', categories: list });
}

// 单字段文本审核。返回 {decision, categories}；block 时抛 422，服务不可用时抛 503。
async function checkText({ scene, text, userId, ip }) {
  if (typeof text !== 'string' || text.trim() === '') return { decision: 'pass', categories: [] };
  let result;
  try {
    result = await client.call('checkText', { scene, text, userId, ip });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unavailable(err);
  }
  const decision = result?.decision;
  const categories = Array.isArray(result?.categories) ? result.categories : [];
  if (decision === 'block') throw blocked(categories);
  return { decision: decision === 'review' ? 'review' : 'pass', categories };
}

async function checkIp({ ip, userId, scene }) {
  if (!ip) return { blocked: false };
  let result;
  try {
    result = await client.call('checkIp', { ip, userId, scene });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unavailable(err);
  }
  const hit = result?.blocked === true || result?.decision === 'block';
  return { blocked: hit, rule: typeof result?.rule === 'string' ? result.rule : undefined };
}

// ---- 发布闸门 ----

// 顺序：账号处置 → 限流 → IP 规则 → 文本审核 → 先审后发判定。
// kind: 'post' | 'comment'。fields: [{scene, text}]，空字段自动跳过。
// 返回 {status:'published'|'pending'}；任一环节拒绝直接抛 ApiError。
async function publishGate(req, { kind, fields, ip }) {
  const userId = req.userId;
  const state = await accountState(userId);
  if (state.banned) {
    throw new ApiError(403, '账号已被封停，无法发布内容', { errorKey: 'account.banned' });
  }
  if (state.muted) {
    throw new ApiError(403, '账号已被禁言，无法发布内容', { errorKey: 'account.muted' });
  }

  const rate = await publishRate.consume(userId, kind);
  if (!rate.allowed) {
    throw new ApiError(429, rate.scope === 'day' ? '今日发布已达上限' : '发布过于频繁，请稍后再试', {
      errorKey: 'rate.limited',
      retryAfter: rate.retryAfter,
      scope: rate.scope,
    });
  }

  const ipCheck = await checkIp({ ip, userId, scene: kind === 'comment' ? 'community.comment' : 'community.post' });
  if (ipCheck.blocked) {
    throw new ApiError(403, '当前网络不允许发布内容', { errorKey: 'moderation.ip_blocked' });
  }

  let review = false;
  for (const field of fields) {
    const outcome = await checkText({ scene: field.scene, text: field.text, userId, ip });
    if (outcome.decision === 'review') review = true;
  }

  if (review || await prePublishEnabled()) return { status: 'pending' };
  return { status: 'published' };
}

// ---- 资料字段审核（昵称、简介）----

async function checkProfileFields(req, { nickname, bio, ip }) {
  const fields = [];
  if (typeof nickname === 'string') fields.push({ scene: 'profile.nickname', text: nickname });
  if (typeof bio === 'string') fields.push({ scene: 'profile.bio', text: bio });
  for (const field of fields) {
    await checkText({ scene: field.scene, text: field.text, userId: req.userId, ip });
  }
}

// ---- 举报转发 ----

async function forwardReport({ targetType, targetId, reporterId, reason }) {
  const result = await client.call('submitReport', { targetType, targetId, reporterId, reason });
  return { id: typeof result?.id === 'string' ? result.id : null };
}

// ---- 管理接口代理（词库、IP 规则）----

async function adminProxy(operation, payload) {
  try {
    return await client.call(operation, payload);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unavailable(err);
  }
}

module.exports = {
  PRE_PUBLISH_KEY,
  prePublishEnabled,
  setPrePublish,
  accountState,
  setAccountState,
  checkText,
  checkIp,
  checkProfileFields,
  publishGate,
  forwardReport,
  adminProxy,
  client,
};
