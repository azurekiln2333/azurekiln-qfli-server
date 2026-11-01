// 客户端 IP：只信任反向代理写入的 X-Real-IP。
// 不再解析客户端可伪造的 X-Forwarded-For（见 2026-11 整改任务书 §3-W2 可信代理）。
// 源端口同理，取 X-Real-Port；两者都由 nginx 的 proxy_set_header 设置。
function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > 0 && text.length <= 64 ? text : '';
}

function clientIp(req) {
  const real = normalizeIp(req.headers['x-real-ip']);
  if (real) return real;
  const address = req.socket?.remoteAddress || '';
  // IPv4-mapped IPv6 归一成 IPv4。
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function clientPort(req) {
  const port = Number.parseInt(String(req.headers['x-real-port'] || ''), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

module.exports = { clientIp, clientPort, normalizeIp };
