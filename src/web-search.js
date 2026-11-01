// 联网检索 provider：统一接口 + 单一实现（Bing RSS）。
//
// 设计取舍记录在任务 design.md：Bing RSS 无需付费密钥、返回机器可读结构、
// 中英文查询都可用。provider 藏在接口后面，换后端不动工具契约。
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const BING_ENDPOINT = 'https://www.bing.com/search';
// Bing 拒绝默认的脚本 UA；带上常规浏览器 UA 才能拿到 RSS。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 先去标签再解实体：CDATA 内容要先展开，否则会被当成标签剥掉。
function stripTags(value) {
  return decodeXml(decodeXml(value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// 模板字符串里的反斜杠会原样保留，正则要写成 [\s\S] 而不是双反斜杠。
function pickTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1] : '';
}

// 解析 Bing RSS 条目。只接受 http/https 链接，其余条目丢弃。
function parseRss(xml, limit) {
  const results = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const chunk of items) {
    const item = chunk.split(/<\/item>/i)[0];
    const title = stripTags(pickTag(item, 'title'));
    const link = decodeXml(pickTag(item, 'link')).trim();
    const snippet = stripTags(pickTag(item, 'description'));
    if (!link) continue;
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (!title && !snippet) continue;
    results.push({ title: title || url.toString(), url: url.toString(), snippet });
    if (results.length >= limit) break;
  }
  return results;
}

async function readBounded(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      // 超限时保留已读部分：搜索结果是列表，截断尾部不致命。
      chunks.push(Buffer.from(chunk).subarray(0, chunk.length - (bytes - maxBytes)));
      break;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

class BingRssProvider {
  constructor({ endpoint = BING_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.name = 'bing-rss';
  }

  async search(query, { limit = MAX_RESULTS, timeoutMs } = {}) {
    const boundedLimit = Math.min(MAX_RESULTS, Math.max(1, Number(limit) || MAX_RESULTS));
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'rss');
    url.searchParams.set('count', String(boundedLimit));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/xml' },
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch (_) { /* 忽略取消失败 */ }
        throw new Error(`search upstream status ${response.status}`);
      }
      return parseRss(await readBounded(response, MAX_RESPONSE_BYTES), boundedLimit);
    } finally {
      clearTimeout(timer);
    }
  }
}

const PROVIDERS = {
  'bing-rss': () => new BingRssProvider(),
};

// 未配置时默认 bing-rss；未知名称返回 null，调用方 fail closed。
function providerByName(name) {
  const key = (name || 'bing-rss').trim().toLowerCase();
  const factory = PROVIDERS[key];
  return factory ? factory() : null;
}

module.exports = {
  BingRssProvider,
  providerByName,
  parseRss,
  stripTags,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
};
