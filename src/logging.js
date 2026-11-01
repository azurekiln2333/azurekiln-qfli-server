const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requests = new AsyncLocalStorage();

function log(event, fields = {}, level = 'info') {
  const context = requests.getStore();
  const entry = { time: new Date().toISOString(), level, event,
    requestId: context?.requestId, stage: context?.stage, ...fields };
  (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
}

function stage(name) {
  const context = requests.getStore();
  if (context) context.stage = name;
}

function requestContext(req, res, next) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  req.requestId = requestId;
  const path = req.path;
  req.requestPath = path;
  res.set('X-Request-Id', requestId);
  const context = { requestId, stage: 'request' };
  requests.run(context, () => {
    if (path.startsWith('/api/auth/')) {
      log('auth.request', { method: req.method, path });
      res.on('finish', () => log('auth.response', {
        requestId, stage: context.stage, method: req.method, path,
        status: res.statusCode, durationMs: Date.now() - started,
      }));
    }
    next();
  });
}

module.exports = { log, stage, requestContext };
