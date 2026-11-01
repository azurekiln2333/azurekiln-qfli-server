// W1 公共审核服务的传输层（QFLI 侧）。业务只经 moderation-service 调用本文件。
// 契约唯一来源：D:/MyNewProjects/azurekiln-moderation/README.md（v1）。
// 判定逻辑（规范化、词库、IP 规则、企业策略）全部在 W1，本文件只做契约映射与超时。
//
// 三种传输实现，优先级从高到低：
//   1. 测试注入（__setTransport）
//   2. 已安装 @azurekiln/moderation-client（W1 packages/client，见 README 的 Node SDK contract）
//   3. MODERATION_BASE_URL 直连 HTTP（同一契约，作为 SDK 未就绪前的等价实现）
//
// 未配置且未安装时抛 ModerationUnavailableError，由上层按 failClosed 处理。

const SERVICE_NAME = '@azurekiln/moderation-client';
const UNAVAILABLE_MESSAGE = '审核服务暂不可用';

class ModerationUnavailableError extends Error {
  constructor(message = UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'ModerationUnavailableError';
    this.code = 'moderation.unavailable';
    this.status = 503;
  }
}

const CHECK_DECISIONS = new Set(['pass', 'block', 'review']);

let transport = null;      // 测试注入的实现
let sdkClient = null;      // W1 SDK 实例（惰性加载）
let sdkLoaded = false;

function settings() {
  return {
    baseUrl: (process.env.MODERATION_BASE_URL || '').trim().replace(/\/+$/, ''),
    appId: (process.env.MODERATION_APP_ID || '').trim(),
    // README 用 MODERATION_API_KEY；保留 MODERATION_APP_SECRET 作为旧名兼容。
    apiKey: (process.env.MODERATION_API_KEY || process.env.MODERATION_APP_SECRET || '').trim(),
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
    // 可选依赖：未安装时走直连 HTTP（同契约）。
    // eslint-disable-next-line import/no-dynamic-require
    const mod = require(SERVICE_NAME);
    sdkClient = new mod.ModerationClient({
      baseUrl: cfg.baseUrl,
      appId: cfg.appId,
      apiKey: cfg.apiKey,
      adminKey: cfg.adminKey || undefined,
      timeoutMs: cfg.timeoutMs,
      failClosed: true,
    });
  } catch (_) {
    sdkClient = null;
  }
  return sdkClient;
}

async function httpRequest(method, path, body, { admin = false } = {}) {
  const cfg = settings();
  if (!cfg.baseUrl || !cfg.appId || !cfg.apiKey) throw new ModerationUnavailableError();
  if (admin && !cfg.adminKey) throw new ModerationUnavailableError('审核管理接口未配置');
  let endpoint;
  try {
    endpoint = new URL(`${cfg.baseUrl}${path}`);
  } catch (_) {
    throw new ModerationUnavailableError();
  }
  // 与网关一致的传输约束：只允许证书有效的 HTTPS（本机开发可用回环 HTTP）。
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
        authorization: `Bearer ${admin ? cfg.adminKey : cfg.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (_) {
    throw new ModerationUnavailableError();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // 契约：4xx 是契约错误，503 是依赖不可用。业务侧一律当作不可用（failClosed），
    // 但把状态码带上，便于日志区分。
    const error = new ModerationUnavailableError();
    error.status = response.status;
    error.remoteError = typeof data?.error === 'string' ? data.error.slice(0, 64) : undefined;
    error.requestId = typeof data?.requestId === 'string' ? data.requestId.slice(0, 64) : undefined;
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ModerationUnavailableError();
  }
  return data;
}

// 检查结果必须带合法 decision，否则按不可用处理（README：invalid check responses）。
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

async function call(operation, payload) {
  if (transport) return transport(operation, payload);
  const sdk = loadSdk();
  if (sdk && typeof sdk[operation] === 'function') {
    let result;
    try {
      result = await sdk[operation](payload);
    } catch (err) {
      if (err && (err.code === 'moderation.unavailable' || err.name === 'ModerationUnavailableError')) {
        throw new ModerationUnavailableError();
      }
      throw err;
    }
    if (operation === 'checkText' || operation === 'checkIp' || operation === 'checkImage') {
      return validateCheck(result);
    }
    return result;
  }
  const [method, path, body, options] = httpCall(operation, payload || {});
  const result = await httpRequest(method, path, body, options);
  if (operation === 'checkText' || operation === 'checkIp' || operation === 'checkImage') {
    return validateCheck(result);
  }
  return result;
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

function httpCall(operation, payload) {
  switch (operation) {
    case 'checkText':
      return ['POST', '/v1/text/check', {
        scene: payload.scene, text: payload.text,
        userId: payload.userId, ip: payload.ip,
        targetType: payload.targetType, targetId: payload.targetId,
      }];
    case 'checkImage':
      return ['POST', '/v1/image/check', {
        scene: payload.scene, imageUrl: payload.imageUrl,
        userId: payload.userId, targetType: payload.targetType, targetId: payload.targetId,
      }];
    case 'checkIp':
      return ['POST', '/v1/ip/check', { scene: payload.scene, ip: payload.ip, userId: payload.userId }];
    case 'submitReport':
      return ['POST', '/v1/reports', {
        targetType: payload.targetType, targetId: payload.targetId,
        reporterId: payload.reporterId, reason: payload.reason,
      }];
    // 管理接口（app admin key）。QFLI 只做转发，不落任何词库或规则。
    case 'listKeywords':
      return ['GET', `/v1/admin/keywords${query({ limit: payload.limit, offset: payload.offset, category: payload.category })}`, undefined, { admin: true }];
    case 'createKeyword':
      return ['POST', '/v1/admin/keywords', { word: payload.word, category: payload.category, enabled: payload.enabled }, { admin: true }];
    case 'updateKeyword':
      return ['PATCH', `/v1/admin/keywords/${encodeURIComponent(payload.id)}`, payload.patch, { admin: true }];
    case 'deleteKeyword':
      return ['DELETE', `/v1/admin/keywords/${encodeURIComponent(payload.id)}`, undefined, { admin: true }];
    case 'listIpRules':
      return ['GET', `/v1/admin/ip-rules${query({ limit: payload.limit, offset: payload.offset })}`, undefined, { admin: true }];
    case 'createIpRule':
      return ['POST', '/v1/admin/ip-rules', payload.rule, { admin: true }];
    case 'updateIpRule':
      return ['PATCH', `/v1/admin/ip-rules/${encodeURIComponent(payload.id)}`, payload.patch, { admin: true }];
    case 'deleteIpRule':
      return ['DELETE', `/v1/admin/ip-rules/${encodeURIComponent(payload.id)}`, undefined, { admin: true }];
    case 'listScenes':
      return ['GET', '/v1/admin/scenes', undefined, { admin: true }];
    case 'putScene':
      return ['PUT', `/v1/admin/scenes/${encodeURIComponent(payload.scene)}`, { preReview: payload.preReview }, { admin: true }];
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
