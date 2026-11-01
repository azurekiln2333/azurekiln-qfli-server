const crypto = require('node:crypto');
const gateway = require('./gateway');
const { createUserId, isUserId } = require('./user-id');

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const secret = process.env.QFLI_JWT_SECRET || 'qfli-dev-secret-change-in-production';
if (process.env.NODE_ENV === 'production' && (secret.length < 32 || secret === 'qfli-dev-secret-change-in-production')) {
  throw new Error('生产环境必须配置至少 32 位的 QFLI_JWT_SECRET');
}
const db = require('./db');
const { userGrowth } = require('./growth');
const key = crypto.createHash('sha256').update(`qfli-gateway-credentials:${secret}`).digest();
const refreshing = new Map();
const publicProfiles = new Map();
const loadingProfiles = new Map();

function encrypt(credentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const content = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
}

function decrypt(value) {
  try {
    const content = Buffer.from(value, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, content.subarray(0, 12));
    cipher.setAuthTag(content.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(content.subarray(28)), cipher.final()]).toString('utf8'));
  } catch { throw new gateway.ApiError(401, '登录凭据已失效，请重新登录'); }
}

function accessExpiry(tokens) {
  const seconds = Number(tokens.expires_in);
  return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
}

async function ensureUser(claims) {
  const sub = gateway.subject(claims);
  let user = await db.prepare('SELECT * FROM users WHERE gateway_user_id = ?').get(sub);
  if (!user) {
    try {
      await db.prepare('INSERT INTO users (id, gateway_user_id) VALUES (?, ?)').run(createUserId(), sub);
    } catch (err) {
      user = await db.prepare('SELECT * FROM users WHERE gateway_user_id = ?').get(sub);
      if (!user) throw err;
    }
    user ||= await db.prepare('SELECT * FROM users WHERE gateway_user_id = ?').get(sub);
  }
  await db.prepare(db.driver === 'mysql'
    ? 'INSERT IGNORE INTO user_state (user_id) VALUES (?)'
    : 'INSERT OR IGNORE INTO user_state (user_id) VALUES (?)').run(user.id);
  rememberProfile(sub, claims);
  return user;
}

async function createSession(tokens, claims) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new gateway.ApiError(502, '网关未返回访问令牌');
  const user = await ensureUser(claims);
  const id = crypto.randomBytes(32).toString('base64url');
  await db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  await db.prepare(`INSERT INTO auth_sessions
    (id, user_id, credentials, access_expires_at, expires_at) VALUES (?, ?, ?, ?, ?)`).run(
    id, user.id, encrypt({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
    accessExpiry(tokens), Date.now() + SESSION_TTL_MS,
  );
  return { id, user };
}

async function session(payload) {
  if (!payload?.sid || !isUserId(payload.uid)) throw new gateway.ApiError(401, '请重新登录');
  const row = await db.prepare(`SELECT s.*, u.gateway_user_id FROM auth_sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?`).get(payload.sid, payload.uid);
  if (!row || Number(row.expires_at) <= Date.now() || !row.gateway_user_id) throw new gateway.ApiError(401, '登录已过期，请重新登录');
  return row;
}

async function accessToken(row) {
  const credentials = decrypt(row.credentials);
  if (Number(row.access_expires_at) > Date.now() + 30000) return credentials.access_token;
  if (!refreshing.has(row.id)) {
    const refresh = (async () => {
      // Re-read after acquiring the in-process lock; another request may have rotated the token.
      const current = await db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(row.id);
      if (!current) throw new gateway.ApiError(401, '请重新登录');
      const old = decrypt(current.credentials);
      if (Number(current.access_expires_at) > Date.now() + 30000) return old.access_token;
      if (!old.refresh_token) {
        if (Number(current.access_expires_at) > Date.now()) return old.access_token;
        throw new gateway.ApiError(401, '网关登录已过期，请重新登录');
      }
      let tokens;
      try { tokens = await gateway.refresh(old.refresh_token); } catch (err) {
        if ([400, 401, 403].includes(err.status)) {
          await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(row.id);
          throw new gateway.ApiError(401, '网关登录已失效，请重新登录');
        }
        throw err;
      }
      const claims = await gateway.userinfo(tokens.access_token);
      if (gateway.subject(claims) !== row.gateway_user_id) throw new gateway.ApiError(502, '网关刷新后的身份不匹配');
      await db.prepare('UPDATE auth_sessions SET credentials = ?, access_expires_at = ? WHERE id = ?').run(
        encrypt({ access_token: tokens.access_token, refresh_token: tokens.refresh_token || old.refresh_token }), accessExpiry(tokens), row.id,
      );
      return tokens.access_token;
    })().finally(() => refreshing.delete(row.id));
    refreshing.set(row.id, refresh);
  }
  return refreshing.get(row.id);
}

async function authenticatedProfile(row) {
  const token = await accessToken(row);
  let claims;
  try { claims = await gateway.userinfo(token); } catch (err) {
    if ([401, 403, 404].includes(err.status)) {
      await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(row.id);
      throw new gateway.ApiError(401, '网关登录已失效，请重新登录');
    }
    throw err;
  }
  if (gateway.subject(claims) !== row.gateway_user_id) throw new gateway.ApiError(502, '网关用户身份不匹配');
  rememberProfile(row.gateway_user_id, claims);
  return claims;
}

function profileFields(claims = {}) {
  return {
    username: claims.preferred_username || claims.username || '',
    nickname: claims.nickname || claims.name || claims.preferred_username || '',
    bio: claims.description || '',
    avatarColor: /^#[0-9a-f]{6}$/i.test(claims.avatarColor || '') ? claims.avatarColor : '#2196F3',
    avatarUrl: claims.picture || '',
    provider: 'azk',
  };
}

function rememberProfile(sub, claims) {
  if (publicProfiles.size >= 1000 && !publicProfiles.has(sub)) publicProfiles.delete(publicProfiles.keys().next().value);
  publicProfiles.set(sub, { profile: profileFields(claims), expiresAt: Date.now() + 60000 });
}

async function author(userId, sub) {
  const fallback = { id: userId, username: '', nickname: `用户 ${userId}`, avatarColor: '#2196F3' };
  if (!sub) return fallback;
  const cached = publicProfiles.get(sub);
  if (cached?.expiresAt > Date.now()) return { ...fallback, ...cached.profile };
  if (!loadingProfiles.has(sub)) {
    loadingProfiles.set(sub, gateway.publicProfile(sub).then((claims) => {
      rememberProfile(sub, claims);
      return { ...fallback, ...profileFields(claims) };
    }).catch(() => {
      if (publicProfiles.size >= 1000 && !publicProfiles.has(sub)) publicProfiles.delete(publicProfiles.keys().next().value);
      publicProfiles.set(sub, { profile: cached?.profile || {}, expiresAt: Date.now() + 10000 });
      if (cached) return { ...fallback, ...cached.profile };
      return fallback;
    }).finally(() => loadingProfiles.delete(sub)));
  }
  return loadingProfiles.get(sub);
}

async function publicUser(user, claims) {
  const state = await db.prepare('SELECT * FROM user_state WHERE user_id = ?').get(user.id);
  const current = new Date();
  const previous = new Date(current.getTime() - 86400000);
  const date = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const streak = state && [date(current), date(previous)].includes(state.last_checkin_date)
    ? state.checkin_streak : 0;
  return {
    id: user.id, gatewayUserId: user.gateway_user_id, ...profileFields(claims),
    email: claims.email || '', emailVerified: claims.email_verified === true,
    isAdmin: claims.isAdmin === true || claims.role === 'admin',
    points: state?.points || 0, checkinStreak: streak, createdAt: state?.created_at,
    growth: await userGrowth(user.id),
  };
}

module.exports = { createSession, session, accessToken, authenticatedProfile, publicUser, author, rememberProfile };
