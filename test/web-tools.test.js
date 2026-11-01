// 联网抓取工具的离线单测：SSRF 守卫、正文提取与路由边界。
// 不访问外网：DNS 全部注入替身。
//
// 2026-11 合规整改：web_search 已下线（搜索走 Bing，属未披露的第三方），
// 原先的 RSS 解析与 provider 用例随 src/web-search.js 一起删除。
const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const fs = require('node:fs');

const webFetch = require('../src/web-fetch');
const AI_ROUTES = path.join(__dirname, '..', 'src', 'routes', 'ai.js');

test('the web search module and its Bing call are gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'web-search.js')), false,
    'src/web-search.js must stay deleted');
  const aiRoutes = fs.readFileSync(AI_ROUTES, 'utf8');
  assert.ok(!/bing\.com/i.test(aiRoutes), 'the AI router must not reference Bing');
  assert.ok(!/web_search\s*'/.test(aiRoutes), 'web_search must not be exposed');
});

test('SSRF guard rejects loopback, link-local and private ranges', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ];
  for (const address of blocked) {
    assert.equal(webFetch.isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(webFetch.isBlockedAddress(address), false, address);
  }
});

test('assertPublicHost rejects localhost names without any lookup', async () => {
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: '127.0.0.1' }];
  };
  await assert.rejects(() => webFetch.assertPublicHost('localhost', { lookup }), /本机/);
  await assert.rejects(() => webFetch.assertPublicHost('api.localhost', { lookup }), /本机/);
  assert.equal(lookups, 0);
});

test('assertPublicHost rejects a hostname resolving to a private address', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.1.2.3' }];
  await assert.rejects(() => webFetch.assertPublicHost('mixed.example', { lookup }), /内网/);
});

test('assertPublicHost accepts a hostname with only public records', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }];
  assert.deepEqual(await webFetch.assertPublicHost('example.com', { lookup }), ['93.184.216.34']);
});

test('fetchPage rejects non-http schemes and embedded credentials', async () => {
  await assert.rejects(() => webFetch.fetchPage('file:///etc/passwd'), /http/);
  await assert.rejects(() => webFetch.fetchPage('ftp://example.com/a'), /http/);
  await assert.rejects(() => webFetch.fetchPage('https://user:pass@example.com/'), /用户名/);
  await assert.rejects(() => webFetch.fetchPage('not a url'), /无效/);
});

test('fetchPage blocks the request before connecting to a private host', async () => {
  let fetched = 0;
  const lookup = async () => [{ address: '127.0.0.1' }];
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetched += 1;
    return new Response('secret', { status: 200 });
  };
  try {
    await assert.rejects(
      () => webFetch.fetchPage('http://internal.example/admin', { lookup }),
      /内网/,
    );
    assert.equal(fetched, 0, 'no connection may be attempted');
  } finally {
    global.fetch = originalFetch;
  }
});

test('extractText strips scripts, styles and tags', () => {
  const html = `<html><head><title>  Hello &amp; World </title>
    <style>.a{color:red}</style></head>
    <body><script>evil()</script><h1>标题</h1><p>第一段</p><div>第二段</div></body></html>`;
  const { title, text } = webFetch.extractText(html);
  assert.equal(title, 'Hello & World');
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('第一段'));
  assert.ok(!text.includes('evil'));
  assert.ok(!text.includes('color:red'));
});

test('normalizeText collapses blank lines and padding', () => {
  assert.equal(webFetch.normalizeText('  a \n\n\n b\t\tc  '), 'a\nb c');
});
