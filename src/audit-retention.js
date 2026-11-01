// 审计日志留存期（天）。这是向公安承诺的口径：登录日志、操作日志、举报记录留存 365 天。
// 单独成模块，让 src/audit.js（写入侧）与 src/db.js（启动清理侧）读同一个值。
const RETENTION_DAYS = 365;

module.exports = { RETENTION_DAYS };
