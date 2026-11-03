// 零依赖静态检查：语法、package.json 可解析、脚本入口存在。
//
// 客户端验收第 12 条要求服务端有 npm run lint。这里不引入新依赖，
// 只做 node --check 级别的语法体检，加上几项容易悄悄坏掉的约定：
//   - package.json 必须是合法 JSON，且 name/version/scripts 齐全；
//   - scripts 里声明的入口文件必须存在（改了文件名忘改脚本就挂在这里）；
//   - 源码里不得出现 require/import 指向不存在的本地模块。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'coverage', '.git']);
const SOURCE_DIRS = ['src', 'test', 'scripts'];
const CODE_FILE = /\.(js|cjs|mjs)$/;

const failures = [];
let checked = 0;

function walk(directory) {
  let items;
  try {
    items = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const item of items) {
    if (SKIP_DIRS.has(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...walk(path));
    else if (CODE_FILE.test(item.name)) files.push(path);
  }
  return files;
}

function relative(path) {
  return path.slice(root.length + 1).replaceAll('\\', '/');
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  checked += 1;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 6).join('\n');
    failures.push(`${relative(file)} 语法检查失败\n${detail}`);
  }
}

function checkPackageJson() {
  const path = join(root, 'package.json');
  if (!existsSync(path)) {
    failures.push('package.json 不存在');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`package.json 不是合法 JSON：${error.message}`);
    return;
  }
  for (const field of ['name', 'version', 'scripts']) {
    if (!manifest[field]) failures.push(`package.json 缺少 ${field}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) {
    failures.push(`package.json 的 version 不是语义化版本：${manifest.version}`);
  }
  for (const [name, command] of Object.entries(manifest.scripts || {})) {
    // 只校验以文件为入口的脚本，npm 内置与 node 子命令不在此列。
    // 参数里可能夹带选项或环境变量，逐个 token 看结尾是不是路径。
    for (const token of String(command).split(/\s+/)) {
      if (!/\.(?:js|cjs|mjs)$/.test(token)) continue;
      const candidate = token.replace(/^['"]|['"]$/g, '');
      const entry = join(root, candidate);
      if (!existsSync(entry)) failures.push(`npm run ${name} 指向的文件不存在：${candidate}`);
    }
  }
}

// 本地相对模块必须真实存在，否则要等到运行时才炸。
function checkLocalImports(file, text) {
  const specifiers = [
    ...text.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    const target = resolve(dirname(file), specifier);
    const candidates = [target, `${target}.js`, `${target}.cjs`, join(target, 'index.js'), join(target, 'index.cjs')];
    const found = candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (!found) failures.push(`${relative(file)} 引用了不存在的模块：${specifier}`);
  }
}

for (const directory of SOURCE_DIRS) {
  for (const file of walk(join(root, directory))) {
    checkSyntax(file);
    checkLocalImports(file, readFileSync(file, 'utf8'));
  }
}

checkPackageJson();

if (failures.length > 0) {
  for (const failure of failures) console.error(`✖ ${failure}`);
  console.error(`\nlint 失败：${failures.length} 项（已检查 ${checked} 个文件）`);
  process.exit(1);
}

console.info(`lint 通过：检查了 ${checked} 个 JavaScript 文件与 package.json`);
