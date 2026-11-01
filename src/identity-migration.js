const path = require('node:path');

const legacyColumns = [
  'username', 'nickname', 'bio', 'avatar_color', 'points', 'checkin_streak',
  'last_checkin_date', 'provider', 'provider_id', 'created_at', 'is_admin',
];

function migrateSqlite(sqlite, dataDir) {
  const columns = sqlite.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const legacy = columns.includes('username');
  if (legacy) {
    const backup = path.join(dataDir, `qfli.before-gateway-id.${Date.now()}.db`);
    sqlite.prepare('VACUUM INTO ?').run(backup);
    console.log(`[db] 身份迁移前备份：${backup}`);
  }
  sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        points INTEGER NOT NULL DEFAULT 0,
        checkin_streak INTEGER NOT NULL DEFAULT 0,
        last_checkin_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credentials TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
    `);
    if (legacy) {
      const retained = legacyColumns.filter((c) => columns.includes(c));
      sqlite.exec(`CREATE TABLE legacy_user_profiles AS SELECT id, ${retained.join(', ')} FROM users;`);
      sqlite.exec(`
        INSERT INTO user_state (user_id, points, checkin_streak, last_checkin_date, created_at)
          SELECT id, points, checkin_streak, last_checkin_date, created_at FROM users;
        CREATE TABLE users_migrating (
          id TEXT PRIMARY KEY NOT NULL,
          gateway_user_id TEXT UNIQUE
        );
        INSERT INTO users_migrating (id, gateway_user_id)
          SELECT id, CASE WHEN provider = 'azk' THEN NULLIF(provider_id, '') ELSE NULL END FROM users;
        DROP TABLE users;
        ALTER TABLE users_migrating RENAME TO users;
      `);
    }
    sqlite.exec('INSERT OR IGNORE INTO user_state (user_id) SELECT id FROM users;');
    const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('身份迁移发现外键异常，已回滚');
    sqlite.exec('COMMIT;');
  } catch (err) {
    sqlite.exec('ROLLBACK;');
    throw err;
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;');
  }
}

async function migrateMysql(pool) {
  const [rows] = await pool.query('SHOW COLUMNS FROM users');
  const columns = rows.map((c) => c.Field);
  const idType = rows.find((c) => c.Field === 'id').Type;
  const userIdType = idType.startsWith('varchar')
    ? 'VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin' : idType;
  await pool.query(`CREATE TABLE IF NOT EXISTS user_state (
    user_id ${userIdType} PRIMARY KEY,
    points INT NOT NULL DEFAULT 0,
    checkin_streak INT NOT NULL DEFAULT 0,
    last_checkin_date VARCHAR(10),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  if (columns.includes('username')) {
    const retained = legacyColumns.filter((c) => columns.includes(c));
    // The archive makes interrupted MySQL DDL migrations resumable without losing the old IDs.
    await pool.query(`CREATE TABLE IF NOT EXISTS legacy_user_profiles AS SELECT id, ${retained.join(', ')} FROM users`);
    await pool.query(`INSERT IGNORE INTO user_state
      (user_id, points, checkin_streak, last_checkin_date, created_at)
      SELECT id, points, checkin_streak, last_checkin_date, created_at FROM legacy_user_profiles`);
  }
  if (!columns.includes('gateway_user_id')) {
    await pool.query('ALTER TABLE users ADD COLUMN gateway_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin UNIQUE');
    columns.push('gateway_user_id');
  }
  const [archives] = await pool.query("SHOW TABLES LIKE 'legacy_user_profiles'");
  if (archives.length) {
    await pool.query(`UPDATE users u JOIN legacy_user_profiles l ON CAST(l.id AS CHAR) = CAST(u.id AS CHAR)
      SET u.gateway_user_id = NULLIF(l.provider_id, '')
      WHERE u.gateway_user_id IS NULL AND l.provider = 'azk'`);
  }
  for (const column of [...legacyColumns, 'password_hash']) {
    if (columns.includes(column)) await pool.query(`ALTER TABLE users DROP COLUMN \`${column}\``);
  }
  await pool.query('INSERT IGNORE INTO user_state (user_id) SELECT id FROM users');
}

module.exports = { migrateSqlite, migrateMysql };
