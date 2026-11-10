// QFLIStudio+ 社区与在线终端服务。
const express = require('express');
const cors = require('cors');
const path = require('node:path');

require('./identity'); // Validate the session secret before database migrations.
const db = require('./db');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const commentRoutes = require('./routes/comments');
const terminalRoutes = require('./routes/terminal');
const auditRoutes = require('./routes/audit');
const cloudRoutes = require('./routes/cloud');
const sqlRoutes = require('./routes/sql');
const aiRoutes = require('./routes/ai');
const reportRoutes = require('./routes/reports');
const moderationAdminRoutes = require('./routes/moderation-admin');
const { ApiError } = require('./gateway');
const { realnameRequired } = require('./client-context');
const { log, requestContext } = require('./logging');

// Express 4 does not forward rejected route/middleware promises automatically.
for (const router of [authRoutes, userRoutes, postRoutes, commentRoutes, terminalRoutes, auditRoutes, cloudRoutes, sqlRoutes, aiRoutes, reportRoutes, moderationAdminRoutes]) {
  for (const layer of router.stack) {
    for (const handler of layer.route ? layer.route.stack : [layer]) {
      const original = handler.handle;
      if (original.length === 4) continue;
      handler.handle = (req, res, next) => {
        try { Promise.resolve(original(req, res, next)).catch(next); } catch (err) { next(err); }
      };
    }
  }
}

const app = express();
app.use(cors());
app.use(requestContext);
const terminalJson = express.json({ limit: '384kb', inflate: false });
app.use('/api/terminal', (req, res, next) => terminalJson(req, res, error => {
  if (error) return next(new ApiError(error.status === 413 ? 413 : 400,
    error.status === 413 ? '终端请求超过 384 KiB 限额' : '终端请求格式无效'));
  next();
}));
const aiJson = express.json({ limit: '640kb', inflate: false });
app.use('/api/ai', (req, res, next) => aiJson(req, res, error => {
  if (error) return next(new ApiError(error.status === 413 ? 413 : 400,
    error.status === 413 ? 'AI 请求超过 640 KiB 限额' : 'AI 请求格式无效'));
  next();
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    name: 'azurekiln-qfli-server',
    version: require('../package.json').version,
    db: db.driver,
  }),
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
// 实名门槛：没有已验证手机号时，以下联网服务一律 403 realname.required。
// 只挂在挂载层，不改业务路由内部；/api/users（含注销）与 /api/auth 不在此列。
app.use('/api', realnameRequired, postRoutes);
app.use('/api', realnameRequired, commentRoutes);
app.use('/api/terminal', realnameRequired, terminalRoutes);
app.use('/api/sql', realnameRequired, sqlRoutes);
app.use('/api', realnameRequired, cloudRoutes);
app.use('/api', auditRoutes);
app.use('/api', realnameRequired, reportRoutes);
app.use('/api/admin', moderationAdminRoutes);
app.use('/api/ai', realnameRequired, aiRoutes);

// 统一错误处理：不让异常拖垮进程。
app.use((err, req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = err instanceof ApiError ? err.status : 500;
  log('request.failed', { method: req.method, path: req.requestPath, status,
    errorType: err.name, errorKey: err.details?.errorKey,
    code: /^[A-Z0-9_]{1,64}$/.test(err.code || '') ? err.code : undefined,
  }, status >= 500 ? 'error' : 'info');
  if (err instanceof ApiError) return res.status(status).json({ error: err.message, ...err.details, requestId: req.requestId });
  res.status(500).json({ error: '服务器内部错误', requestId: req.requestId });
});

const PORT = Number(process.env.PORT) || 3000;
// 等数据库初始化（建表/迁移/种子）完成后再对外监听；失败则拒绝启动。
db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `azurekiln-qfli-server listening on http://0.0.0.0:${PORT} (db: ${db.driver})`,
      );
    });
  })
  .catch((err) => {
    console.error('[db] 初始化失败，服务未启动：', err.message);
    process.exit(1);
  });
