const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const gateway = require('../gateway');
const identity = require('../identity');
const { signToken, authRequired } = require('../util');
const { audit } = require('../audit');
const { stage } = require('../logging');

const router = express.Router();
const pendingLogins = new Map();
const loginCodes = new Map();
const huaweiChallenges = new Map();
const huaweiBindings = new Map();
const TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  for (const map of [pendingLogins, loginCodes, huaweiChallenges, huaweiBindings]) {
    for (const [key, entry] of map) if (Date.now() - entry.createdAt >= TTL_MS) map.delete(key);
  }
}, 60000).unref();

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function text(body, name, max, required = true) {
  const value = body?.[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new gateway.ApiError(400, `请填写有效的 ${name}`);
  }
  return name === 'password' ? value : value.trim();
}

function verificationFields(body) {
  return {
    captcha_id: text(body, 'captchaId', 128, false), captcha_code: text(body, 'captchaCode', 16, false),
    email_code: text(body, 'emailCode', 16, false), totp_code: text(body, 'totpCode', 32, false),
  };
}

async function loginResponse(req, res, result, action, loginType) {
  stage('qfli.create_session');
  const session = await identity.createSession(result.tokens, result.claims);
  stage('qfli.login_audit');
  await audit(req, {
    userId: session.user.id, username: result.claims.preferred_username, action, loginType,
  });
  stage('qfli.login_response');
  res.json({
    token: signToken({ uid: session.user.id, sid: session.id }),
    user: await identity.publicUser(session.user, result.claims),
  });
}

router.post('/login/requirements', async (req, res) => {
  const username = text(req.body, 'username', 255);
  const password = text(req.body, 'password', 72);
  if (Buffer.byteLength(password, 'utf8') > 72) throw new gateway.ApiError(400, '密码不能超过 72 字节');
  res.json(await gateway.loginRequirements(username, password, req));
});

router.post('/login', async (req, res) => {
  const username = text(req.body, 'username', 255);
  const password = text(req.body, 'password', 72);
  if (Buffer.byteLength(password, 'utf8') > 72) throw new gateway.ApiError(400, '密码不能超过 72 字节');
  const result = await gateway.authorize('password', { username, password, ...verificationFields(req.body) }, req);
  await loginResponse(req, res, result, 'auth.password_login', 'password');
});

router.post('/huawei', async (req, res) => {
  const code = text(req.body, 'authorizationCode', 8192);
  const result = await gateway.authorize('huawei', { code }, req);
  if (result.binding) {
    if (huaweiBindings.size >= 1000) throw new gateway.ApiError(429, '待绑定请求过多，请稍后重试');
    const bindingId = crypto.randomBytes(32).toString('base64url');
    huaweiBindings.set(bindingId, { ...result, createdAt: Date.now(), inProgress: false });
    return res.json({ bindingRequired: true, bindingId, phoneAvailable: result.phoneAvailable });
  }
  if (result.pending) {
    if (huaweiChallenges.size >= 1000) throw new gateway.ApiError(429, '登录请求过多，请稍后重试');
    const challengeId = crypto.randomBytes(32).toString('base64url');
    huaweiChallenges.set(challengeId, { ...result, createdAt: Date.now() });
    throw new gateway.ApiError(428, '请输入登录验证码', { challengeId, factor: result.pending.factor, emailMasked: result.pending.email });
  }
  await loginResponse(req, res, result, 'auth.huawei_login', 'huawei_login');
});

function huaweiBinding(body) {
  const bindingId = text(body, 'bindingId', 128);
  const entry = huaweiBindings.get(bindingId);
  if (!entry || Date.now() - entry.createdAt >= TTL_MS) {
    huaweiBindings.delete(bindingId);
    throw new gateway.ApiError(400, '绑定请求已过期，请重新发起华为登录');
  }
  if (entry.inProgress) throw new gateway.ApiError(409, '正在处理绑定请求，请稍候');
  // 没有已验证手机号的华为账号无法完成实名，不允许跳过绑定直接建号。
  // 与网关的 huawei_verified_phone_required 用同一个对外形状（contracts.md C 节）。
  if (entry.phoneAvailable === false) {
    huaweiBindings.delete(bindingId);
    throw gateway.phoneRequiredError();
  }
  entry.inProgress = true;
  return { bindingId, entry };
}

router.post('/huawei/skip', async (req, res) => {
  const { bindingId, entry } = huaweiBinding(req.body);
  try {
    const result = await gateway.skipHuawei(entry);
    huaweiBindings.delete(bindingId);
    if (result.pending) {
      if (huaweiChallenges.size >= 1000) throw new gateway.ApiError(429, '登录请求过多，请稍后重试');
      const challengeId = crypto.randomBytes(32).toString('base64url');
      huaweiChallenges.set(challengeId, { ...result, createdAt: Date.now() });
      throw new gateway.ApiError(428, '请输入登录验证码', { challengeId, factor: result.pending.factor, emailMasked: result.pending.email });
    }
    await loginResponse(req, res, result, 'auth.huawei_login', 'huawei_skip');
  } finally { entry.inProgress = false; }
});

router.post('/huawei/bind', async (req, res) => {
  const { bindingId, entry } = huaweiBinding(req.body);
  try {
    const username = text(req.body, 'username', 255);
    const password = text(req.body, 'password', 72);
    if (Buffer.byteLength(password, 'utf8') > 72) throw new gateway.ApiError(400, '密码不能超过 72 字节');
    const result = await gateway.bindHuawei(entry, { username, password, ...verificationFields(req.body) }, req);
    huaweiBindings.delete(bindingId);
    await loginResponse(req, res, result, 'auth.huawei_bind', 'huawei_bind');
  } finally { entry.inProgress = false; }
});

router.post('/huawei/complete', async (req, res) => {
  const challengeId = text(req.body, 'challengeId', 128);
  const code = text(req.body, 'code', 32);
  const entry = huaweiChallenges.get(challengeId);
  if (!entry || Date.now() - entry.createdAt >= TTL_MS) throw new gateway.ApiError(400, '验证已过期，请重新发起华为登录');
  if (entry.inProgress) throw new gateway.ApiError(409, '正在验证，请稍候');
  entry.inProgress = true;
  try {
    const result = await gateway.completeHuawei(entry, code);
    huaweiChallenges.delete(challengeId);
    await loginResponse(req, res, result, 'auth.huawei_login', 'huawei_mfa');
  } finally { entry.inProgress = false; }
});

router.get('/captcha', async (_req, res) => {
  res.json(await gateway.request(gateway.endpoint('captcha')));
});

router.post('/email-code', async (req, res) => {
  const email = text(req.body, 'email', 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new gateway.ApiError(400, '请输入有效的邮箱地址');
  res.json(await gateway.sendEmailCode(email));
});

router.post('/register', async (req, res) => {
  const username = text(req.body, 'username', 24);
  const email = text(req.body, 'email', 254);
  const password = text(req.body, 'password', 72);
  const emailCode = text(req.body, 'emailCode', 6);
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new gateway.ApiError(400, '用户名需为 3-24 位字母、数字或下划线');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(emailCode)) throw new gateway.ApiError(400, '请输入有效的邮箱和 6 位验证码');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new gateway.ApiError(400, '密码不能超过 72 字节');
  const result = await gateway.register({
    username, email, password, confirm_password: password,
    name: text(req.body, 'nickname', 64, false) || username, ...verificationFields(req.body), email_code: emailCode,
  });
  await audit(req, { username, action: 'auth.register', loginType: 'register' });
  res.json(result);
});

router.post('/logout', authRequired, async (req, res) => {
  await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(req.authSession.id);
  await audit(req, {
    userId: req.userId, username: req.user.username, action: 'auth.logout', loginType: 'logout',
  });
  res.json({ ok: true });
});

router.get('/oauth2/url', (req, res) => {
  const cfg = gateway.config(req);
  const { verifier, challenge } = gateway.pkce();
  const state = crypto.randomBytes(32).toString('base64url');
  if (pendingLogins.size >= 1000) throw new gateway.ApiError(429, '登录请求过多，请稍后重试');
  pendingLogins.set(state, { cfg, verifier, createdAt: Date.now() });
  const url = new URL(gateway.endpoint('authorize'));
  for (const [key, value] of Object.entries({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: cfg.scope,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })) url.searchParams.set(key, value);
  res.json({ url: url.toString(), state });
});

router.get('/oauth2/callback', async (req, res) => {
  const state = text(req.query, 'state', 128);
  const pending = pendingLogins.get(state);
  if (!pending || Date.now() - pending.createdAt >= TTL_MS) throw new gateway.ApiError(400, '登录会话已失效');
  pendingLogins.delete(state);
  if (req.query.error) throw new gateway.ApiError(400, '网关拒绝授权，请重新登录');
  const code = text(req.query, 'code', 8192);
  const tokens = await gateway.exchange(code, pending.verifier, pending.cfg);
  const claims = await gateway.userinfo(tokens.access_token);
  const loginCode = crypto.randomBytes(16).toString('hex');
  loginCodes.set(loginCode, { tokens, claims, createdAt: Date.now() });
  res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录成功</title><body><h2>登录成功</h2><p>请回到 QFLIStudio+ 输入登录码：</p><code>${loginCode}</code><p>5 分钟内有效</p></body></html>`);
});

router.post('/oauth2/complete', async (req, res) => {
  const code = text(req.body, 'code', 128);
  const entry = loginCodes.get(code);
  if (!entry || Date.now() - entry.createdAt >= TTL_MS) throw new gateway.ApiError(400, '登录码无效或已过期');
  loginCodes.delete(code);
  entry.claims = await gateway.userinfo(entry.tokens.access_token);
  await loginResponse(req, res, entry, 'auth.oauth2_login', 'oauth2');
});

module.exports = router;
