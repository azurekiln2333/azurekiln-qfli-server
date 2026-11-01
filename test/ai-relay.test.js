// AI 转接的聚焦测试：固定配置、严格输入、工具往返、超时/取消/限流与脱敏错误。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const userId = `user_${'1'.repeat(32)}`;

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authRequired(req, _res, next) {
      req.userId = req.get('x-test-user') || userId;
      req.user = { id: req.userId, username: 'test', is_admin: false };
      next();
    },
    publicUser: async () => ({}),
  },
};

const auditPath = require.resolve('../src/audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: { audit: async () => {}, loadUsername: async () => null,
    terminalRateLimited: () => false, RETENTION_DAYS: 90 },
};

const ai = require('../src/ai-client');
const router = require('../src/routes/ai');

// Express 4 不会自动转发路由异步拒绝，与 server.js 保持相同的包装。
for (const layer of router.stack) {
  for (const handler of layer.route ? layer.route.stack : [layer]) {
    const original = handler.handle;
    if (original.length === 4) continue;
    handler.handle = (req, res, next) => {
      try { Promise.resolve(original(req, res, next)).catch(next); } catch (error) { next(error); }
    };
  }
}

const API_KEY = 'key-server-side-secret';
process.env.QFLI_AI_API_KEY = API_KEY;
process.env.QFLI_AI_MODEL = 'deepseek-v4.1-flash';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startUpstream(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function jsonUpstream(payload) {
  const upstream = await startUpstream((req, res) => {
    readBody(req).then(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  return upstream;
}

let appServer;
let appBase;

test.before(async () => {
  const app = express();
  // 放宽测试解析器，便于单独验证模块内部的 512 KiB 限额。
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/ai', router);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  await new Promise(resolve => { appServer = app.listen(0, '127.0.0.1', resolve); });
  appBase = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(() => new Promise(resolve => { appServer.close(resolve); }));

test.beforeEach(() => {
  ai._resetLimits();
  process.env.QFLI_AI_TIMEOUT_MS = '5000';
  process.env.QFLI_AI_RATE_LIMIT = '100';
  process.env.QFLI_AI_CONCURRENCY = '4';
  process.env.QFLI_AI_MAX_INFLIGHT = '16';
  process.env.QFLI_AI_MODEL = 'deepseek-v4.1-flash';
});

async function post(payload, user = userId) {
  const response = await fetch(`${appBase}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

test('tool round trip keeps tool_calls and fixes the model', async () => {
  let seen;
  let authorization;
  const upstream = await startUpstream(async (req, res) => {
    authorization = req.headers.authorization;
    seen = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'client-should-not-see',
      choices: [{ index: 0, message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  const messages = [
    { role: 'system', content: '你是编程助手' },
    { role: 'user', content: '创建 a.txt' },
    { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_0', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'not found' },
  ];
  const tools = [{ type: 'function', function: { name: 'write_file', description: '写文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

  const { status, body } = await post({ messages, tools });
  assert.equal(status, 200);
  assert.equal(body.model, 'deepseek-v4.1-flash');
  // 客户端据此显示“内容由 AI 生成”标识。
  assert.equal(body.aiGenerated, true);
  assert.deepEqual(body.message, {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function',
      function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }],
  });
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(authorization, `Bearer ${API_KEY}`);
  assert.equal(seen.model, 'deepseek-v4.1-flash');
  assert.deepEqual(seen.messages, messages);
  assert.deepEqual(seen.tools, tools);
  assert.equal(seen.stream, undefined);
  await upstream.close();
});

test('upstream index metadata is accepted then stripped', async () => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [
        { id: 'call_abc123', index: 0, type: 'function',
          function: { name: 'run_command', arguments: '{"command":"ls"}' } },
        { id: 'call_def456', index: 1, type: 'function',
          function: { name: 'list_files', arguments: '{"path":"."}' } },
      ] } }] }));
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  const { status, body } = await post({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200);
  assert.deepEqual(body.message.tool_calls, [
    { id: 'call_abc123', type: 'function',
      function: { name: 'run_command', arguments: '{"command":"ls"}' } },
    { id: 'call_def456', type: 'function',
      function: { name: 'list_files', arguments: '{"path":"."}' } },
  ]);
  assert.equal('index' in body.message.tool_calls[0], false);
  await upstream.close();

  // 空文本只有配合有效工具调用才合法。
  const second = await startUpstream(async (req, res) => {
    await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '',
      tool_calls: [{ id: 'call_ffff', index: 0, type: 'function',
        function: { name: 'run_command', arguments: '{}' } }] } }] }));
  });
  process.env.QFLI_AI_BASE_URL = second.base;
  const empty = await post({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.message.content, '');
  assert.equal(empty.body.message.tool_calls.length, 1);
  assert.equal('index' in empty.body.message.tool_calls[0], false);
  await second.close();
});

test('malformed upstream tool_call metadata is rejected', async () => {
  const cases = [
    [{ id: 'call_1', index: '0', type: 'function', function: { name: 'f', arguments: '{}' } }],
    [{ id: 'call_1', index: -1, type: 'function', function: { name: 'f', arguments: '{}' } }],
    [{ id: 'call_1', index: 1.5, type: 'function', function: { name: 'f', arguments: '{}' } }],
    [{ id: 'call_1', index: 0, type: 'function', function: { name: 'f', arguments: '{}' }, extra: 1 }],
  ];
  for (const tool_calls of cases) {
    const upstream = await startUpstream(async (req, res) => {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls } }] }));
    });
    process.env.QFLI_AI_BASE_URL = upstream.base;
    const { status } = await post({ messages: [{ role: 'user', content: 'go' }] });
    assert.equal(status, 502, JSON.stringify(tool_calls));
    await upstream.close();
  }
});

test('upstream null or empty tool_calls become a plain text turn', async () => {
  const payloads = [
    { choices: [{ message: { role: 'assistant', content: '完成', tool_calls: null } }] },
    { choices: [{ message: { role: 'assistant', content: '完成', tool_calls: [] } }] },
  ];
  for (const payload of payloads) {
    const upstream = await startUpstream(async (req, res) => {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    process.env.QFLI_AI_BASE_URL = upstream.base;
    const { status, body } = await post({ messages: [{ role: 'user', content: 'go' }] });
    assert.equal(status, 200, JSON.stringify(payload));
    assert.deepEqual(body.message, { role: 'assistant', content: '完成' });
    await upstream.close();
  }
});

test('upstream no-call shapes without text are rejected', async () => {
  const cases = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: null } }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }] },
    { choices: [{ message: { role: 'assistant', content: '' } }] },
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: null } }] },
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }] },
    { choices: [{ message: { role: 'assistant', content: 'x', tool_calls: 'nope' } }] },
  ];
  for (const payload of cases) {
    const upstream = await startUpstream(async (req, res) => {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    process.env.QFLI_AI_BASE_URL = upstream.base;
    const { status } = await post({ messages: [{ role: 'user', content: 'go' }] });
    assert.equal(status, 502, JSON.stringify(payload));
    await upstream.close();
  }
});

test('client cannot override address, key, model or streaming', async () => {
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  for (const extra of [
    { model: 'gpt-4o' }, { stream: true }, { temperature: 1 },
    { apiKey: 'x' }, { base_url: 'https://evil.example' }, { tool_choice: 'auto' },
  ]) {
    const { status } = await post({ messages: [{ role: 'user', content: 'hi' }], ...extra });
    assert.equal(status, 400, JSON.stringify(extra));
  }
  assert.equal(requests, 0);
  await upstream.close();
});

test('configuration fixes endpoint, https requirement and defaults', async () => {
  const upstream = await startUpstream(async (req, res) => { await readBody(req); res.end('{}'); });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  assert.equal(ai.configuration().endpoint, `${upstream.base}/v1/chat/completions`);
  process.env.QFLI_AI_BASE_URL = `${upstream.base}/v1`;
  assert.equal(ai.configuration().endpoint, `${upstream.base}/v1/chat/completions`);
  assert.equal(ai.configuration().model, 'deepseek-v4.1-flash');

  const savedBase = process.env.QFLI_AI_BASE_URL;
  process.env.QFLI_AI_BASE_URL = 'http://example.com';
  assert.throws(() => ai.configuration(), { status: 503 });
  process.env.QFLI_AI_BASE_URL = 'https://user:pass@example.com';
  assert.throws(() => ai.configuration(), { status: 503 });
  process.env.QFLI_AI_BASE_URL = savedBase;
  process.env.QFLI_AI_MODEL = 'bad model!';
  assert.throws(() => ai.configuration(), { status: 503 });
  process.env.QFLI_AI_MODEL = 'deepseek-v4.1-flash';
  const savedKey = process.env.QFLI_AI_API_KEY;
  process.env.QFLI_AI_API_KEY = '';
  assert.throws(() => ai.configuration(), { status: 503 });
  process.env.QFLI_AI_API_KEY = savedKey;
  await upstream.close();
});

test('unconfigured relay returns 503 without contacting upstream', async () => {
  process.env.QFLI_AI_BASE_URL = '';
  assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }] })).status, 503);
});

test('messages and tools are validated strictly', async () => {
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    await readBody(req);
    res.end('{}');
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  const message = { role: 'user', content: 'hi' };
  const cases = [
    [{ messages: [] }, 400],
    [{ messages: [{ role: 'developer', content: 'x' }] }, 400],
    [{ messages: [{ role: 'user' }] }, 400],
    [{ messages: [{ role: 'tool', content: 'x' }] }, 400],
    [{ messages: [{ role: 'user', content: 'x', extra: 1 }] }, 400],
    [{ messages: [{ role: 'assistant', content: 'x', tool_call_id: 'c1' }] }, 400],
    [{ messages: [{ role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 1 } }] }] }, 400],
    [{ messages: [{ role: 'assistant', content: null,
      tool_calls: [{ id: 'c', index: 0, type: 'function',
        function: { name: 'f', arguments: '{}' } }] }] }, 400],
    [{ messages: [{ role: 'assistant', content: null }] }, 400],
    [{ messages: [{ role: 'user', content: 'x'.repeat(256 * 1024 + 1) }] }, 413],
    [{ messages: [{ role: 'user', content: 'x'.repeat(140 * 1024) },
      { role: 'user', content: 'y'.repeat(140 * 1024) },
      { role: 'user', content: 'z'.repeat(140 * 1024) },
      { role: 'user', content: 'w'.repeat(140 * 1024) }] }, 413],
    [{ messages: [message], tools: [] }, 400],
    [{ messages: [message], tools: [{ type: 'function', function: { name: 'f', extra: 1 } }] }, 400],
    [{ messages: [message], tools: [{ type: 'function', function: { name: 'f' } },
      { type: 'function', function: { name: 'f' } }] }, 400],
  ];
  for (const [payload, expected] of cases) {
    const { status } = await post(payload);
    assert.equal(status, expected, JSON.stringify(payload).slice(0, 120));
  }
  assert.equal(requests, 0);
  await upstream.close();
});

test('upstream failures are mapped to sanitized errors', async () => {
  const cases = [
    [401, 502, 'AI 服务凭据无效'],
    [403, 502, 'AI 服务凭据无效'],
    [500, 503, 'AI 服务暂不可用，请稍后重试'],
    [429, 429, 'AI 请求过于频繁，请稍后再试'],
    [400, 502, 'AI 服务拒绝了请求'],
  ];
  for (const [upstreamStatus, expectedStatus, expectedMessage] of cases) {
    const upstream = await startUpstream(async (req, res) => {
      await readBody(req);
      res.statusCode = upstreamStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: `leak ${API_KEY}` }));
    });
    process.env.QFLI_AI_BASE_URL = upstream.base;
    const { status, body } = await post({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, expectedStatus);
    assert.equal(body.error, expectedMessage);
    assert.ok(!body.error.includes(API_KEY));
    await upstream.close();
  }
});

test('timeout returns 504 and closes the upstream request', async () => {
  let canceled;
  const canceledPromise = new Promise(resolve => { canceled = resolve; });
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    res.once('close', canceled);
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  process.env.QFLI_AI_TIMEOUT_MS = '150';
  const { status, body } = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(status, 504);
  assert.match(body.error, /超时/);
  await canceledPromise;
  await upstream.close();
});

test('client disconnect cancels the upstream request and frees limits', async () => {
  let received;
  const receivedPromise = new Promise(resolve => { received = resolve; });
  let upstreamCanceled;
  const canceledPromise = new Promise(resolve => { upstreamCanceled = resolve; });
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    await readBody(req);
    if (requests === 1) {
      received();
      res.once('close', upstreamCanceled);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const controller = new AbortController();
  const pending = fetch(`${appBase}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'long task' }] }),
    signal: controller.signal,
  }).catch(error => error);
  await receivedPromise;
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.name, 'AbortError');
  await canceledPromise;
  const { status } = await post({ messages: [{ role: 'user', content: 'next' }] });
  assert.equal(status, 200);
  await upstream.close();
});

test('per-user concurrency rejects a second in-flight request', async () => {
  process.env.QFLI_AI_CONCURRENCY = '1';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let received;
  const receivedPromise = new Promise(resolve => { received = resolve; });
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    await readBody(req);
    received();
    await gate;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const first = post({ messages: [{ role: 'user', content: 'first' }] });
  await receivedPromise;
  const second = await post({ messages: [{ role: 'user', content: 'second' }] });
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(requests, 1);
  await upstream.close();
});

test('per-user rate limit rejects excess requests in one minute', async () => {
  process.env.QFLI_AI_RATE_LIMIT = '2';
  const upstream = await jsonUpstream({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  for (let index = 0; index < 2; index++) {
    assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }] })).status, 200);
  }
  const limited = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(limited.status, 429);
  await upstream.close();
});

test('invalid upstream payloads are rejected', async () => {
  const payloads = [
    {},
    { choices: [] },
    { choices: 'x' },
    { choices: [{ message: { role: 'user', content: 'x' } }] },
    { choices: [{ message: { role: 'assistant', content: null } }] },
    { choices: [{ message: { role: 'assistant', content: 'x',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 1 } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 5 } }] },
  ];
  for (const payload of payloads) {
    const upstream = await jsonUpstream(payload);
    process.env.QFLI_AI_BASE_URL = upstream.base;
    const { status } = await post({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(status, 502, JSON.stringify(payload));
    await upstream.close();
  }
});

test('oversized upstream responses are rejected', async () => {
  const upstream = await jsonUpstream({ choices: [{ message: {
    role: 'assistant', content: 'a'.repeat(2 * 1024 * 1024 + 1) } }] });
  process.env.QFLI_AI_BASE_URL = upstream.base;
  const { status, body } = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(status, 502);
  assert.match(body.error, /2 MiB/);
  await upstream.close();
});
