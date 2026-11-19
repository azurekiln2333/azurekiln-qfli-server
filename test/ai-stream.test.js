// AI 流式回合测试：本地假上游覆盖事件顺序、工具增量、超限、超时与取消。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const userId = `user_${'2'.repeat(32)}`;

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: {
    authRequired(req, _res, next) {
      if (req.get('x-test-user') === 'unauthenticated') {
        _res.status(401).json({ error: '未登录' });
        return;
      }
      req.userId = req.get('x-test-user') || userId;
      req.user = { id: req.userId, username: 'test', is_admin: false };
      next();
    },
    publicUser: async () => ({}),
  },
};

const auditCalls = [];
const auditPath = require.resolve('../src/audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: { audit: async (_req, entry) => { auditCalls.push(entry); },
    loadUsername: async () => null, terminalRateLimited: () => false, RETENTION_DAYS: 90 },
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
const TEST_MODEL = 'provider/thinking:latest';
const CATALOG = { object: 'list', data: [
  { id: TEST_MODEL, object: 'model', created: 0, owned_by: 'provider' },
] };
process.env.QFLI_AI_API_KEY = API_KEY;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startUpstream(handler, { catalog = CATALOG } = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (catalog !== null && req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(catalog));
        return;
      }
      handler(req, res);
    });
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

// 假上游的 SSE 响应。客户端中断时写入会失败，这里吞掉，避免测试进程崩溃。
function openSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.on('error', () => {});
}

function send(res, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

function keepAlive(res) {
  if (res.destroyed || res.writableEnded) return;
  res.write(': keep-alive\n\n');
}

function delta(part, extra = {}) {
  return { choices: [{ delta: part }], ...extra };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let appServer;
let appBase;

test.before(async () => {
  const app = express();
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
  auditCalls.length = 0;
  process.env.QFLI_AI_TIMEOUT_MS = '5000';
  process.env.QFLI_AI_RATE_LIMIT = '100';
  process.env.QFLI_AI_CONCURRENCY = '4';
  process.env.QFLI_AI_MAX_INFLIGHT = '16';
  process.env.QFLI_AI_API_KEY = API_KEY;
  delete process.env.QFLI_AI_STREAM_IDLE_MS;
  delete process.env.QFLI_AI_STREAM_MAX_MS;
});

function requestStream(payload, { signal, user = userId } = {}) {
  return fetch(`${appBase}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(payload),
    signal,
  });
}

function parseEvents(text) {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function streamEvents(payload) {
  const response = await requestStream(payload);
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type'),
    events: parseEvents(text) };
}

const messages = [{ role: 'user', content: '读文件' }];

test('stream emits reasoning, content and tool deltas in order with a final result', async t => {
  let seen;
  const upstream = await startUpstream(async (req, res) => {
    seen = JSON.parse(await readBody(req));
    openSse(res);
    send(res, delta({ reasoning_content: '想' }));
    send(res, delta({ reasoning_content: '一下' }));
    send(res, delta({ content: '你' }));
    send(res, delta({ content: '好' }));
    // 工具调用分两段到达：名字在前，参数在后。
    send(res, delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
      function: { name: 'read_file', arguments: '' } }] }));
    send(res, delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }));
    // 用量分片的 choices 为空。
    send(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { status, type, events } = await streamEvents({ messages });
  assert.equal(status, 200);
  assert.match(type, /application\/x-ndjson/);
  assert.deepEqual(events.map(event => event.type),
    ['start', 'reasoning', 'reasoning', 'content', 'content', 'tool_call', 'result']);
  assert.deepEqual(events[0], { type: 'start', model: TEST_MODEL, aiGenerated: true });
  assert.deepEqual(events[1], { type: 'reasoning', text: '想' });
  assert.deepEqual(events[5], { type: 'tool_call', index: 0, name: 'read_file' });
  assert.deepEqual(events[6], {
    type: 'result',
    aiGenerated: true,
    model: TEST_MODEL,
    message: {
      role: 'assistant',
      content: '你好',
      tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      reasoning_content: '想一下',
    },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });
  assert.equal(seen.model, TEST_MODEL);
  assert.deepEqual(seen.messages, messages);
  // 审计只记摘要，不记正文和思考内容。
  const entry = auditCalls.at(-1);
  assert.equal(entry.action, 'ai.chat');
  assert.equal(entry.detail, `model=${TEST_MODEL} toolCalls=1 stream=1 reasoningChars=3`);
});

test('stream reads the reasoning alias and keeps an empty call list out', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    send(res, delta({ reasoning: '先想' }));
    send(res, delta({ content: '答' }));
    send(res, delta({ tool_calls: null }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { status, events } = await streamEvents({ messages });
  assert.equal(status, 200);
  assert.deepEqual(events.filter(event => event.type === 'reasoning'),
    [{ type: 'reasoning', text: '先想' }]);
  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.message.reasoning_content, '先想');
  assert.equal(result.message.content, '答');
  assert.equal('tool_calls' in result.message, false);
  assert.equal('usage' in result, false);
});

test('stream assembles interleaved tool calls by index', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    send(res, delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function',
      function: { name: 'list_files', arguments: '{"path"' } }] }));
    send(res, delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function',
      function: { name: 'run_command', arguments: '{"comm' } }] }));
    send(res, delta({ tool_calls: [{ index: 1, function: { arguments: ':"./x"}' } }] }));
    send(res, delta({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { events } = await streamEvents({ messages });
  assert.deepEqual(events.filter(event => event.type === 'tool_call'),
    [{ type: 'tool_call', index: 1, name: 'list_files' },
      { type: 'tool_call', index: 0, name: 'run_command' }]);
  const result = events.at(-1);
  assert.equal(result.message.content, null);
  assert.deepEqual(result.message.tool_calls, [
    { id: 'call_a', type: 'function',
      function: { name: 'run_command', arguments: '{"command":"ls"}' } },
    { id: 'call_b', type: 'function',
      function: { name: 'list_files', arguments: '{"path":"./x"}' } },
  ]);
});

test('keep-alive comments emit nothing and reset the idle timer', async t => {
  // 下限 5 秒。间隔 1.5 秒的注释行只能靠“任何字节都重置”活下来。
  process.env.QFLI_AI_STREAM_IDLE_MS = '5000';
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    keepAlive(res);
    for (let index = 0; index < 3; index++) {
      await sleep(1500);
      keepAlive(res);
    }
    await sleep(900);
    send(res, delta({ content: '活着' }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { status, events } = await streamEvents({ messages });
  assert.equal(status, 200);
  assert.deepEqual(events.map(event => event.type), ['start', 'content', 'result']);
  assert.equal(events.at(-1).message.content, '活着');
});

test('oversized content ends the stream with an error event', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    send(res, delta({ content: 'a'.repeat(512 * 1024 + 1) }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { status, events } = await streamEvents({ messages });
  assert.equal(status, 200);
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 502);
  assert.match(error.error, /512 KiB/);
});

test('oversized reasoning ends the stream with an error event', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    send(res, delta({ reasoning_content: 'b'.repeat(512 * 1024 + 1) }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { events } = await streamEvents({ messages });
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 502);
  assert.match(error.error, /思考内容超过 512 KiB/);
});

test('oversized upstream stream ends with an error event', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    const filler = `: ${'x'.repeat(512 * 1024)}\n\n`;
    for (let index = 0; index < 9 && !res.destroyed; index++) res.write(filler);
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { events } = await streamEvents({ messages });
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 502);
  assert.match(error.error, /4 MiB/);
});

test('truncated upstream stream becomes an error event', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    send(res, delta({ content: '半' }));
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const { events } = await streamEvents({ messages });
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 502);
  assert.match(error.error, /提前结束/);
});

test('idle upstream ends the stream with a timeout error event', async t => {
  process.env.QFLI_AI_STREAM_IDLE_MS = '5000';
  let canceled;
  const canceledPromise = new Promise(resolve => { canceled = resolve; });
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    res.once('close', canceled);
    send(res, delta({ content: '开' }));
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const started = Date.now();
  const { events } = await streamEvents({ messages });
  assert.ok(Date.now() - started >= 5000, '空闲计时不应提前结束');
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 504);
  await canceledPromise;
});

test('client disconnect interrupts the upstream request', async t => {
  let canceled;
  const canceledPromise = new Promise(resolve => { canceled = resolve; });
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    openSse(res);
    res.once('close', canceled);
    send(res, delta({ content: '开始' }));
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const controller = new AbortController();
  const response = await requestStream({ messages }, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.length > 0);
  controller.abort();
  await canceledPromise;
  await reader.cancel().catch(() => {});
});

test('upstream rejection keeps an HTTP error response', async t => {
  let chats = 0;
  const upstream = await startUpstream(async (req, res) => {
    chats += 1;
    await readBody(req);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: `leak ${API_KEY}` }));
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const response = await requestStream({ messages });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.error, 'AI 服务暂不可用，请稍后重试');
  assert.ok(!JSON.stringify(body).includes(API_KEY));
  assert.equal(chats, 1);
});

test('stream requires authentication and a listed model', async t => {
  let chats = 0;
  const upstream = await startUpstream(async (_req, res) => {
    chats += 1;
    res.end('{}');
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const unauthenticated = await requestStream({ messages }, { user: 'unauthenticated' });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error, '未登录');
  const unknown = await requestStream({ messages, model: 'not-listed' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /模型不可用/);
  assert.equal(chats, 0);
});

test('clients cannot pass streaming or unknown fields', async t => {
  let requests = 0;
  const upstream = await startUpstream(async (_req, res) => {
    requests += 1;
    res.end('{}');
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  for (const extra of [{ stream: true }, { stream_options: { include_usage: true } },
    { temperature: 1 }]) {
    const response = await requestStream({ messages, ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
    await response.arrayBuffer();
  }
  assert.equal(requests, 0);
});

test('only assistant messages may carry reasoning content', async t => {
  let requests = 0;
  let seen;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    seen = JSON.parse(await readBody(req));
    openSse(res);
    send(res, delta({ content: 'ok' }));
    send(res, '[DONE]');
    res.end();
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const rejected = [
    [{ role: 'user', content: 'hi', reasoning_content: 'x' }, 400],
    [{ role: 'system', content: 'sys', reasoning_content: 'x' }, 400],
    [{ role: 'assistant', content: '上一轮', reasoning_content: 5 }, 400],
    [{ role: 'assistant', content: '上一轮', reasoning_content: 'x'.repeat(256 * 1024 + 1) }, 413],
  ];
  for (const [message, expected] of rejected) {
    const response = await requestStream({ messages: [message] });
    assert.equal(response.status, expected, JSON.stringify(message).slice(0, 80));
    await response.arrayBuffer();
  }
  assert.equal(requests, 0);

  const assistant = { role: 'assistant', content: '上一轮', reasoning_content: '上次的思考' };
  const accepted = await streamEvents({ messages: [{ role: 'user', content: '继续' }, assistant] });
  assert.equal(accepted.status, 200);
  assert.equal(requests, 1);
  assert.deepEqual(seen.messages, [{ role: 'user', content: '继续' }, assistant]);
});

test('chat response is unchanged when upstream returns no reasoning', async t => {
  const upstream = await startUpstream(async (req, res) => {
    await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  t.after(upstream.close);
  process.env.QFLI_AI_BASE_URL = upstream.base;

  const response = await fetch(`${appBase}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify({ messages }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { aiGenerated: true, model: TEST_MODEL,
    message: { role: 'assistant', content: 'ok' } });
  assert.equal('reasoning_content' in body.message, false);
});