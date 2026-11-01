// AI 编程助手转接：上游地址、密钥和模型只由服务端环境变量决定。
// 客户端只能提交 OpenAI 兼容的消息和工具定义，不能覆盖模型或连接参数。
const { ApiError } = require('./gateway');
const { log, stage } = require('./logging');

const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_TEXT = 512 * 1024;
const MAX_TOOLS_BYTES = 64 * 1024;
const MAX_MESSAGES = 100;
const MAX_TOOL_CALLS = 16;
const MAX_TOOLS = 64;
const RATE_WINDOW_MS = 60 * 1000;
const MESSAGE_KEYS = ['role', 'content', 'tool_calls', 'tool_call_id'];
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function limits() {
  return {
    timeoutMs: boundedInt(process.env.QFLI_AI_TIMEOUT_MS, 60000, 100, 120000),
    rate: boundedInt(process.env.QFLI_AI_RATE_LIMIT, 20, 1, 600),
    concurrency: boundedInt(process.env.QFLI_AI_CONCURRENCY, 2, 1, 8),
    maxInflight: boundedInt(process.env.QFLI_AI_MAX_INFLIGHT, 16, 1, 64),
  };
}

function configuration() {
  const base = (process.env.QFLI_AI_BASE_URL || '').trim();
  const key = (process.env.QFLI_AI_API_KEY || '').trim();
  const model = (process.env.QFLI_AI_MODEL || DEFAULT_MODEL).trim();
  if (!base || !key) throw new ApiError(503, 'AI 服务未配置');
  if (!NAME_PATTERN.test(model)) throw new ApiError(503, 'AI 模型名称无效');
  let url;
  try { url = new URL(base); } catch { throw new ApiError(503, 'AI 服务地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new ApiError(503, 'AI 服务地址需要 HTTPS');
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  const endpoint = `${url.origin}${/\/v1$/.test(prefix) ? prefix : `${prefix}/v1`}/chat/completions`;
  return { endpoint, key, model, ...limits() };
}

function validateToolCalls(list, status, { allowIndex = false } = {}) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TOOL_CALLS) {
    throw new ApiError(status, '工具调用格式无效');
  }
  const callKeys = allowIndex ? ['id', 'type', 'function', 'index'] : ['id', 'type', 'function'];
  return list.map(call => {
    if (!isPlainObject(call) || !onlyKeys(call, callKeys) ||
        typeof call.id !== 'string' || !NAME_PATTERN.test(call.id) || call.type !== 'function' ||
        !isPlainObject(call.function) || !onlyKeys(call.function, ['name', 'arguments']) ||
        typeof call.function.name !== 'string' || !NAME_PATTERN.test(call.function.name) ||
        typeof call.function.arguments !== 'string' ||
        Buffer.byteLength(call.function.arguments) > MAX_ARGUMENT_BYTES) {
      throw new ApiError(status, '工具调用格式无效');
    }
    // index 是上游流式序号元数据，校验后不向下游透传。
    if (allowIndex && 'index' in call &&
        (!Number.isSafeInteger(call.index) || call.index < 0)) {
      throw new ApiError(status, '工具调用格式无效');
    }
    return {
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments },
    };
  });
}

function validateMessage(message, index) {
  if (!isPlainObject(message) || !onlyKeys(message, MESSAGE_KEYS) ||
      typeof message.role !== 'string' || !ROLES.has(message.role) ||
      !Object.prototype.hasOwnProperty.call(message, 'content')) {
    throw new ApiError(400, `第 ${index + 1} 条消息格式无效`);
  }
  // content 为 null 表示助手只返回工具调用。
  if (message.content !== null && typeof message.content !== 'string') {
    throw new ApiError(400, `第 ${index + 1} 条消息内容无效`);
  }
  if (typeof message.content === 'string' && Buffer.byteLength(message.content) > MAX_MESSAGE_BYTES) {
    throw new ApiError(413, `第 ${index + 1} 条消息超过 256 KiB 限额`);
  }
  const canonical = { role: message.role, content: message.content };
  if (message.role === 'tool') {
    if (typeof message.content !== 'string' ||
        typeof message.tool_call_id !== 'string' || !NAME_PATTERN.test(message.tool_call_id) ||
        'tool_calls' in message) {
      throw new ApiError(400, '工具结果消息必须带 tool_call_id 且不能包含 tool_calls');
    }
    canonical.tool_call_id = message.tool_call_id;
    return canonical;
  }
  if ('tool_call_id' in message) throw new ApiError(400, '只有工具结果消息可以带 tool_call_id');
  if (message.role === 'assistant') {
    if (typeof message.content === 'string' && !message.content && !('tool_calls' in message)) {
      throw new ApiError(400, '助手消息内容为空');
    }
    if ('tool_calls' in message) {
      canonical.tool_calls = validateToolCalls(message.tool_calls, 400);
      if (message.content === null && !canonical.tool_calls.length) {
        throw new ApiError(400, '助手消息缺少内容');
      }
    } else if (message.content === null || !message.content) {
      throw new ApiError(400, '助手消息内容为空');
    }
    return canonical;
  }
  if (typeof message.content !== 'string' || !message.content) {
    throw new ApiError(400, '消息内容为空');
  }
  return canonical;
}

function validateTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > MAX_TOOLS) {
    throw new ApiError(400, '工具定义数量无效');
  }
  const names = new Set();
  const canonical = tools.map(tool => {
    if (!isPlainObject(tool) || !onlyKeys(tool, ['type', 'function']) || tool.type !== 'function' ||
        !isPlainObject(tool.function) ||
        !onlyKeys(tool.function, ['name', 'description', 'parameters']) ||
        typeof tool.function.name !== 'string' || !NAME_PATTERN.test(tool.function.name) ||
        names.has(tool.function.name)) {
      throw new ApiError(400, '工具定义格式无效');
    }
    names.add(tool.function.name);
    const result = { type: 'function', function: { name: tool.function.name } };
    if ('description' in tool.function) {
      if (typeof tool.function.description !== 'string' ||
          Buffer.byteLength(tool.function.description) > 8192) {
        throw new ApiError(400, '工具描述无效');
      }
      result.function.description = tool.function.description;
    }
    if ('parameters' in tool.function) {
      if (!isPlainObject(tool.function.parameters) ||
          Buffer.byteLength(JSON.stringify(tool.function.parameters)) > 16384) {
        throw new ApiError(400, '工具参数定义无效');
      }
      result.function.parameters = tool.function.parameters;
    }
    return result;
  });
  if (Buffer.byteLength(JSON.stringify(canonical)) > MAX_TOOLS_BYTES) {
    throw new ApiError(413, '工具定义超过 64 KiB 限额');
  }
  return canonical;
}

function validateRequest(value) {
  if (!isPlainObject(value) || !onlyKeys(value, ['messages', 'tools']) ||
      !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
    throw new ApiError(400, 'AI 请求无效或消息数量超过 100 条');
  }
  const messages = value.messages.map(validateMessage);
  const tools = validateTools(value.tools);
  const serialized = JSON.stringify({ messages, ...(tools === undefined ? {} : { tools }) });
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'AI 请求超过 512 KiB 限额');
  }
  return { messages, ...(tools === undefined ? {} : { tools }) };
}

// 每用户限流和并发，另设全服务在途上限保护小主机。
const active = new Map();
const windows = new Map();
let inflight = 0;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [userId, timestamps] of windows) {
    if (!timestamps.some(value => value > cutoff)) windows.delete(userId);
  }
}, RATE_WINDOW_MS).unref();

function admit(userId) {
  const { rate, concurrency, maxInflight } = limits();
  const now = Date.now();
  if (inflight >= maxInflight) throw new ApiError(503, 'AI 服务繁忙，请稍后再试');
  if ((active.get(userId) || 0) >= concurrency) {
    throw new ApiError(429, '已有 AI 请求正在处理，请稍后重试');
  }
  if (!windows.has(userId) && windows.size >= 10000) {
    throw new ApiError(429, 'AI 请求过于频繁，请稍后再试');
  }
  const recent = (windows.get(userId) || []).filter(time => now - time < RATE_WINDOW_MS);
  if (recent.length >= rate) {
    windows.set(userId, recent);
    throw new ApiError(429, 'AI 请求过于频繁，请稍后再试');
  }
  recent.push(now);
  windows.set(userId, recent);
  active.set(userId, (active.get(userId) || 0) + 1);
  inflight += 1;
}

function release(userId) {
  const next = (active.get(userId) || 0) - 1;
  if (next > 0) active.set(userId, next);
  else active.delete(userId);
  inflight = Math.max(0, inflight - 1);
}

function upstreamError(status) {
  if (status === 429) return new ApiError(429, 'AI 请求过于频繁，请稍后再试');
  if (status === 401 || status === 403) return new ApiError(502, 'AI 服务凭据无效');
  if (status === 413) return new ApiError(413, 'AI 请求超过上游限额');
  if (status >= 500) return new ApiError(503, 'AI 服务暂不可用，请稍后重试');
  return new ApiError(502, 'AI 服务拒绝了请求');
}

async function boundedJson(response) {
  if (!response.body) throw new ApiError(502, 'AI 服务响应无效');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new ApiError(502, 'AI 服务响应超过 2 MiB 限额');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new ApiError(502, 'AI 服务响应无效');
  }
}

function usageData(value) {
  if (!isPlainObject(value)) return undefined;
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const number = value[key];
    if (number === undefined) continue;
    if (!Number.isInteger(number) || number < 0) return undefined;
    usage[key] = number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function resultData(data, model) {
  if (!isPlainObject(data) || !Array.isArray(data.choices) ||
      data.choices.length < 1 || data.choices.length > 8) {
    throw new ApiError(502, 'AI 服务响应无效');
  }
  const message = data.choices[0]?.message;
  if (!isPlainObject(message) || message.role !== 'assistant') {
    throw new ApiError(502, 'AI 服务响应无效');
  }
  const content = message.content === undefined ? null : message.content;
  if (content !== null && typeof content !== 'string') throw new ApiError(502, 'AI 服务响应无效');
  if (typeof content === 'string' && Buffer.byteLength(content) > MAX_RESPONSE_TEXT) {
    throw new ApiError(502, 'AI 服务响应内容超过 512 KiB 限额');
  }
  let toolCalls;
  // 官方契约把 tool_calls 声明为可选列表。null 与 [] 表示本轮无调用。
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) throw new ApiError(502, 'AI 服务响应无效');
    if (message.tool_calls.length > 0) {
      toolCalls = validateToolCalls(message.tool_calls, 502, { allowIndex: true });
    }
  }
  // 无工具调用时必须有非空文本，否则客户端无法渲染这一轮。
  if (!toolCalls && !content) throw new ApiError(502, 'AI 服务响应无效');
  const result = {
    model,
    message: {
      role: 'assistant',
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    },
  };
  const usage = usageData(data.usage);
  if (usage) result.usage = usage;
  return result;
}

async function chat(body, { req, res } = {}) {
  const config = configuration();
  const request = validateRequest(body);
  if (!req || typeof req.userId !== 'string') throw new ApiError(401, '未登录或登录已过期');
  admit(req.userId);

  stage('ai.dispatch');
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  const disconnect = () => controller.abort();
  if (req) req.once('aborted', disconnect);
  if (res) res.once('close', disconnect);
  if (req?.aborted || res?.destroyed) controller.abort();

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(req.requestId ? { 'X-Request-Id': req.requestId } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: request.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
      }),
    });
    log('ai.response', {
      status: response.status,
      model: config.model,
      messages: request.messages.length,
      tools: request.tools?.length || 0,
      durationMs: Date.now() - started,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch (_) { /* 忽略取消失败 */ }
      throw upstreamError(response.status);
    }
    return resultData(await boundedJson(response), config.model);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const aborted = controller.signal.aborted;
    log('ai.dispatch_failed', {
      errorType: error.name,
      networkCode: error.cause?.code,
      aborted,
      timedOut,
      durationMs: Date.now() - started,
    }, 'error');
    if (aborted) {
      throw new ApiError(timedOut ? 504 : 499,
        timedOut ? 'AI 请求超时，请稍后重试' : 'AI 请求已取消');
    }
    throw new ApiError(503, '无法连接 AI 服务');
  } finally {
    clearTimeout(timer);
    req?.off('aborted', disconnect);
    res?.off('close', disconnect);
    release(req.userId);
  }
}

function resetLimits() {
  active.clear();
  windows.clear();
  inflight = 0;
}

module.exports = {
  configuration,
  validateRequest,
  chat,
  _resetLimits: resetLimits,
};
