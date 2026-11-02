// 发给审核服务的用户标识假名化。
//
// 审核服务的审计与举报中心要留存 365 天。如果直接送本地用户ID，
// 用户在本站注销后，审核服务里仍留着可关联到个人的标识，不满足验收第 7 条。
// 因此 QFLI 送给审核服务的 userId、reporterId，以及 targetType=user 时的 targetId，
// 一律换成 HMAC-SHA256 假名：同一用户在审核侧仍可归并，但无法反推本站ID。
//
// 生产未配置盐时按 failClosed 拒绝发布类请求，绝不回退成原始ID。
const crypto = require('node:crypto');

const ENV_NAME = 'QFLI_MODERATION_SUBJECT_SALT';
// 开发环境允许缺省，生产必须显式配置（与 QFLI_JWT_SECRET 同一套口径）。
const DEV_SALT = 'qfli-moderation-subject-dev-only';
const MIN_LENGTH = 16;

function salt() {
  const value = (process.env[ENV_NAME] || '').trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') return '';
  return DEV_SALT;
}

function configured() {
  return salt().length >= MIN_LENGTH;
}

function warnOnce(message) {
  if (warnOnce.shown) return;
  warnOnce.shown = true;
  console.error(JSON.stringify({
    time: new Date().toISOString(), level: 'error', event: 'moderation.subject_salt_missing', message,
  }));
}

// 不可逆假名：稳定输入 → 稳定输出，前缀标明用途，便于审核侧排障时识别。
function pseudonym(userId) {
  if (typeof userId !== 'string' || !userId) return null;
  const key = salt();
  if (!key) return null;
  return `psn_${crypto.createHmac('sha256', key).update(userId).digest('hex')}`;
}

// 严格版本：发布类路径用，缺盐直接抛错交给上层按 failClosed 处理。
function requirePseudonym(userId) {
  if (typeof userId !== 'string' || !userId) return null;
  if (!configured()) {
    warnOnce(`${ENV_NAME} 缺失或过短（至少 ${MIN_LENGTH} 位），审核请求已拒绝`);
    const error = new Error('审核服务身份假名未配置');
    error.code = 'moderation.subject_salt_missing';
    throw error;
  }
  return pseudonym(userId);
}

function forget() {
  warnOnce.shown = false;
}

module.exports = { ENV_NAME, MIN_LENGTH, configured, pseudonym, requirePseudonym, forget };
