const fs = require('node:fs');
const path = require('node:path');
const { ApiError } = require('./gateway');

const MAX_USER_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_PROJECTS = 50;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10000;

function ensureSpace(root, additionalBytes = 0) {
  const info = fs.statfsSync(root);
  const free = info.bavail * info.bsize;
  const reserve = Math.max(1024 * 1024 * 1024, info.blocks * info.bsize * 0.1);
  if (free - additionalBytes < reserve) throw new ApiError(507, '云存储空间不足，已暂停写入');
}

function directory(dir) {
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ApiError(400, '云项目目录无效');
  return dir;
}

function safeNode(stat) {
  return !stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1));
}

function safeJoin(root, value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.length > 32 || parts.some((part) => !part || part === '.' || part === '..' ||
      part.toLowerCase() === '.git' || part.length > 255)) return null;
  directory(root);
  const full = path.resolve(root, ...parts);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!safeNode(stat)) return null;
      if (current !== full && !stat.isDirectory()) return null;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      break;
    }
  }
  return full;
}

function usage(root) {
  directory(root);
  const result = { bytes: 0, files: 0, entries: 0 };
  function visit(dir, depth) {
    if (depth > 34) throw new ApiError(413, '云项目目录层级超出限制');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++result.entries > MAX_ENTRIES) throw new ApiError(413, '云项目目录数量超出限制');
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (!safeNode(stat)) throw new ApiError(400, '云项目含不安全文件，请管理员核对');
      if (stat.isDirectory()) visit(full, depth + 1);
      else if (stat.isFile()) { result.files++; result.bytes += stat.size; }
      if (result.files > MAX_FILES || result.bytes > MAX_USER_BYTES) {
        throw new ApiError(413, '云项目存储已达到限额（256 MiB / 5000 文件）');
      }
    }
  }
  visit(root, 0);
  return result;
}

function decode(content) {
  if (typeof content !== 'string' || content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
      content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new ApiError(400, '文件内容需要有效的 Base64');
  }
  const data = Buffer.from(content, 'base64');
  if (data.length > MAX_FILE_BYTES) throw new ApiError(413, '单个云文件不能超过 1 MiB');
  return data;
}

function checkWrites(userRoot, writes) {
  const totals = usage(userRoot);
  const originalBytes = totals.bytes;
  const sizes = new Map();
  const newEntries = new Set();
  for (const { full, data } of writes) {
    let previous = sizes.get(full);
    if (previous === undefined) {
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || !safeNode(stat)) throw new ApiError(400, '不能覆盖目录或不安全文件');
        previous = stat.size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        previous = 0;
        totals.files++;
      }
    }
    totals.bytes += data.length - previous;
    sizes.set(full, data.length);
    let candidate = full;
    while (candidate !== userRoot && !fs.existsSync(candidate)) {
      newEntries.add(candidate);
      candidate = path.dirname(candidate);
    }
    if (totals.files > MAX_FILES || totals.bytes > MAX_USER_BYTES) {
      throw new ApiError(413, '云项目存储已达到限额（256 MiB / 5000 文件）');
    }
  }
  if (totals.entries + newEntries.size > MAX_ENTRIES) throw new ApiError(413, '云项目目录数量超出限制');
  for (const full of sizes.keys()) {
    let parent = path.dirname(full);
    while (parent !== userRoot) {
      if (sizes.has(parent)) throw new ApiError(400, '同步文件路径相互冲突');
      parent = path.dirname(parent);
    }
  }
  ensureSpace(userRoot, Math.max(0, totals.bytes - originalBytes) + newEntries.size * 4096);
}

module.exports = { directory, safeNode, safeJoin, usage, decode, checkWrites, ensureSpace, MAX_FILE_BYTES, MAX_FILES, MAX_PROJECTS };
