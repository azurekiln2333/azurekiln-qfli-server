const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'qfli-sqlbox-'));
process.env.QFLI_SQLBOX_SOCKET = '/run/qfli-sqlbox/mysqld.sock';
process.env.QFLI_SQLBOX_ADMIN_PASSWORD = 'a'.repeat(64);
process.env.QFLI_SQLBOX_USER_SECRET = 'b'.repeat(64);
const sqlbox = require('../src/sqlbox');

const userA = 'user_11111111111111111111111111111111';
const userB = 'user_22222222222222222222222222222222';

test('derived accounts are stable, distinct and fit MySQL name limits', () => {
  const a = sqlbox.identity(userA);
  assert.deepEqual(sqlbox.identity(userA), a);
  assert.notEqual(a.user, sqlbox.identity(userB).user);
  assert.match(a.user, /^qs_[0-9a-f]{20}$/);
  assert.ok(a.user.length <= 32 && a.schema.length <= 64);
  assert.equal(a.pattern, `${a.prefix.slice(0, -1).replace(/_/g, '\\_')}\\_%`);
  assert.match(a.password, /^[0-9a-f]{64}$/);
});

test('binary cells render as uppercase hex like the native client', () => {
  assert.equal(sqlbox.cellText(Buffer.from([0xde, 0xad]), { binary: true }), 'DEAD');
  assert.equal(sqlbox.cellText(Buffer.from('张三'), { binary: false }), '张三');
  assert.equal(sqlbox.cellText(null, { binary: true }), null);
});

test('requests reject unknown fields, oversized SQL and bad params', () => {
  assert.throws(() => sqlbox._request({ source: 'SELECT 1', extra: 1 }, false), { status: 400 });
  assert.throws(() => sqlbox._request({ source: 'SELECT 1', params: [] }, true), { status: 400 });
  assert.throws(() => sqlbox._request({ source: ' ' }, false), { status: 400 });
  assert.throws(() => sqlbox._request({ source: 'x'.repeat(sqlbox.limits.sourceBytes + 1) }, false), { status: 400 });
  assert.throws(() => sqlbox._request({ source: 'SELECT ?', params: [1] }, false), { status: 400 });
  assert.deepEqual(sqlbox._request({ source: 'SELECT ?', params: ['1', null] }, false).params, ['1', null]);
});

test('script errors keep earlier results and fail the summary', () => {
  const ok = { available: true, exitCode: 0, error: '', sqlState: '', affectedRows: 2, truncated: false,
    columns: [], columnInfo: [], rows: [] };
  const script = sqlbox.shape({ results: [ok], truncated: false,
    statementError: { errno: 1146, sqlState: '42S02', message: 'missing' } }, true);
  assert.equal(script.exitCode, 1146);
  assert.equal(script.results.length, 2);
  assert.equal(script.results[0].exitCode, 0);
  assert.equal(script.affectedRows, 2);
  const timedOut = sqlbox.shape({ results: [], truncated: false, timedOut: true }, false);
  assert.equal(timedOut.exitCode, 3024);
});
