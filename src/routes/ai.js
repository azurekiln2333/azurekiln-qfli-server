// AI 编程助手：服务端管理上游地址和密钥。
// 客户端从上游模型列表中选择模型。
// 另提供联网抓取工具：web_fetch 带 SSRF 守卫。
//
// web_search 已于 2026-11 合规整改下线：搜索走 Bing，会引入未披露的第三方。
// 工具不再对外暴露，客户端也同步移除（§1 不得新增未披露的第三方）。
const express = require('express');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const ai = require('../ai-client');
const webFetch = require('../web-fetch');

const router = express.Router();

router.get('/models', authRequired, async (req, res) => {
  try {
    const result = await ai.models({ req, res });
    if (!res.destroyed) res.json(result);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
});

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

// 每用户每分钟上限，避免把抓取当成代理滥用。
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
