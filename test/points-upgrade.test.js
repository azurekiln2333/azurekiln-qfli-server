const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('existing user balance and check-ins survive points schema upgrade', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-upgrade-'));
  const userId = 'user_22222222222222222222222222222222';
  const legacy = new DatabaseSync(path.join(dataDir, 'qfli.db'));
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, gateway_user_id TEXT UNIQUE);
    CREATE TABLE user_state (user_id TEXT PRIMARY KEY, points INTEGER NOT NULL,
      checkin_streak INTEGER NOT NULL, last_checkin_date TEXT, created_at TEXT);
    CREATE TABLE checkins (user_id TEXT NOT NULL, date TEXT NOT NULL,
      points INTEGER NOT NULL, UNIQUE (user_id, date));
    CREATE TABLE task_config (key TEXT PRIMARY KEY, label TEXT NOT NULL,
      reward INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE task_claims (user_id TEXT NOT NULL, date TEXT NOT NULL,
      task_key TEXT NOT NULL, reward INTEGER NOT NULL,
      PRIMARY KEY (user_id, date, task_key));
  `);
  legacy.prepare('INSERT INTO users (id, gateway_user_id) VALUES (?, ?)').run(userId, 'existing-sub');
  legacy.prepare('INSERT INTO user_state VALUES (?, ?, ?, ?, ?)').run(
    userId, 37, 2, '2026-09-20', '2026-09-01 00:00:00');
  legacy.prepare('INSERT INTO checkins VALUES (?, ?, ?)').run(userId, '2026-09-20', 9);
  legacy.prepare('INSERT INTO task_config VALUES (?, ?, ?, ?)').run(
    'create_project', '创建工程', 10, 1);
  legacy.prepare('INSERT INTO task_claims VALUES (?, ?, ?, ?)').run(
    userId, '2026-09-20', 'create_project', 10);
  legacy.close();

  process.env.DB_DRIVER = 'sqlite';
  process.env.QFLI_DATA_DIR = dataDir;
  const db = require('../src/db');
  try {
    await db.ready;
    assert.equal((await db.prepare('SELECT points FROM user_state WHERE user_id = ?').get(userId)).points, 37);
    assert.equal((await db.prepare('SELECT points FROM checkins WHERE user_id = ?').get(userId)).points, 9);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_config').get()).n, 10);
    const migratedTask = await db.prepare(
      'SELECT event_key, target_count FROM task_config WHERE `key` = ?',
    ).get('create_project');
    assert.equal(migratedTask.event_key, 'create_project');
    assert.equal(migratedTask.target_count, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE user_id = ?')
      .get(userId)).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM point_ledger').get()).n, 0);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
