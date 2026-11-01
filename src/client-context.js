// 身份侧公共件：客户端平台、实名门槛。
//
// 代理约定：只信任反向代理覆盖写入的 X-Real-IP / X-Real-Port（见 src/client-ip.js）。
// X-Forwarded-For 由客户端可控，一律不读；也不启用 Express trust proxy。
const { log } = require('./logging');

// util 反向依赖本模块（共用令牌解析），因此延迟加载，避免循环依赖时读到空模块。
const util = () => require('./util');
const identity = () => require('./identity');

// 允许的客户端平台名；版本号在 <name>/<version> 里，只存名字供统计。
const PLATFORMS = new Set([
  'harmonyos-app', 'android-app', 'ios-app', 'windows-app',
  'macos-app', 'linux-app', 'web',
]);
const MAX_PLATFORM_HEADER = 64;

function clientPlatform(req) {
  const raw = req.headers?.['x-client-platform'];
  if (typeof raw !== 'string' || raw.length > MAX_PLATFORM_HEADER) return null;
  const name = raw.split('/')[0].trim().toLowerCase();
  return PLATFORMS.has(name) ? name : null;
}

function address(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('[') && candidate.includes(']')) {
    candidate = candidate.slice(1, candidate.indexOf(']'));
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  if (net.isIP(candidate)) return candidate;
  const mapped = candidate.startsWith('::ffff:') ? candidate.slice(7) : null;
  return mapped && net.isIP(mapped) ? mapped : null;
}

function clientIp(req) {
  return address(req.headers?.['x-real-ip']) || address(req.socket?.remoteAddress) || null;
}

// 网关 claims 里的手机号只有“已验证”才算实名。
// 网关不返回 phone_number_verified 时不当作未验证（兼容旧网关）。
function hasVerifiedPhone(claims) {
  if (!claims || typeof claims !== 'object') return false;
  if (claims.phone_verified === true) return true;
  const phone = claims.phone_number;
  if (typeof phone !== 'string' || !phone.trim()) return false;
  return claims.phone_number_verified !== false;
}

// 需要已验证手机号才能使用的挂载前缀（本地教程不走服务端，不受影响）。
const GATED_PREFIXES = [
  '/api/zones', '/api/tags', '/api/posts', '/api/comments', '/api/reports',
  '/api/cloud', '/api/terminal', '/api/sql', '/api/ai',
];

function gatedPath(path) {
  return GATED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

// 先解析令牌再把会话挂到 req，下游 authRequired 复用，避免同一请求两次访问网关。
async function loadSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? util().verifyToken(token) : null;
  req.userId = null;
  if (!payload) return false;
  try {
    const session = await identity().session(payload);
    req.authSession = session;
    req.gatewayClaims = await identity().authenticatedProfile(session);
    req.userId = payload.uid;
    return true;
  } catch (err) {
    // 网关不可用不等于未实名；按 503 交给下游，避免误报 realname.required。
    if (err.status === 401) return false;
    throw err;
  }
}

function deny(req, res) {
  log('realname.required', { path: req.requestPath, method: req.method });
  res.status(403).json({
    error: '请先绑定手机号',
    errorKey: 'realname.required',
    message: '请使用已绑定手机号的华为账号登录',
  });
}

async function realnameRequired(req, res, next) {
  if (req.method === 'OPTIONS' || !gatedPath(req.path)) return next();
  // 已由本中间件解析过（同一请求重复挂载）时不重复访问网关。
  if (req.gatewayClaims) {
    if (hasVerifiedPhone(req.gatewayClaims)) return next();
    return deny(req, res);
  }
  const signedIn = await loadSession(req);
  if (!signedIn) return next();
  if (hasVerifiedPhone(req.gatewayClaims)) return next();
  deny(req, res);
}

module.exports = {
  PLATFORMS,
  GATED_PREFIXES,
  clientPlatform,
  hasVerifiedPhone,
  gatedPath,
  realnameRequired,
  loadSession,
};
