// AI 编程助手：服务端固定上游地址、密钥和模型，客户端只能提交消息与工具。
// 另提供联网工具：web_search 走可替换的搜索 provider，web_fetch 带 SSRF 守卫。
const express = require('express');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const ai = require('../ai-client');
const search = require('../web-search');
const webFetch = require('../web-fetch');

const router = express.Router();

router.post('/chat', authRequired, async (req, res) => {
  let result;
  try {
    result = await ai.chat(req.body, { req, res });
  } catch (error) {
    if (res.destroyed) return;
    throw error;
  }
  await audit(req, {
    action: 'ai.chat',
    target: `ai:${req.userId}`,
    detail: `model=${result.model} toolCalls=${result.message.tool_calls?.length || 0}`,
  });
  if (!res.destroyed) res.json(result);
});

// ---- 联网工具 ----

// 每用户每分钟上限，避免把搜索当成抓取代理滥用。
const WEB_RATE_LIMIT = 30;
const WEB_WINDOW_MS = 60 * 1000;
const webWindows = new Map();

setInterval(() => {
  const cutoff = Date.now() - WEB_WINDOW_MS;
  for (const [userId, timestamps] of webWindows) {
    if (!timestamps.some(value => value > cutoff)) webWindows.delete(userId);
  }
}, WEB_WINDOW_MS).unref();

function admitWeb(userId) {
  const now = Date.now();
  if (!webWindows.has(userId) && webWindows.size >= 10000) {
    const error = new Error('联网工具请求过于频繁，请稍后再试');
    error.status = 429;
    throw error;
  }
  const recent = (webWindows.get(userId) || []).filter(time => now - time < WEB_WINDOW_MS);
  if (recent.length >= WEB_RATE_LIMIT) {
    webWindows.set(userId, recent);
    const error = new Error('联网工具请求过于频繁，请稍后再试');
    error.status = 429;
    throw error;
  }
  recent.push(now);
  webWindows.set(userId, recent);
}

function replyError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 400;
  res.status(status).json({ error: error.message });
}

router.post('/web_search', authRequired, async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: '查询不能为空' });
  if (query.length > search.MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `查询超过 ${search.MAX_QUERY_LENGTH} 字符` });
  }
  const provider = search.providerByName(process.env.QFLI_SEARCH_PROVIDER);
  if (!provider) return res.status(503).json({ error: '搜索服务未配置' });
  const limit = Number(req.body?.limit);
  let results;
  try {
    admitWeb(req.userId);
    results = await provider.search(query, {
      limit: Number.isFinite(limit) ? limit : search.MAX_RESULTS,
    });
  } catch (error) {
    return replyError(res, error);
  }
  await audit(req, {
    action: 'ai.web_search',
    target: `ai:${req.userId}`,
    // 只记录条数与 provider，不记录查询内容。
    detail: `provider=${provider.name} results=${results.length}`,
  });
  res.json({ provider: provider.name, results });
});

router.post('/web_fetch', authRequired, async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: '网址不能为空' });
  if (url.length > 2048) return res.status(400).json({ error: '网址超过 2048 字符' });
  let page;
  try {
    admitWeb(req.userId);
    page = await webFetch.fetchPage(url);
  } catch (error) {
    // SSRF 拒绝与目标站点失败都按 400 返回，不泄露内部地址细节。
    return replyError(res, error);
  }
  await audit(req, {
    action: 'ai.web_fetch',
    target: `ai:${req.userId}`,
    detail: `chars=${page.text.length} truncated=${page.truncated}`,
  });
  res.json(page);
});

module.exports = router;
