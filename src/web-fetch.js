// 网页抓取：SSRF 守卫 + 大小/时间上限 + 正文提取。
//
// 只接受 http/https；连接前解析主机并拒绝本机、私网、链路本地、CGNAT、
// 组播与保留地址。跳转逐跳校验，避免用重定向绕过守卫。
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 20000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALLOWED_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/xhtml+xml',
]);

function isBlockedIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(address) {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;
  // IPv4 映射地址 ::ffff:a.b.c.d
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(value)) return true; // ff00::/8
  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

// 主机名不可信：先挡字面量与 localhost，再解析全部 A/AAAA 记录。
async function assertPublicHost(hostname, { lookup = dns.lookup } = {}) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('网址缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('拒绝访问本机地址');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('拒绝访问本机或内网地址');
    return [host];
  }
  const records = await lookup(host, { all: true, verbatim: true });
  const list = Array.isArray(records) ? records : [records];
  const addresses = list.map(record => record.address).filter(Boolean);
  if (!addresses.length) throw new Error('无法解析主机名');
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new Error('拒绝访问本机或内网地址');
  }
  return addresses;
}

// 提取标题与纯文本。够用即可：去掉脚本、样式和标签，压缩空白。
function extractText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return { title, text: decodeEntities(body) };
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function normalizeText(value) {
  return value
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * 抓取一个公开网页。
 *
 * @param {string} rawUrl
 * @param {object} [options] lookup 可注入，便于测试离线验证守卫。
 * @returns {Promise<{url: string, title: string, text: string, truncated: boolean}>}
 */
async function fetchPage(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('网址无效');
  }
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('只允许 http 或 https 网址');
    }
    if (current.username || current.password) {
      throw new Error('网址不能包含用户名或密码');
    }
    await assertPublicHost(current.hostname, { lookup });

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('抓取超时');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new Error('抓取超时');
      throw new Error(`无法连接目标站点`);
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch (_) { /* 忽略 */ }
        if (!location) throw new Error('跳转缺少目标地址');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch (_) { /* 忽略 */ }
        throw new Error(`目标站点返回 ${response.status}`);
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type && !ALLOWED_TYPES.has(type)) {
        try { await response.body?.cancel(); } catch (_) { /* 忽略 */ }
        throw new Error(`不支持的内容类型：${type}`);
      }

      const chunks = [];
      let bytes = 0;
      let truncated = false;
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            chunks.push(Buffer.from(chunk).subarray(0, chunk.length - (bytes - MAX_BODY_BYTES)));
            truncated = true;
            break;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const { title, text } = extractText(raw);
      const normalized = normalizeText(text);
      const clipped = normalized.length > MAX_TEXT_CHARS
        ? normalized.slice(0, MAX_TEXT_CHARS)
        : normalized;
      return {
        url: current.toString(),
        title,
        text: clipped,
        truncated: truncated || clipped.length < normalized.length,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('跳转次数过多');
}

module.exports = {
  fetchPage,
  isBlockedAddress,
  assertPublicHost,
  extractText,
  normalizeText,
  CONNECT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_TEXT_CHARS,
};
