const db = require('../src/db');
const gateway = require('../src/gateway');
const { isUserId } = require('../src/user-id');

async function main() {
  const localId = process.argv[2];
  const gatewayId = process.argv[3];
  if (!isUserId(localId) || !gatewayId || gatewayId.length > 128) {
    throw new Error('用法：npm run link-user -- <本地用户ID> <网关sub>');
  }
  await db.ready;
  const claims = await gateway.publicProfile(gatewayId);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(localId);
  if (!user) throw new Error('本地用户不存在');
  if (user.gateway_user_id) throw new Error('此用户已绑定网关，不能覆盖');
  if (await db.prepare('SELECT id FROM users WHERE gateway_user_id = ?').get(gatewayId)) {
    throw new Error('该网关用户已有本地ID，需人工迁移业务数据后处理，不能覆盖');
  }
  const result = await db.prepare('UPDATE users SET gateway_user_id = ? WHERE id = ? AND gateway_user_id IS NULL').run(gatewayId, localId);
  if (result.changes !== 1) throw new Error('绑定状态已变化，请重新确认');
  console.log(`已绑定本地用户 ${localId} -> 网关 ${gatewayId} (${claims.preferred_username || ''})`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
