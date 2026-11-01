const db = require('./db');

const EXPERIENCE_PER_LEVEL = 100;

async function userGrowth(userId) {
  const row = await db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(points), 0) FROM checkins WHERE user_id = ?) +
       (SELECT COALESCE(SUM(reward), 0) FROM task_claims WHERE user_id = ?) AS experience`,
  ).get(userId, userId);
  const value = Number(row?.experience || 0);
  const experience = Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
  return {
    experience,
    level: Math.floor(experience / EXPERIENCE_PER_LEVEL) + 1,
    levelExperience: experience % EXPERIENCE_PER_LEVEL,
    requiredExperience: EXPERIENCE_PER_LEVEL,
  };
}

module.exports = { userGrowth };
