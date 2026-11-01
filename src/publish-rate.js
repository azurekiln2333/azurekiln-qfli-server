// 发布限流：按用户 + 类型，分钟窗口与自然日窗口双上限，计数写入数据库。
// 限流是已向监管承诺的能力，服务重启不得清零，所以不用内存 Map。
const db = require('./db');

const DEFAULTS = {
  post: { perMinute: 3, perDay: 20 },
  comment: { perMinute: 10, perDay: 100 },
};

function limits(kind) {
  const fallback = DEFAULTS[kind] || DEFAULTS.post;
  const prefix = kind === 'comment' ? 'COMMENT' : 'PUBLISH';
  const perMinute = Number(process.env[`${prefix}_RATE_PER_MINUTE`]) || fallback.perMinute;
  const perDay = Number(process.env[`${prefix}_RATE_PER_DAY`]) || fallback.perDay;
  return { perMinute: Math.max(1, perMinute), perDay: Math.max(1, perDay) };
}

function today(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 返回 {allowed:true} 或 {allowed:false, scope:'minute'|'day', retryAfter, limit}。
// 无论是否放行都先占用计数：失败发布同样计入，避免用失败请求刷配额。
async function consume(userId, kind, now = Date.now()) {
  const { perMinute, perDay } = limits(kind);
  const day = today(now);
  const minuteStart = Math.floor(now / 60000) * 60000;
  const row = await db.prepare('SELECT * FROM publish_rate WHERE user_id = ? AND kind = ?').get(userId, kind);
  if (!row) {
    const insert = db.driver === 'mysql'
      ? 'INSERT INTO publish_rate (user_id, kind, day, minute_start, minute_count, day_count) VALUES (?, ?, ?, ?, 1, 1)'
      : 'INSERT OR IGNORE INTO publish_rate (user_id, kind, day, minute_start, minute_count, day_count) VALUES (?, ?, ?, ?, 1, 1)';
    await db.prepare(insert).run(userId, kind, day, minuteStart);
    const created = await db.prepare('SELECT * FROM publish_rate WHERE user_id = ? AND kind = ?').get(userId, kind);
    if (!created || Number(created.minute_start) === minuteStart) return { allowed: true };
    // 并发窗口：另一请求已建行，按更新路径处理。
    return updateExisting(created, kind, now, day, minuteStart, perMinute, perDay);
  }
  return updateExisting(row, kind, now, day, minuteStart, perMinute, perDay);
}

async function updateExisting(row, kind, now, day, minuteStart, perMinute, perDay) {
  const sameMinute = Number(row.minute_start) === minuteStart;
  const sameDay = row.day === day;
  const minuteCount = sameMinute ? Number(row.minute_count) + 1 : 1;
  const dayCount = sameDay ? Number(row.day_count) + 1 : 1;
  await db.prepare(
    'UPDATE publish_rate SET day = ?, minute_start = ?, minute_count = ?, day_count = ? WHERE user_id = ? AND kind = ?',
  ).run(day, minuteStart, minuteCount, dayCount, row.user_id, kind);
  if (minuteCount > perMinute) {
    const retryAfter = Math.max(1, Math.ceil((minuteStart + 60000 - now) / 1000));
    return { allowed: false, scope: 'minute', retryAfter, limit: perMinute };
  }
  if (dayCount > perDay) {
    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);
    const retryAfter = Math.max(1, Math.ceil((endOfDay.getTime() - now) / 1000));
    return { allowed: false, scope: 'day', retryAfter, limit: perDay };
  }
  return { allowed: true, minuteCount, dayCount };
}

module.exports = { consume, limits, DEFAULTS };
