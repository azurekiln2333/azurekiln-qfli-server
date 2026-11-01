// Cloud files stay in business storage and never enter terminal host mounts.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const { createId, isId } = require('../entity-id');
const { ApiError } = require('../gateway');
const storage = require('../cloud-storage');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..', 'data', 'cloud');
const mutations = new Set();

function mutate(handler) {
  return async (req, res) => {
    if (mutations.has(req.userId)) throw new ApiError(409, '云项目正在保存，请稍后重试');
    mutations.add(req.userId);
    try { await handler(req, res); } finally { mutations.delete(req.userId); }
  };
}

function ensureUserRoot(userId) {
  if (!isId('users', userId)) throw new ApiError(400, '用户 ID 无效');
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
  storage.directory(ROOT);
  const dir = path.join(ROOT, `u${userId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return storage.directory(dir);
}

async function projectDir(userId, projectId) {
  if (!isId('cloud_projects', projectId)) return null;
  const row = await db.prepare('SELECT id FROM cloud_projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  if (!row) return null;
  const dir = path.join(ensureUserRoot(userId), `p${projectId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return storage.directory(dir);
}

function filePath(dir, relative) {
  const full = storage.safeJoin(dir, relative);
  if (!full) throw new ApiError(400, '非法路径，不能访问不安全文件或 Git 内部目录');
  return full;
}

function walkTree(dir, base, out, depth = 0, budget = { entries: 0 }) {
  if (depth > 32) throw new ApiError(413, '云项目目录层级超出限制');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (++budget.entries > 10000) throw new ApiError(413, '云项目目录数量超出限制');
    if (entry.name.toLowerCase() === '.git') continue;
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    if (!storage.safeNode(stat)) throw new ApiError(400, '云项目含不安全文件，请管理员核对');
    if (stat.isDirectory()) walkTree(full, base, out, depth + 1, budget);
    else if (stat.isFile()) {
      if (out.length >= storage.MAX_FILES) throw new ApiError(413, '云项目文件数量超出限制');
      out.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: stat.size, mtime: stat.mtimeMs });
    }
  }
}

router.get('/cloud/projects', authRequired, async (req, res) => {
  const rows = await db.prepare(`SELECT id, name, created_at${db.entityIdsMigrated
    ? ", (SELECT old_id FROM qfli_entity_id_migration WHERE entity_type = 'cloud_projects' AND new_id = cloud_projects.id) AS legacy_id" : ''}
    FROM cloud_projects WHERE user_id = ? ORDER BY created_at DESC, id`).all(req.userId);
  if (rows.length > storage.MAX_PROJECTS) throw new ApiError(413, '历史云项目超过限额，请管理员核对');
  const items = [];
  for (const row of rows) {
    const dir = await projectDir(req.userId, row.id);
    const files = [];
    if (dir) walkTree(dir, dir, files);
    items.push({ id: row.id, legacyId: row.legacy_id || null, name: row.name,
      createdAt: row.created_at, files: files.length });
  }
  res.json({ items });
});

router.post('/cloud/projects', authRequired, mutate(async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new ApiError(400, '项目名需为 1-40 字');
  const count = await db.prepare('SELECT COUNT(*) AS count FROM cloud_projects WHERE user_id = ?').get(req.userId);
  if (Number(count.count) >= storage.MAX_PROJECTS) throw new ApiError(413, '最多保存 50 个云项目');
  storage.usage(ensureUserRoot(req.userId));
  storage.ensureSpace(ROOT, 4096);
  const exists = await db.prepare('SELECT id FROM cloud_projects WHERE user_id = ? AND name = ?').get(req.userId, name);
  if (exists) return res.status(409).json({ error: '同名云端项目已存在' });
  const projectId = createId('cloud_projects');
  await db.prepare('INSERT INTO cloud_projects (id, user_id, name) VALUES (?, ?, ?)').run(projectId, req.userId, name);
  await projectDir(req.userId, projectId);
  await audit(req, { action: 'cloud.project_create', target: `cloud:${projectId}` });
  res.status(201).json({ id: projectId, name });
}));

router.delete('/cloud/projects/:id', authRequired, mutate(async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  fs.rmSync(dir, { recursive: true, force: true });
  await db.prepare('DELETE FROM cloud_projects WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  await audit(req, { action: 'cloud.project_delete', target: `cloud:${req.params.id}` });
  res.json({ ok: true });
}));

router.get('/cloud/projects/:id/files', authRequired, async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  const files = [];
  walkTree(dir, dir, files);
  res.json({ files });
});

router.get('/cloud/projects/:id/file', authRequired, async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  const full = filePath(dir, req.query.path);
  if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) return res.status(404).json({ error: '文件不存在' });
  const stat = fs.lstatSync(full);
  if (stat.size > storage.MAX_FILE_BYTES) throw new ApiError(413, '单个云文件不能超过 1 MiB');
  res.json({ path: req.query.path, content: fs.readFileSync(full).toString('base64'), mtime: stat.mtimeMs });
});

router.put('/cloud/projects/:id/file', authRequired, mutate(async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  const { path: relative, content } = req.body || {};
  const full = filePath(dir, relative);
  const data = storage.decode(content);
  storage.checkWrites(ensureUserRoot(req.userId), [{ full, data }]);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  await audit(req, { action: 'cloud.file_write', target: `cloud:${req.params.id}/${relative}` });
  res.json({ path: relative, mtime: fs.lstatSync(full).mtimeMs });
}));

router.delete('/cloud/projects/:id/file', authRequired, mutate(async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  const full = filePath(dir, req.query.path);
  fs.rmSync(full, { recursive: true, force: true });
  await audit(req, { action: 'cloud.file_delete', target: `cloud:${req.params.id}/${req.query.path}` });
  res.json({ ok: true });
}));

router.post('/cloud/projects/:id/sync', authRequired, mutate(async (req, res) => {
  const dir = await projectDir(req.userId, req.params.id);
  if (!dir) return res.status(404).json({ error: '项目不存在' });
  const { files = [], deletes = [] } = req.body || {};
  if (!Array.isArray(files) || !Array.isArray(deletes) || files.length + deletes.length > 512) {
    throw new ApiError(400, '每次同步最多 512 个文件操作');
  }
  const writes = files.map(file => {
    if (!file || typeof file !== 'object') throw new ApiError(400, '同步文件无效');
    return { path: file.path, full: filePath(dir, file.path), data: storage.decode(file.content) };
  });
  const removals = deletes.map(relative => ({ path: relative, full: filePath(dir, relative) }));
  storage.checkWrites(ensureUserRoot(req.userId), writes);
  const applied = [];
  for (const file of writes) {
    fs.mkdirSync(path.dirname(file.full), { recursive: true });
    fs.writeFileSync(file.full, file.data);
    applied.push({ path: file.path, mtime: fs.lstatSync(file.full).mtimeMs });
  }
  for (const file of removals) {
    fs.rmSync(file.full, { recursive: true, force: true });
    applied.push({ path: file.path, deleted: true });
  }
  await audit(req, { action: 'cloud.sync', target: `cloud:${req.params.id}`,
    detail: `write=${writes.length} delete=${removals.length}` });
  res.json({ applied });
}));

router.post('/cloud/projects/:id/git', authRequired, (_req, res) => {
  res.status(503).json({ error: '云端 Git 安全执行环境尚未配置，已禁止宿主机执行' });
});

module.exports = router;
