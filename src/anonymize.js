// 去标识化：注销后审计日志仍要留存 365 天，但其中的个人标识必须不可逆。
// 用固定盐的 SHA-256 摘要替换用户ID，同一用户的历史行仍可归并核对。
const crypto = require('node:crypto');

const SALT = process.env.QFLI_AUDIT_SALT || 'qfli-audit-deidentification-v1';

function anonymize(value) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHash('sha256').update(`${SALT}\n${value}`).digest('hex').slice(0, 32);
}

module.exports = { anonymize };
