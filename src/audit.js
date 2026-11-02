// 操作审计：所有敏感操作落库（保留 365 天），写入失败不影响主流程。
// 留存期是向公安承诺的口径：src/audit-retention.js 与 db.js 的启动清理同源。
const db = require('./db');
const identity = require('./identity');
const { createId } = require('./entity-id');
const { clientPlatform, auditIp, auditPort } = require('./client-context');
const { anonymize } = require('./anonymize');
const { RETENTION_DAYS } = require('./audit-retention');

async function audit(req, { userId, username, action, target, detail, loginType }) {
  try {
    await db.prepare(
      `INSERT INTO audit_logs
         (id, user_id, username, action, target, detail, ip, port, platform, login_type, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId('audit_logs'),
      userId ?? req?.userId ?? null,
      username ?? req?.user?.username ?? null,
      action,
      target ?? null,
      detail == null ? null : String(detail).slice(0, 2000),
      auditIp(req),
      auditPort(req),
      clientPlatform(req),
      loginType == null ? null : String(loginType).slice(0, 32),
      String(req?.headers?.['user-agent'] || '').slice(0, 300),
    );
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

async function loadUsername(userId) {
  try {
    const row = await db.prepare('SELECT gateway_user_id FROM users WHERE id = ?').get(userId);
    return row ? (await identity.author(userId, row.gateway_user_id)).username : null;
  } catch (_) {
    return null;
  }
}

// 在线终端频率限制：每用户滑动窗口（内存即可，重启清零可接受）。
const execTimestamps = new Map();
const RATE_LIMIT = Number(process.env.TERMINAL_RATE_LIMIT) || 10;
const RATE_WINDOW_MS = 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [userId, timestamps] of execTimestamps) {
    if (!timestamps.some((value) => value > cutoff)) execTimestamps.delete(userId);
  }
}, RATE_WINDOW_MS).unref();

function terminalRateLimited(userId) {
  if (!execTimestamps.has(userId) && execTimestamps.size >= 10000) return true;
  const now = Date.now();
  const list = (execTimestamps.get(userId) || []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (list.length >= RATE_LIMIT) {
    execTimestamps.set(userId, list);
    return true;
  }
  list.push(now);
  execTimestamps.set(userId, list);
  return false;
}

module.exports = { audit, loadUsername, terminalRateLimited, RETENTION_DAYS };
