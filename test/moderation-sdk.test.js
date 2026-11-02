// 真正走 @azurekiln/moderation-client 的集成测试：不注入替身，用本机 HTTP 假审核服务。
// 目的是证明生产路径（SDK → HTTP → 契约）确实可用，而不是只有替身在跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const client = require('../src/moderation-client');

const APP_ID = 'qflistudio';
const API_KEY = 'k'.repeat(40);
const ADMIN_KEY = 'a'.repeat(40);

const requests = [];
let handler = null;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : undefined;
  requests.push({ method: req.method, url: req.url, headers: req.headers, body });
  const reply = handler(req, body);
  if (reply) {
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not_found"}');
});

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.MODERATION_BASE_URL = baseUrl;
  process.env.MODERATION_APP_ID = APP_ID;
  process.env.MODERATION_API_KEY = API_KEY;
  process.env.MODERATION_ADMIN_KEY = ADMIN_KEY;
  process.env.MODERATION_TIMEOUT_MS = '2000';
});

test.after(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  delete process.env.MODERATION_BASE_URL;
  delete process.env.MODERATION_APP_ID;
  delete process.env.MODERATION_API_KEY;
  delete process.env.MODERATION_ADMIN_KEY;
  delete process.env.MODERATION_TIMEOUT_MS;
});

test.beforeEach(() => {
  requests.length = 0;
  handler = () => null;
});

function check(decision, extra = {}) {
  return {
    status: 200,
    body: {
      id: 'decision-uuid', decision, categories: [], hits: [],
      createdAt: '2026-11-02T00:00:00.000Z', ...extra,
    },
  };
}

test('the SDK is installed and carries the API-key contract', async () => {
  handler = () => check('pass');
  const result = await client.call('checkText', { scene: 'community.post.title', text: '正常标题', userId: 'user_1' });
  assert.equal(result.decision, 'pass');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/text/check');
  assert.equal(request.headers['x-app-id'], APP_ID);
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(request.body, { scene: 'community.post.title', text: '正常标题', userId: 'user_1' });
});

test('block and review decisions pass through with categories and reviewId', async () => {
  handler = () => check('block', { categories: ['prohibited_goods'] });
  const blocked = await client.call('checkText', { scene: 'community.comment', text: '违禁文本' });
  assert.equal(blocked.decision, 'block');
  assert.deepEqual(blocked.categories, ['prohibited_goods']);

  handler = () => check('review', { reviewId: 'review-1' });
  const review = await client.call('checkText', { scene: 'community.comment', text: '待审文本' });
  assert.equal(review.decision, 'review');
  assert.equal(review.reviewId, 'review-1');
});

test('IP checks use the same endpoint and drop empty fields', async () => {
  handler = () => check('block', { categories: ['ip_restricted'] });
  const result = await client.call('checkIp', { scene: 'community.post', ip: '203.0.113.7', userId: undefined });
  assert.equal(result.decision, 'block');
  assert.equal(requests[0].url, '/v1/ip/check');
  assert.deepEqual(requests[0].body, { scene: 'community.post', ip: '203.0.113.7' });
});

test('service errors become ModerationUnavailableError (fail closed)', async () => {
  handler = () => ({ status: 503, body: { error: 'moderation_unavailable', message: 'down' } });
  await assert.rejects(
    client.call('checkText', { scene: 'community.post', text: 'x' }),
    (err) => err instanceof client.ModerationUnavailableError && err.code === 'moderation.unavailable',
  );
});

test('a malformed check body is never treated as pass', async () => {
  handler = () => ({ status: 200, body: { decision: 'pass' } });
  await assert.rejects(
    client.call('checkText', { scene: 'community.post', text: 'x' }),
    (err) => err instanceof client.ModerationUnavailableError,
  );
});

test('an unreachable service fails closed instead of hanging', async () => {
  process.env.MODERATION_BASE_URL = 'http://127.0.0.1:1';
  try {
    await assert.rejects(
      client.call('checkText', { scene: 'community.post', text: 'x' }),
      (err) => err instanceof client.ModerationUnavailableError,
    );
  } finally {
    process.env.MODERATION_BASE_URL = baseUrl;
  }
});

test('reports go through submitReport and keep the moderation report id', async () => {
  handler = () => ({
    status: 201,
    body: { id: 'moderation-report-1', status: 'open', createdAt: '2026-11-02T00:00:00.000Z' },
  });
  const result = await client.call('submitReport', {
    targetType: 'post', targetId: 'post_1', reporterId: 'user_1', reason: '广告',
  });
  assert.equal(result.id, 'moderation-report-1');
  assert.equal(requests[0].url, '/v1/reports');
  assert.equal(requests[0].headers.authorization, `Bearer ${API_KEY}`);
});

test('admin proxies use the admin key and the v1 admin paths', async () => {
  handler = () => ({ status: 200, body: { items: [{ id: 'kw1', word: '测试' }], total: 1, limit: 50, offset: 0 } });
  const list = await client.call('listKeywords', { limit: 50, offset: 0, category: 'custom' });
  assert.equal(list.total, 1);
  assert.equal(requests[0].url, '/v1/admin/keywords?limit=50&offset=0&category=custom');
  assert.equal(requests[0].headers.authorization, `Bearer ${ADMIN_KEY}`);

  handler = () => ({ status: 201, body: { id: 'kw2' } });
  await client.call('createKeyword', { word: '测试词', category: 'custom' });
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].url, '/v1/admin/keywords');

  handler = () => ({ status: 200, body: { deleted: true } });
  await client.call('deleteKeyword', { id: 'kw2' });
  assert.equal(requests[2].method, 'DELETE');
  assert.equal(requests[2].url, '/v1/admin/keywords/kw2');
  assert.equal(requests[2].headers.authorization, `Bearer ${ADMIN_KEY}`);
});

test('admin proxying without MODERATION_ADMIN_KEY fails closed', async () => {
  const saved = process.env.MODERATION_ADMIN_KEY;
  delete process.env.MODERATION_ADMIN_KEY;
  try {
    await assert.rejects(client.call('listIpRules', {}), (err) => err instanceof client.ModerationUnavailableError);
  } finally {
    process.env.MODERATION_ADMIN_KEY = saved;
  }
});
