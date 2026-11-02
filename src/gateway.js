const crypto = require('node:crypto');
const { log, stage } = require('./logging');

class ApiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const paths = {
  authorize: '/oauth2/authorize',
  token: '/oauth2/token',
  userinfo: '/oauth2/userinfo',
  huaweiAuthorize: '/api/v1/auth/oauth/huawei/quick-login',
  huaweiBind: '/api/v1/auth/oauth/huawei/bind',
  huaweiSkip: '/api/v1/auth/oauth/huawei/skip',
  register: '/oauth2/register',
  emailCode: '/api/email-verification/send',
  captcha: '/api/captcha',
  profile: '/oauth2/profile',
  publicProfile: '/oauth2/public-profile/{id}',
  mfa: '/api/v1/auth/oauth/oidc/complete',
};

function endpoint(name) {
  return required('AZK_OAUTH2_BASE_URL').replace(/\/+$/, '') + paths[name];
}

function providerKey(channel) {
  const prefix = (process.env.AZK_PROVIDER || '').trim().toLowerCase();
  if (!prefix) return undefined;
  const key = `${prefix}_${channel}`;
  if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(key)) {
    throw new ApiError(503, 'AZK_PROVIDER 拼接后的标识需为 2-128 位字母、数字、下划线或连字符');
  }
  return key;
}

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new ApiError(503, `登录网关未配置：${name}`);
  return value;
}

// 华为账号没有已验证手机号时，网关在 quick-login（不签发 binding_token）
// 以及使用旧 token 的 skip/bind 上返回 403 error=huawei_verified_phone_required。
// 对外只暴露 contracts.md C 节的统一形状：403 + errorKey=huawei.phone_required。
const HUAWEI_PHONE_REQUIRED = 'huawei_verified_phone_required';
const HUAWEI_PHONE_REQUIRED_MESSAGE = '请使用已绑定手机号的华为账号';

function phoneRequiredError() {
  return new ApiError(403, HUAWEI_PHONE_REQUIRED_MESSAGE, {
    errorKey: 'huawei.phone_required',
    message: HUAWEI_PHONE_REQUIRED_MESSAGE,
  });
}

function isPhoneRequiredError(data) {
  return data?.error === HUAWEI_PHONE_REQUIRED || data?.error_key === HUAWEI_PHONE_REQUIRED;
}

function config(req) {
  const base = (process.env.PUBLIC_BASE_URL || (req ? `${req.protocol}://${req.get('host')}` : '')).replace(/\/+$/, '');
  return {
    clientId: required('AZK_OAUTH2_CLIENT_ID'),
    clientSecret: required('AZK_OAUTH2_CLIENT_SECRET'),
    scope: process.env.AZK_OAUTH2_SCOPE || 'openid profile email phone roles offline_access',
    redirectUri: process.env.AZK_OAUTH2_REDIRECT_URI || `${base}/api/auth/oauth2/callback`,
  };
}

async function request(url, options = {}) {
  const { stage: operation = 'gateway.request', ...fetchOptions } = options;
  stage(operation);
  const started = Date.now();
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new ApiError(503, '登录网关地址配置无效'); }
  if (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new ApiError(503, '登录网关必须使用 HTTPS（本机开发除外）');
  }
  try {
    const response = await fetch(endpoint, {
      ...fetchOptions,
      headers: { origin: endpoint.origin, ...fetchOptions.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    log('gateway.response', { endpoint: `${endpoint.origin}${endpoint.pathname}`,
      status: response.status, durationMs: Date.now() - started,
      contentType: response.headers.get('content-type'),
      errorKey: typeof data?.error_key === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(data.error_key) ? data.error_key : undefined,
      errorCode: typeof data?.error === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(data.error) ? data.error : undefined,
    }, response.ok ? 'info' : 'error');
    if (!response.ok) {
      // 网关的“华为账号缺少已核验手机号”统一转换为 huawei.phone_required。
      if (isPhoneRequiredError(data)) throw phoneRequiredError();
      const status = [400, 401, 403, 404, 409, 422, 428, 429, 503].includes(response.status) ? response.status : 502;
      const message = typeof data?.error_description === 'string' ? data.error_description : data?.error;
      throw new ApiError(status, typeof message === 'string' ? message.slice(0, 200) : '登录网关请求失败', { errorKey: data?.error_key });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(502, '登录网关响应格式无效');
    Object.defineProperty(data, '_cookies', { value: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') });
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log('gateway.connection_failed', { endpoint: `${endpoint.origin}${endpoint.pathname}`,
      durationMs: Date.now() - started, errorType: err.name,
      networkCode: err.cause?.code,
    }, 'error');
    throw new ApiError(502, '无法连接登录网关，请稍后重试');
  }
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function subject(claims) {
  const sub = claims?.sub;
  if ((typeof sub !== 'string' && typeof sub !== 'number') ||
      (typeof sub === 'number' && !Number.isSafeInteger(sub)) ||
      !String(sub).trim() || String(sub).length > 128) {
    throw new ApiError(502, '网关用户信息缺少有效的 sub', { errorKey: 'gateway.subject_invalid' });
  }
  return String(sub);
}

async function exchange(code, verifier, cfg) {
  return request(endpoint('token'), {
    stage: 'gateway.token_exchange',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri,
    }),
  });
}

function authorizationCode(result, cfg, state) {
  stage('gateway.authorization_response');
  let redirect;
  try { redirect = new URL(result.redirect); } catch { throw new ApiError(502, '网关未返回授权跳转地址', { errorKey: 'gateway.redirect_missing' }); }
  const expected = new URL(cfg.redirectUri);
  if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname ||
      redirect.searchParams.get('state') !== state || !redirect.searchParams.get('code')) {
    throw new ApiError(502, '网关返回的授权码、回调地址或 state 无效', { errorKey: 'gateway.redirect_invalid' });
  }
  return redirect.searchParams.get('code');
}

async function authorize(kind, input, req) {
  stage(`gateway.${kind}_config`);
  if (!['password', 'huawei'].includes(kind)) throw new ApiError(400, '此登录渠道尚未接入');
  const cfg = config(req);
  const provider = kind === 'password' ? undefined : providerKey(kind);
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(32).toString('base64url');
  const params = {
    client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirectUri, scope: cfg.scope,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  };
  const result = await request(endpoint(kind === 'huawei' ? 'huaweiAuthorize' : 'authorize'), {
    stage: `gateway.${kind}_authorize`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...input, ...params,
      ...(provider ? { provider } : {}),
    }),
  });
  if (result.require_email_code || result.require_totp) {
    throw new ApiError(428, result.message || '请输入登录验证码', {
      factor: result.require_totp ? 'totp' : 'email', emailMasked: result.email_masked,
    });
  }
  if (result.binding_required) {
    if (typeof result.binding_token !== 'string' || !result.binding_token) throw new ApiError(502, '网关未返回华为绑定凭据');
    return { binding: result.binding_token, phoneAvailable: result.phone_available === true, cfg, params, verifier, state };
  }
  if (result.mfa_required) return { pending: result, cfg, params, verifier, state };
  const tokens = await exchange(authorizationCode(result, cfg, state), verifier, cfg);
  return { tokens, claims: await userinfo(tokens.access_token) };
}

async function skipHuawei(binding) {
  const result = await request(endpoint('huaweiSkip'), {
    stage: 'gateway.huawei_skip', method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...binding.params, binding_token: binding.binding }),
  });
  if (result.mfa_required) return { pending: result, ...binding };
  const tokens = await exchange(authorizationCode(result, binding.cfg, binding.state), binding.verifier, binding.cfg);
  return { tokens, claims: await userinfo(tokens.access_token) };
}

async function bindHuawei(binding, input, req) {
  const login = await authorize('password', input, req);
  if (login.pending || login.binding) throw new ApiError(502, '网关未完成已有账号验证');
  await request(endpoint('huaweiBind'), {
    stage: 'gateway.huawei_bind', method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.tokens.access_token}` },
    body: JSON.stringify({ binding_token: binding.binding }),
  });
  return login;
}

async function loginRequirements(username, password, req) {
  stage('gateway.password_config');
  const cfg = config(req);
  const result = await request(endpoint('authorize'), {
    stage: 'gateway.password_requirements',
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, check_verification: true,
      client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
      scope: cfg.scope, code_challenge: pkce().challenge, code_challenge_method: 'S256' }),
  });
  if (result.verification_required !== true ||
      !['', 'totp', 'email'].includes(result.factor) || typeof result.captcha_required !== 'boolean') {
    throw new ApiError(502, '登录网关尚未支持验证预检查，请更新网关');
  }
  return { factor: result.factor || null, captchaRequired: result.captcha_required, emailMasked: result.email_masked };
}

async function completeHuawei(pending, code) {
  const result = await request(endpoint('mfa'), {
    stage: 'gateway.huawei_mfa',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Oidc-Pending': pending.pending.pending_token },
    body: JSON.stringify({ code }),
  });
  // Native MFA returns the OAuth redirect in JSON without a browser session cookie.
  const tokens = await exchange(authorizationCode(result, pending.cfg, pending.state), pending.verifier, pending.cfg);
  return { tokens, claims: await userinfo(tokens.access_token) };
}

async function userinfo(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) throw new ApiError(502, '网关未返回 access_token', { errorKey: 'gateway.token_missing' });
  const claims = await request(endpoint('userinfo'), {
    stage: 'gateway.userinfo',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  subject(claims);
  return claims;
}

async function refresh(refreshToken) {
  const cfg = config();
  return request(endpoint('token'), {
    stage: 'gateway.refresh',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
    }),
  });
}

async function register(input) {
  const result = await request(endpoint('register'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (typeof result.redirect !== 'string') throw new ApiError(502, '网关注册响应无效');
  return { message: '邮箱验证成功，注册完成，请返回登录。' };
}

async function sendEmailCode(email) {
  const result = await request(endpoint('emailCode'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'register' }),
  });
  if (result.deliveryMode !== 'smtp') throw new ApiError(502, '网关未确认发送邮件，请检查 SMTP 设置');
  return { message: '验证码已发送', retryAfter: 60 };
}

async function updateProfile(accessToken, input) {
  await request(endpoint('profile'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
  return userinfo(accessToken);
}

async function publicProfile(gatewayUserId) {
  const cfg = config();
  const template = endpoint('publicProfile');
  const claims = await request(template.replace('{id}', encodeURIComponent(gatewayUserId)), {
    headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}` },
  });
  if (subject(claims) !== gatewayUserId) throw new ApiError(502, '网关返回的用户身份不匹配');
  return claims;
}

module.exports = { ApiError, required, endpoint, config, request, pkce, subject, exchange, authorize, loginRequirements, completeHuawei, skipHuawei, bindHuawei, userinfo, refresh, register, sendEmailCode, updateProfile, publicProfile, phoneRequiredError, isPhoneRequiredError, HUAWEI_PHONE_REQUIRED_MESSAGE };
