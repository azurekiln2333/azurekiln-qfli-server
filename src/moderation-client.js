// W1 公共审核服务的传输层（QFLI 侧）。业务只经 moderation-service 调用本文件。
// 契约唯一来源：D:/MyNewProjects/azurekiln-moderation/README.md（v1）。
// 审核判定（规范化、词库、IP 规则、人工队列）全部在 W1 服务里，本文件只做参数整形与错误映射。
//
// 传输实现：
//   1. 测试注入（__setTransport）—— 只给单测用，生产不会走到
//   2. @azurekiln/moderation-client（vendor/ 下的 tgz，任务书要求审核只通过 SDK 接入）
//
// SDK 缺失或未配置时抛 ModerationUnavailableError，由上层按 failClosed 处理。
// 管理接口（词库、IP 规则、场景开关）：SDK 0.1.0 没有暴露这些方法，
// 因此用同一套 X-App-Id + Bearer 契约直接调用，凭据仍是服务端的 MODERATION_ADMIN_KEY。

const SERVICE_NAME = '@azurekiln/moderation-client';
const UNAVAILABLE_MESSAGE = '审核服务暂不可用';
const CHECK_DECISIONS = new Set(['pass', 'block', 'review']);

class ModerationUnavailableError extends Error {
  constructor(message = UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'ModerationUnavailableError';
    this.code = 'moderation.unavailable';
    this.status = 503;
  }
}

let transport = null;      // 测试注入的实现
let sdkClient = null;      // SDK 实例（惰性创建）
let sdkLoaded = false;

function settings() {
  return {
    baseUrl: (process.env.MODERATION_BASE_URL || '').trim().replace(/\/+$/, ''),
    appId: (process.env.MODERATION_APP_ID || '').trim(),
    apiKey: (process.env.MODERATION_API_KEY || '').trim(),
    // /v1/admin/* 需要 app 自己的 admin key。
    adminKey: (process.env.MODERATION_ADMIN_KEY || '').trim(),
    timeoutMs: Math.min(30000, Math.max(500, Number(process.env.MODERATION_TIMEOUT_MS) || 3000)),
  };
}

function configured() {
  const cfg = settings();
  return Boolean(cfg.baseUrl && cfg.appId && cfg.apiKey);
}

function loadSdk() {
  if (sdkLoaded) return sdkClient;
  sdkLoaded = true;
  const cfg = settings();
  if (!configured()) return null;
  try {
    const { ModerationClient } = require(SERVICE_NAME);
    sdkClient = new ModerationClient({
      baseUrl: cfg.baseUrl,
      appId: cfg.appId,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      failClosed: true,
    });
  } catch (_) {
    sdkClient = null;
  }
  return sdkClient;
}

// SDK 校验过的检查结果再做一次形状收敛，保证上层只看到三种 decision。
function validateCheck(result) {
  if (!result || typeof result !== 'object' || !CHECK_DECISIONS.has(result.decision)) {
    throw new ModerationUnavailableError();
  }
  return {
    id: typeof result.id === 'string' ? result.id : undefined,
    decision: result.decision,
    categories: Array.isArray(result.categories)
      ? result.categories.filter((c) => typeof c === 'string').slice(0, 16) : [],
    hits: Array.isArray(result.hits) ? result.hits.slice(0, 50) : [],
    reviewId: typeof result.reviewId === 'string' ? result.reviewId : undefined,
  };
}

const CHECK_OPERATIONS = new Set(['checkText', 'checkIp', 'checkImage']);

async function call(operation, payload) {
  if (transport) return transport(operation, payload);
  const sdk = loadSdk();
  if (!sdk) throw new ModerationUnavailableError();
  if (CHECK_OPERATIONS.has(operation)) {
    let result;
    try {
      result = await sdk[operation](checkInput(operation, payload));
    } catch (err) {
      // SDK 的 failClosed 已经把不可用统一成 moderation.unavailable，这里只做归一。
      if (err && (err.code === 'moderation.unavailable' || err.name === 'ModerationUnavailableError')) {
        throw new ModerationUnavailableError();
      }
      // 4xx 是契约错误（如参数非法），对业务同样意味着无法确认审核通过，按不可用处理。
      throw new ModerationUnavailableError();
    }
    return validateCheck(result);
  }
  if (operation === 'submitReport') return sdk.submitReport(payload);
  return adminCall(operation, payload || {});
}

// SDK 只接受契约里的字段，多余字段不要透传。
function checkInput(operation, payload) {
  if (operation === 'checkText') {
    return trim({
      scene: payload.scene, text: payload.text, userId: payload.userId,
      ip: payload.ip, targetType: payload.targetType, targetId: payload.targetId,
    });
  }
  if (operation === 'checkImage') {
    return trim({
      scene: payload.scene, imageUrl: payload.imageUrl, userId: payload.userId,
      targetType: payload.targetType, targetId: payload.targetId,
    });
  }
  return trim({ scene: payload.scene, ip: payload.ip, userId: payload.userId });
}

function trim(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// 管理接口走 admin key。SDK 0.1.0 未覆盖，等 SDK 补齐后替换这一层即可，调用方签名不变。
async function adminCall(operation, payload) {
  const cfg = settings();
  if (!cfg.baseUrl || !cfg.appId || !cfg.adminKey) throw new ModerationUnavailableError();
  const [method, path, body] = adminHttpCall(operation, payload);
  let endpoint;
  try {
    endpoint = new URL(`${cfg.baseUrl}${path}`);
  } catch (_) {
    throw new ModerationUnavailableError();
  }
  if (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new ModerationUnavailableError();
  }
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-app-id': cfg.appId,
        authorization: `Bearer ${cfg.adminKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (_) {
    throw new ModerationUnavailableError();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new ModerationUnavailableError();
    if (typeof data?.requestId === 'string') error.requestId = data.requestId.slice(0, 64);
    throw error;
  }
  return data;
}

function adminHttpCall(operation, payload) {
  switch (operation) {
    case 'listKeywords':
      return ['GET', `/v1/admin/keywords${query({ limit: payload.limit, offset: payload.offset, category: payload.category })}`, undefined];
    case 'createKeyword':
      return ['POST', '/v1/admin/keywords', trim({ word: payload.word, category: payload.category, enabled: payload.enabled })];
    case 'updateKeyword':
      return ['PATCH', `/v1/admin/keywords/${encodeURIComponent(payload.id)}`, payload.patch];
    case 'deleteKeyword':
      return ['DELETE', `/v1/admin/keywords/${encodeURIComponent(payload.id)}`, undefined];
    case 'listIpRules':
      return ['GET', `/v1/admin/ip-rules${query({ limit: payload.limit, offset: payload.offset })}`, undefined];
    case 'createIpRule':
      return ['POST', '/v1/admin/ip-rules', payload.rule];
    case 'updateIpRule':
      return ['PATCH', `/v1/admin/ip-rules/${encodeURIComponent(payload.id)}`, payload.patch];
    case 'deleteIpRule':
      return ['DELETE', `/v1/admin/ip-rules/${encodeURIComponent(payload.id)}`, undefined];
    case 'listScenes':
      return ['GET', '/v1/admin/scenes', undefined];
    case 'putScene':
      return ['PUT', `/v1/admin/scenes/${encodeURIComponent(payload.scene)}`, { preReview: payload.preReview }];
    default:
      throw new ModerationUnavailableError();
  }
}

function __setTransport(fn) {
  transport = fn;
}

module.exports = {
  SERVICE_NAME,
  UNAVAILABLE_MESSAGE,
  ModerationUnavailableError,
  configured,
  settings,
  validateCheck,
  call,
  __setTransport,
};
