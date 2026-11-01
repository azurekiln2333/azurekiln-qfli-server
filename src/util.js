// 认证工具：HMAC-SHA256 JWT（零第三方依赖）。
// 账号与密码由 azurekiln-oauth2 登录网关管理，本服务不保存密码。
const crypto = require('node:crypto');
const identity = require('./identity');
const { isUserId } = require('./user-id');

const JWT_SECRET =
  process.env.QFLI_JWT_SECRET || 'qfli-dev-secret-change-in-production';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 天

// ---- JWT (HS256) ----

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const sig = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest();
  const actual = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return null;
  }
  try {
    const metadata = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (metadata.alg !== 'HS256' || metadata.typ !== 'JWT') return null;
    const payload = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    );
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) ||
        !isUserId(payload.uid) || typeof payload.sid !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- 中间件 ----

async function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  req.userId = null;
  if (payload) {
    try {
      await identity.session(payload);
      req.userId = payload.uid;
    } catch (_) {}
  }
  next();
}

async function authRequired(req, res, next) {
  // 实名中间件已解析过同一请求的会话时直接复用，避免一次请求两次访问网关。
  if (req.authSession && req.gatewayClaims && req.userId) {
    req.user = {
      id: req.userId, gateway_user_id: req.authSession.gateway_user_id,
      username: req.gatewayClaims.preferred_username || req.gatewayClaims.username || '',
      is_admin: req.gatewayClaims.isAdmin === true || req.gatewayClaims.role === 'admin',
    };
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.authSession = await identity.session(payload);
  req.gatewayClaims = await identity.authenticatedProfile(req.authSession);
  req.userId = payload.uid;
  req.user = {
    id: req.userId, gateway_user_id: req.authSession.gateway_user_id,
    username: req.gatewayClaims.preferred_username || req.gatewayClaims.username || '',
    is_admin: req.gatewayClaims.isAdmin === true || req.gatewayClaims.role === 'admin',
  };
  next();
}

// ---- 公共用户视图 ----

module.exports = {
  signToken,
  verifyToken,
  authOptional,
  authRequired,
  publicUser: identity.publicUser,
};
