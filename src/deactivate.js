// 永久注销：删除本站数据、清空用户目录、调用网关统一账号注销（W4 接口）。
//
// 顺序刻意从“最不可逆的外部动作”开始：网关注销成功后才删本地数据。
// 网关失败时保持本地数据与会话，让用户重试，避免出现“本地没了但网关还能登录”。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const gateway = require('./gateway');
const { log, stage } = require('./logging');
const { anonymize } = require('./anonymize');

const CONFIRM_PHRASE = 'DEACTIVATE';
const ERASE_TIMEOUT_MS = 15000;

function eraseEndpoint() {
  return `${gateway.required('AZK_OAUTH2_BASE_URL').replace(/\/+$/, '')}/oauth2/account/erase`;
}

// 网关注销：客户端凭据 Basic 鉴权，幂等。
// 200 与 404 user_not_found 都视为“网关侧已无此账号”，可以继续清理本地数据。
async function eraseGatewayAccount({ gatewayUserId, requestId }) {
  const clientId = gateway.required('AZK_OAUTH2_CLIENT_ID');
  const clientSecret = gateway.required('AZK_OAUTH2_CLIENT_SECRET');
  const authorization = `Basic ${Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64')}`;
  let response;
  stage('gateway.account_erase');
  try {
    response = await fetch(eraseEndpoint(), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ user_id: gatewayUserId, reason: 'user_request', request_id: requestId }),
      signal: AbortSignal.timeout(ERASE_TIMEOUT_MS),
    });
  } catch (err) {
    log('gateway.account_erase_failed', { errorType: err.name, networkCode: err.cause?.code }, 'error');
    throw new gateway.ApiError(502, '注销请求未能送达登录网关，请稍后重试');
  }
  const data = await response.json().catch(() => null);
  log('gateway.account_erase_response', {
    status: response.status,
    error: typeof data?.error === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(data.error) ? data.error : undefined,
  }, response.ok ? 'info' : 'error');
  if (response.ok) return data || {};
  if (response.status === 404 && data?.error === 'user_not_found') return { status: 'already_deleted' };
  // 400/401/403/409/500 都不可安全地继续：本地数据保留，用户可重试。
  throw new gateway.ApiError(
    [400, 401, 403, 409, 429].includes(response.status) ? response.status : 502,
    typeof data?.error_description === 'string'
      ? data.error_description.slice(0, 200)
      : '登录网关拒绝了注销请求，请稍后重试',
  );
}

// 删除用户在本站的文件目录。只删精确命名的目录，拒绝符号链接。
function removeUserDirectory(root, name) {
  const target = path.join(root, name);
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    log('deactivate.unsafe_directory', { name }, 'error');
    return false;
  }
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function userRoots() {
  const base = process.env.QFLI_DATA_DIR || path.join(__dirname, '..', 'data');
  return [
    path.join(base, 'cloud'),
    path.join(base, 'terminals'),
  ];
}

// 业务表顺序重要：先删子表（comments/post_tags/likes）再删父表（posts）。
// 审核相关表（W2b）按存在性探测，未部署时跳过。
async function deleteUserRows(tx, userId) {
  await tx.prepare('DELETE FROM comments WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM likes WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(userId);
  await tx.prepare('DELETE FROM posts WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM cloud_projects WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM checkins WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM task_events WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM task_claims WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM point_ledger WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM redemptions WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  for (const table of ['user_moderation', 'publish_rate', 'reports']) {
    const column = table === 'reports' ? 'reporter_id' : 'user_id';
    try {
      await tx.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId);
    } catch (err) {
      // 表不存在（W2b 未部署）时跳过，不影响注销。
      if (!/no such table|doesn't exist/i.test(err.message)) throw err;
    }
  }
  await tx.prepare('DELETE FROM user_state WHERE user_id = ?').run(userId);
  await tx.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// 审计留存 365 天，但个人标识去标识化：action/target/时间/IP/端口/平台保留。
async function deidentifyAudit(tx, userId) {
  const anonymized = `deleted_${anonymize(userId)}`;
  const rows = await tx.prepare('SELECT id, target, detail FROM audit_logs WHERE user_id = ?').all(userId);
  for (const row of rows) {
    // target 与 detail 里可能出现 user_ 前缀的 ID，一并替换。
    const scrub = (value) => (typeof value === 'string' && value.includes(userId)
      ? value.split(userId).join(anonymized)
      : value);
    await tx.prepare('UPDATE audit_logs SET user_id = ?, username = NULL, target = ?, detail = ? WHERE id = ?')
      .run(anonymized, scrub(row.target), scrub(row.detail), row.id);
  }
  return anonymized;
}

async function deactivateUser(user) {
  const requestId = crypto.randomUUID();
  const gatewayResult = await eraseGatewayAccount({
    gatewayUserId: user.gateway_user_id,
    requestId,
  });

  const removed = [];
  for (const root of userRoots()) {
    if (removeUserDirectory(root, `u${user.id}`)) removed.push(root);
  }

  const anonymizedId = await db.transaction(async (tx) => {
    const identity = await deidentifyAudit(tx, user.id);
    await deleteUserRows(tx, user.id);
    return identity;
  });

  return {
    status: 'deactivated',
    gatewayStatus: gatewayResult.status || 'deleted',
    removedDirectories: removed.length,
    auditUserRef: anonymizedId,
  };
}

module.exports = {
  CONFIRM_PHRASE,
  eraseGatewayAccount,
  removeUserDirectory,
  deactivateUser,
  _deleteUserRows: deleteUserRows,
  _deidentifyAudit: deidentifyAudit,
  _userRoots: userRoots,
};
