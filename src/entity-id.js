const crypto = require('node:crypto');

const prefixes = { users: 'user', zones: 'zone', posts: 'post', comments: 'comment', audit_logs: 'audit', cloud_projects: 'proj', reward_items: 'reward', redemptions: 'redeem', point_ledger: 'point', task_events: 'event' };

function createId(table) {
  const prefix = prefixes[table];
  if (!prefix) throw new Error('未知实体类型');
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function isId(table, value) {
  return typeof value === 'string' && new RegExp(`^${prefixes[table]}_[0-9a-f]{32}$`).test(value);
}

module.exports = { prefixes, createId, isId };
