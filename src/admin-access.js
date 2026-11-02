// 管理员的只读判定。
//
// authOptional 只负责「有没有登录」，不解析网关 claims，所以它从不设置 req.user。
// 需要按管理员视角放开的只读接口（列表、详情）因此拿不到 is_admin。
// 这里按需判定：有 req.user 就直接用（authRequired 路径），没有就查一次会话。
//
// 结果按用户缓存 30 秒：一次列表请求里每行都判定会重复访问网关。
const identity = require('./identity');

const TTL_MS = 30 * 1000;
const cache = new Map();

function remember(userId, isAdmin) {
  if (cache.size >= 5000 && !cache.has(userId)) cache.delete(cache.keys().next().value);
  cache.set(userId, { isAdmin, expiresAt: Date.now() + TTL_MS });
  return isAdmin;
}

async function isAdmin(req) {
  if (req.user && typeof req.user.is_admin === 'boolean') return req.user.is_admin;
  const userId = req.userId;
  if (!userId) return false;

  // req.authSession 只有在 authRequired 或实名中间件跑过时才存在；
  // 只有 token 的只读路径要自己解一次会话。
  let session = req.authSession;
  if (!session) {
    const { verifyToken } = require('./util');
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload || payload.uid !== userId) return false;
    try {
      session = await identity.session(payload);
    } catch (_) {
      return false;
    }
    req.authSession = session;
  }

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;

  try {
    const claims = await identity.authenticatedProfile(session);
    const admin = claims.isAdmin === true || claims.role === 'admin';
    return remember(userId, admin);
  } catch (_) {
    // 网关不可达时按非管理员处理：宁可少放行，也不给普通用户管理员视角。
    return false;
  }
}

// 测试与注销流程用：改过角色后清掉缓存。
function forget(userId) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

module.exports = { isAdmin, forget };
