// Online terminal requests cross a separate, fail-closed execution boundary.
// This module is node-parameterized so the pool can pick any isolated executor.
const { ApiError } = require('./gateway');
const { log, stage } = require('./logging');
const { StringDecoder } = require('node:string_decoder');

const MAX_OUTPUT = 100 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_STREAM = 2 * 1024 * 1024;
const MAX_LINE = 700 * 1024;
const MAX_SNAPSHOT = 256 * 1024;
const MAX_BODY = 384 * 1024;
const EXEC_TIMEOUT_MS = 85000;
const HEALTH_TIMEOUT_MS = 1500;
const PROGRESS_STAGES = new Set(['queued', 'initializing', 'ready', 'uploading', 'running', 'cleaning']);

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['command', 'files'].includes(key)) ||
      typeof value.command !== 'string' || !value.command.trim() || value.command.length > 2000 || value.command.includes('\0')) {
    throw new ApiError(400, '命令为空、超长或请求无效');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY - 128) throw new ApiError(413, '终端请求超过 384 KiB 限额');
  const files = value.files;
  if (files !== undefined) {
    if (!Array.isArray(files) || !files.length || files.length > 64) throw new ApiError(400, '项目快照文件数量无效');
    const paths = new Set();
    let bytes = 0;
    for (const file of files) {
      if (!file || typeof file !== 'object' || Array.isArray(file) ||
          Object.keys(file).some(key => !['path', 'content'].includes(key)) ||
          typeof file.path !== 'string' || !file.path || Buffer.byteLength(file.path) > 512 ||
          Buffer.from(file.path).toString('utf8') !== file.path ||
          /[\\\x00-\x1f\x7f]/.test(file.path) ||
          file.path.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255) ||
          file.path.split('/').length > 16 || paths.has(file.path) ||
          typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_SNAPSHOT / 3) * 4 ||
          file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
        throw new ApiError(400, '项目快照路径或内容无效');
      }
      const decoded = Buffer.from(file.content, 'base64');
      if (decoded.toString('base64') !== file.content) throw new ApiError(400, '项目快照编码无效');
      bytes += decoded.length;
      if (bytes > MAX_SNAPSHOT) throw new ApiError(413, '项目快照超过 256 KiB 限额');
      paths.add(file.path);
    }
    for (const file of files) {
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        if (paths.has(parts.slice(0, index).join('/'))) throw new ApiError(400, '项目快照文件与目录冲突');
      }
    }
  }
  return { command: value.command, ...(files === undefined ? {} : { files }) };
}

function executorError(status, code) {
  status = status === 401 ? 503
    : [400, 408, 409, 410, 413, 429, 499, 503, 504].includes(status) ? status : 502;
  const messages = { 400: '终端请求无效', 408: '命令超过 15 秒，终端会话已回收',
    409: '该终端正在执行或回收，请稍后重试', 410: '终端会话已过期，请重新执行',
    413: '终端输出或请求超过限额', 499: '终端请求已取消，活动会话将回收',
    429: '终端会话已满，请稍后重试', 503: '安全终端暂不可用，已禁止宿主机执行',
    504: '终端执行服务响应超时' };
  const specific = { queue_timeout: '排队超过 20 秒，等待请求已取消，请稍后重试',
    queue_full: '终端等待队列已满，请稍后重试',
    sandbox_resource_terminated: '终端进程被强制终止或触发资源保护，会话已回收',
    snapshot_upload_failed: '项目快照上传失败，终端会话已回收' };
  return new ApiError(status, specific[code] || messages[status] || '安全终端服务响应异常');
}

// 只有执行器明确证明未受理命令的错误码才允许释放预留。
// 超时、输出溢出、资源终止、清理未知等一律隔离，绝不自动重放。
const RELEASE_CODES = new Set([
  'queue_full', 'queue_timeout', 'session_capacity', 'session_expired',
  'terminal_unavailable', 'invalid_command', 'invalid_user_id',
  'invalid_request_body', 'invalid_files', 'not_found',
  'request_body_failed', 'request_body_limit', 'request_body_timeout',
]);
function classifyFailure(error) {
  const state = error?.executorState;
  if (state?.errorKey && RELEASE_CODES.has(state.errorKey)) return 'release';
  // 内部密钥无效时执行器不做任何 Docker 工作。
  if (state?.status === 401) return 'release';
  return 'quarantine';
}

function resultData(data) {
  if (!data || typeof data.stdout !== 'string' || typeof data.stderr !== 'string' ||
      !Number.isInteger(data.exitCode) || data.exitCode < 0 || data.exitCode > 255 ||
      Buffer.byteLength(data.stdout) + Buffer.byteLength(data.stderr) > MAX_OUTPUT || data.cwd !== '/workspace') {
    throw new ApiError(502, '安全终端服务响应无效');
  }
  return { stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode, cwd: '/workspace' };
}

function nodeBase(node) {
  if (!node || typeof node.base !== 'string' || typeof node.secret !== 'string') {
    throw new ApiError(503, '安全终端节点配置无效');
  }
  return node.base;
}

async function boundedJson(response) {
  if (!response.body) throw new ApiError(502, '安全终端服务响应异常');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE) {
      throw new ApiError(502, '安全终端服务响应超出限制');
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch {
    throw new ApiError(502, '安全终端服务响应异常');
  }
}

async function dispatch(node, method, path, body, req, res, consume, timeoutMs = EXEC_TIMEOUT_MS) {
  const base = nodeBase(node);
  stage('terminal.dispatch');
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const disconnect = () => { if (!res || !res.writableEnded) controller.abort(); };
  req?.once?.('aborted', disconnect);
  res?.once?.('close', disconnect);
  if (req?.aborted || res?.destroyed) controller.abort();
  try {
    const response = await fetch(`${base}${path}`, {
      method, redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${node.secret}`, 'content-type': 'application/json',
        ...(req?.requestId ? { 'X-Request-Id': req.requestId } : {}) },
      body: JSON.stringify({ ...body, userId: req?.userId ?? body.userId }),
    });
    log('terminal.response', { nodeId: node.id, status: response.status, durationMs: Date.now() - started });
    if (!response.ok) {
      const data = await boundedJson(response);
      const error = executorError(response.status, data?.error);
      error.executorState = { nodeId: node.id, status: response.status, errorKey: data?.error };
      throw error;
    }
    if (consume) return await consume(response);
    const data = await boundedJson(response);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ApiError(502, '安全终端服务响应异常');
    }
    return data;
  } catch (err) {
    const interrupted = controller.signal.aborted;
    controller.abort();
    if (err instanceof ApiError) throw err;
    log('terminal.dispatch_failed', { nodeId: node.id, errorType: err.name, networkCode: err.cause?.code,
      aborted: interrupted, durationMs: Date.now() - started }, 'error');
    const error = new ApiError(interrupted ? 504 : 503, interrupted
      ? '终端请求已中断或超时，沙箱将回收' : '无法连接安全终端服务，已禁止宿主机执行');
    error.executorState = { nodeId: node.id, status: interrupted ? 504 : 503, errorKey: null };
    throw error;
  } finally {
    clearTimeout(timeout);
    req?.off?.('aborted', disconnect);
    res?.off?.('close', disconnect);
  }
}

async function execute(node, command, req, res, files) {
  return resultData(await dispatch(node, 'POST', '/v1/exec',
    { command, ...(files === undefined ? {} : { files }) }, req, res));
}

async function executeStream(node, value, req, res, emit) {
  return dispatch(node, 'POST', '/v1/exec/stream', value, req, res, async response => {
    if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson') {
      throw new ApiError(502, '安全终端事件流无效');
    }
    const decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0, outputBytes = 0, result, terminalEvent = false;
    const output = { stdout: '', stderr: '' };
    const accept = async line => {
      if (!line || Buffer.byteLength(line) > MAX_LINE || terminalEvent) throw new ApiError(502, '安全终端事件流无效');
      let event;
      try { event = JSON.parse(line); } catch { throw new ApiError(502, '安全终端事件流无效'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ApiError(502, '安全终端事件流无效');
      if (event.type === 'progress' && PROGRESS_STAGES.has(event.stage) &&
          (event.stage === 'queued' ? Number.isInteger(event.position) && event.position >= 1 && event.position <= 8
            : event.position === undefined)) {
        await emit({ type: 'progress', stage: event.stage, ...(event.position === undefined ? {} : { position: event.position }) });
      } else if (['stdout', 'stderr'].includes(event.type) && typeof event.text === 'string') {
        outputBytes += Buffer.byteLength(event.text);
        if (outputBytes > MAX_OUTPUT) throw new ApiError(502, '安全终端输出超过限额');
        output[event.type] += event.text;
        await emit({ type: event.type, text: event.text });
      } else if (event.type === 'result') {
        result = resultData(event);
        if (result.stdout !== output.stdout || result.stderr !== output.stderr) throw new ApiError(502, '安全终端输出不一致');
        terminalEvent = true;
      } else if (event.type === 'error' && Number.isInteger(event.status) && typeof event.message === 'string') {
        throw executorError(event.status, event.message);
      } else throw new ApiError(502, '安全终端事件流无效');
    };
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_STREAM) throw new ApiError(502, '安全终端事件流超过限额');
      pending += decoder.write(Buffer.from(chunk));
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await accept(line);
      }
      if (Buffer.byteLength(pending) > MAX_LINE) throw new ApiError(502, '安全终端事件过长');
    }
    pending += decoder.end();
    if (pending || !terminalEvent) throw new ApiError(502, '安全终端事件流提前结束');
    await emit({ type: 'result', ...result });
    return result;
  });
}

function openStream(res) {
  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let bytes = 0;
  return async event => {
    if (res.destroyed || res.writableEnded) throw new ApiError(499, '终端连接已断开');
    const line = `${JSON.stringify(event)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_STREAM) throw new ApiError(413, '终端事件流超过限额');
    if (res.write(line)) return;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        res.off('drain', drain);
        res.off('close', close);
        res.off('error', close);
        error ? reject(error) : resolve();
      };
      const drain = () => finish();
      const close = () => finish(new ApiError(499, '终端连接已断开'));
      const timer = setTimeout(() => finish(new ApiError(504, '终端客户端接收超时')), 5000);
      res.once('drain', drain);
      res.once('close', close);
      res.once('error', close);
      if (res.destroyed) close();
    });
  };
}

async function reset(node, req, res, userId) {
  const data = await dispatch(node, 'DELETE', '/v1/session', { userId }, req, res,
    null, EXEC_TIMEOUT_MS);
  if (data.ok !== true) {
    const error = new ApiError(502, '终端回收状态无效');
    error.executorState = { nodeId: node.id, status: 502, errorKey: null };
    throw error;
  }
  return { ok: true };
}

// 探测只用于放置决策。失败返回 ready:false，绝不抛出。
async function health(node) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${nodeBase(node)}/health`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${node.secret}` },
    });
    if (!response.ok) return { ready: false, capacity: null };
    const data = await boundedJson(response);
    const capacity = data?.capacity;
    if (data?.ready !== true || !capacity || typeof capacity !== 'object' || Array.isArray(capacity)) {
      return { ready: false, capacity: null };
    }
    const clean = {};
    for (const key of ['sessions', 'running', 'waiting', 'sessionsLimit', 'runningLimit', 'queueLimit']) {
      const value = capacity[key];
      if (!Number.isInteger(value) || value < 0) return { ready: false, capacity: null };
      clean[key] = value;
    }
    if (clean.sessionsLimit < 1 || clean.runningLimit < 1) return { ready: false, capacity: null };
    return { ready: true, capacity: clean };
  } catch {
    return { ready: false, capacity: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validateRequest, execute, executeStream, openStream, reset, health,
  classifyFailure, _limits: { MAX_BODY, EXEC_TIMEOUT_MS, HEALTH_TIMEOUT_MS } };
