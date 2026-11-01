// 内容审核相关的数据库迁移（2026-11 合规整改 W2b）。
// 与 db.js 主建表分开：先补列，再建表，sqlite 与 mysql 各一份，逐个语句执行。
// 所有语句幂等，重复执行安全。

const POST_STATUSES = ['published', 'pending', 'rejected'];

const TABLES = [
  // 先审后发等开关的持久化，键值对。改动即时生效，无需重启。
  {
    sqlite: `CREATE TABLE IF NOT EXISTS moderation_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    mysql: `CREATE TABLE IF NOT EXISTS moderation_settings (
      \`key\` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      value VARCHAR(255) NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  // 账号处置：封停（禁止一切发布）与禁言（仅禁止发布）。
  {
    sqlite: `CREATE TABLE IF NOT EXISTS user_moderation (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      actor_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    mysql: `CREATE TABLE IF NOT EXISTS user_moderation (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      banned TINYINT NOT NULL DEFAULT 0,
      muted TINYINT NOT NULL DEFAULT 0,
      reason VARCHAR(255),
      actor_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  // 发布限流计数：按用户 + 类型，分钟窗口与自然日窗口各自计数。
  // 用数据库记账，服务重启不清零（限流是已承诺的能力）。
  {
    sqlite: `CREATE TABLE IF NOT EXISTS publish_rate (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      minute_start INTEGER NOT NULL,
      minute_count INTEGER NOT NULL DEFAULT 0,
      day_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, kind)
    )`,
    mysql: `CREATE TABLE IF NOT EXISTS publish_rate (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      day VARCHAR(10) NOT NULL,
      minute_start BIGINT NOT NULL,
      minute_count INT NOT NULL DEFAULT 0,
      day_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, kind),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  // 举报记录。保留 365 天；不随被举报内容级联删除，目标用类型 + 编号留存。
  {
    sqlite: `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      handler_id TEXT,
      moderation_report_id TEXT,
      forwarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      handled_at TEXT
    )`,
    mysql: `CREATE TABLE IF NOT EXISTS reports (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      target_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      target_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      reporter_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      reason VARCHAR(500) NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
      resolution VARCHAR(500),
      handler_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin,
      moderation_report_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
      forwarded TINYINT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      handled_at DATETIME,
      KEY idx_reports_status (status, created_at),
      KEY idx_reports_target (target_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
];

const INDEXES = {
  sqlite: [
    'CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id)',
    'CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)',
  ],
  mysql: [
    'CREATE INDEX idx_posts_status ON posts(status, created_at)',
    'CREATE INDEX idx_comments_status ON comments(status)',
  ],
};

// posts / comments 增加 status 列，历史行默认 published。
// columnsAt(table) 返回该表已有列名；表不存在时由调用方返回包含 status 的占位值。
function statusColumns(columnsAt) {
  const plan = [];
  if (!columnsAt('posts').includes('status')) {
    plan.push([
      'posts',
      "ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'",
      "ALTER TABLE posts ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'published'",
    ]);
  }
  if (!columnsAt('comments').includes('status')) {
    plan.push([
      'comments',
      "ALTER TABLE comments ADD COLUMN status TEXT NOT NULL DEFAULT 'published'",
      "ALTER TABLE comments ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'published'",
    ]);
  }
  return plan;
}

function migrateModerationSqlite(sqlite) {
  const columnsOf = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  let altered = 0;
  for (const [table, sqliteSql] of statusColumns((name) => (tables.has(name) ? columnsOf(name) : ['status']))) {
    sqlite.exec(sqliteSql);
    altered += 1;
  }
  for (const table of TABLES) sqlite.exec(table.sqlite);
  for (const sql of INDEXES.sqlite) {
    try { sqlite.exec(sql); } catch (_) { /* 索引已存在或列缺失时跳过 */ }
  }
  return altered;
}

async function migrateModerationMysql(pool) {
  const columnsOf = async (table) => {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    return rows.map((row) => row.Field);
  };
  const [existing] = await pool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const tables = new Set(existing.map((row) => row.name));
  const existingColumns = new Map();
  for (const table of ['posts', 'comments']) {
    existingColumns.set(table, tables.has(table) ? await columnsOf(table) : ['status']);
  }
  let altered = 0;
  for (const [table, , mysqlSql] of statusColumns((name) => existingColumns.get(name) || ['status'])) {
    await pool.query(mysqlSql);
    altered += 1;
  }
  for (const table of TABLES) await pool.query(table.mysql);
  for (const sql of INDEXES.mysql) {
    try { await pool.query(sql); } catch (_) { /* 索引已存在时跳过 */ }
  }
  return altered;
}

function migrateModerationSqlite(sqlite) {
  const columnsOf = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  let altered = 0;
  for (const [table, sql] of statusColumns((name) => (tables.has(name) ? columnsOf(name) : ['status']))) {
    if (!tables.has(table)) continue;
    sqlite.exec(sql);
    altered += 1;
  }
  for (const table of TABLES) sqlite.exec(table.sqlite);
  for (const sql of INDEXES.sqlite) {
    try { sqlite.exec(sql); } catch (_) { /* 索引已存在或列缺失时跳过 */ }
  }
  return altered;
}

async function migrateModerationMysql(pool) {
  const columnsOf = async (table) => {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    return rows.map((row) => row.Field);
  };
  const [existing] = await pool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const tables = new Set(existing.map((row) => row.name));
  let altered = 0;
  for (const table of ['posts', 'comments']) {
    if (!tables.has(table)) continue;
    if ((await columnsOf(table)).includes('status')) continue;
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'published'`);
    altered += 1;
  }
  for (const table of TABLES) await pool.query(table.mysql);
  for (const sql of INDEXES.mysql) {
    try { await pool.query(sql); } catch (_) { /* 索引已存在时跳过 */ }
  }
  return altered;
}

module.exports = {
  POST_STATUSES,
  migrateModerationSqlite,
  migrateModerationMysql,
};
