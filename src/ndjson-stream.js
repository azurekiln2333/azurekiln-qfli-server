// NDJSON 事件流的共用写入：在线终端和 AI 中转都调用它。
// 每个事件写一行。超过字节上限就返回错误。客户端接收慢时等 drain，避免占满内存。
const { ApiError } = require('./gateway');

// 等待客户端接收一行的上限。超过就按超时处理，避免慢连接占住请求。
const DRAIN_TIMEOUT_MS = 5000;

// 打开 NDJSON 响应并返回写入函数。错误文案由调用方传入，保持各自的现有文案。
function openNdjsonStream(res, { maxBytes, closed, overflow, timeout }) {
  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let bytes = 0;
  return async event => {
    if (res.destroyed || res.writableEnded) throw new ApiError(499, closed);
    const line = `${JSON.stringify(event)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > maxBytes) throw new ApiError(413, overflow);
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
      const close = () => finish(new ApiError(499, closed));
      const timer = setTimeout(() => finish(new ApiError(504, timeout)), DRAIN_TIMEOUT_MS);
      res.once('drain', drain);
      res.once('close', close);
      res.once('error', close);
      if (res.destroyed) close();
    });
  };
}

module.exports = { openNdjsonStream };
