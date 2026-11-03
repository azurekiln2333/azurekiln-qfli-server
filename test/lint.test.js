// lint 脚本自身的回归测试。
//
// 验收第 12 条要求 npm run lint 存在并能挡住坏代码。只让脚本"能跑"不够，
// 必须断言它在真有问题时报错，否则将来被改坏也发现不了。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(SERVER_ROOT, 'scripts', 'check.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));

// 夹具里的坏样本直接拼字符串。测试文件本身就是扫描对象，
// 字面量的 require 语句会被 lint 当真，因此下面一律用拼接避让。
const BROKEN_IMPORT = `${'con'}st b = ${'requ'}ire('./${'missing'}');\n`;

function run(cwd, script) {
  return spawnSync(process.execPath, [script || SCRIPT], { cwd, encoding: 'utf8' });
}

// 在临时目录里造一个最小的服务端，再按需塞入坏样本。
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-lint-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', scripts: { lint: 'node scripts/check.mjs' },
  }, null, 2));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check.mjs'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { dir, script: path.join(dir, 'scripts', 'check.mjs') };
}

test('npm run lint is declared', () => {
  assert.equal(MANIFEST.scripts.lint, 'node scripts/check.mjs');
  assert.ok(fs.existsSync(SCRIPT), 'scripts/check.mjs 必须存在');
});

test('the real server tree passes lint', () => {
  const result = run(SERVER_ROOT);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lint 通过/);
});

test('lint fails on a syntax error', () => {
  const { dir, script } = fixture({ 'src/broken.js': 'function (\n' });
  const result = run(dir, script);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /语法检查失败/);
});

test('lint fails on a local import that does not exist', () => {
  const { dir, script } = fixture({ 'src/a.js': BROKEN_IMPORT });
  const result = run(dir, script);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /引用了不存在的模块：\.\/missing/);
});

test('lint fails when package.json is not valid JSON', () => {
  const { dir, script } = fixture({});
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "fixture",\n');
  const result = run(dir, script);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不是合法 JSON/);
});

test('lint fails when a script points at a missing file', () => {
  const { dir, script } = fixture({});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', scripts: { start: 'node --env-file-if-exists=.env src/server.js' },
  }, null, 2));
  const result = run(dir, script);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm run start 指向的文件不存在：src\/server\.js/);
});

test('lint skips node_modules and vendor', () => {
  const { dir, script } = fixture({
    'node_modules/broken/index.js': 'function (\n',
    'vendor/broken/index.js': 'function (\n',
    'src/ok.js': "'use strict';\nmodule.exports = 1;\n",
  });
  const result = run(dir, script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
