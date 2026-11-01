// 数据库适配层：mysql（默认）或 sqlite（显式设置 DB_DRIVER=sqlite）。
// 统一暴露 prepare(sql).get/.all/.run 异步接口；业务 ID 由应用生成。
const path = require('node:path');
const fs = require('node:fs');
const { migrateSqlite, migrateMysql } = require('./identity-migration');
const { migrateSqliteUserIds, migrateMysqlUserIds } = require('./user-id-migration');
const { migrateSqliteEntityIds, migrateMysqlEntityIds } = require('./entity-id-migration');
const { createId } = require('./entity-id');

const DRIVER = (process.env.DB_DRIVER || 'mysql').toLowerCase();
if (DRIVER !== 'sqlite' && DRIVER !== 'mysql') {
  throw new Error(`不支持的 DB_DRIVER：${DRIVER}（可选 sqlite / mysql）`);
}

const db = { driver: DRIVER };

// 预置专区（幂等）。
// 必须在下面的驱动分支之前声明：initSqlite() 会在模块求值期间同步跑完，
// 若把 SEED_ZONES 放在其后会踩到 const 的暂时性死区（TDZ）导致启动即崩。
const SEED_ZONES = [
  { key: 'java', name: 'Java', sort: 1 },
  { key: 'python', name: 'Python', sort: 2 },
  { key: 'c_cpp', name: 'C/C++', sort: 3 },
  { key: 'web', name: 'HTML/前端', sort: 4 },
  { key: 'flutter', name: 'Dart/Flutter', sort: 5 },
  { key: 'harmony', name: '鸿蒙开发', sort: 6 },
  { key: 'tools', name: '工具与配置', sort: 7 },
  { key: 'chat', name: '闲聊灌水', sort: 8 },
];

if (DRIVER === 'sqlite') {
  // node:sqlite（Node >= 22.5 内置，无原生编译）。
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.QFLI_DATA_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new DatabaseSync(path.join(DATA_DIR, 'qfli.db'));
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const prepareDirect = (sql) => {
    const stmt = sqlite.prepare(sql);
    return {
      get: async (...params) => stmt.get(...params),
      all: async (...params) => stmt.all(...params),
      run: async (...params) => {
        const info = stmt.run(...params);
        return { changes: info.changes };
      },
    };
  };
  let transactionQueue = Promise.resolve();
  db.prepare = (sql) => {
    const stmt = prepareDirect(sql);
    return {
      get: async (...params) => { await transactionQueue; return stmt.get(...params); },
      all: async (...params) => { await transactionQueue; return stmt.all(...params); },
      run: async (...params) => { await transactionQueue; return stmt.run(...params); },
    };
  };
  db.transaction = (work) => {
    const execute = async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await work({ prepare: prepareDirect });
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    };
    const pending = transactionQueue.then(execute);
    transactionQueue = pending.catch(() => {});
    return pending;
  };
  db.close = () => sqlite.close();
  db.ready = initSqlite(sqlite, DATA_DIR);
} else {
  const mysql = require('mysql2/promise');
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT) || 3306;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  if (!user || !database) {
    throw new Error('MySQL 模式需要配置 MYSQL_USER 与 MYSQL_DATABASE（参见 .env.example）');
  }
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE) || 10,
    charset: 'utf8mb4',
    // DATETIME 以 'YYYY-MM-DD HH:MM:SS' 字符串返回，与 sqlite 行为一致。
    dateStrings: true,
  });
  db.prepare = (sql) => ({
    get: async (...params) => (await pool.query(sql, params))[0][0],
    all: async (...params) => (await pool.query(sql, params))[0],
    run: async (...params) => {
      const [result] = await pool.query(sql, params);
      return { changes: result.affectedRows };
    },
  });
  db.transaction = async (work) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = { prepare: (sql) => ({
        get: async (...params) => (await connection.query(sql, params))[0][0],
        all: async (...params) => (await connection.query(sql, params))[0],
        run: async (...params) => ({ changes: (await connection.query(sql, params))[0].affectedRows }),
      }) };
      const result = await work(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
  db.ready = initMysql(pool, { host, port, database });
  db.close = async () => { await pool.end(); };
}

// 数据库时间（毫秒）：跨业务实例的终端租约只看数据库时钟。
const NOW_SQL = DRIVER === 'sqlite'
  ? "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 AS t"
  : 'SELECT CAST(UNIX_TIMESTAMP() AS SIGNED) * 1000 AS t';
db.NOW_SQL = NOW_SQL;
db.now = async () => Number((await db.prepare(NOW_SQL).get()).t);

async function initSqlite(sqlite, dataDir) {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  gateway_user_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('tutorial','discussion')),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);
CREATE INDEX IF NOT EXISTS idx_post_tags_post ON post_tags(post_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 5,
  UNIQUE (user_id, date)
);
CREATE TABLE IF NOT EXISTS task_config (
  key TEXT PRIMARY KEY, label TEXT NOT NULL, reward INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  event_key TEXT NOT NULL DEFAULT '', target_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, date TEXT NOT NULL, event_key TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_task_events_day ON task_events(user_id, date, event_key);
CREATE TABLE IF NOT EXISTS task_claims (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, task_key TEXT NOT NULL, reward INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, task_key)
);
CREATE TABLE IF NOT EXISTS point_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, kind TEXT NOT NULL,
  reference_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, reference_id)
);
CREATE INDEX IF NOT EXISTS idx_point_ledger_user ON point_ledger(user_id, created_at);
CREATE TABLE IF NOT EXISTS reward_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  cost INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT -1, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL, item_title TEXT NOT NULL, cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS cloud_projects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);

-- 终端池：每个执行节点一行槽位，单行协调表串行化跨实例放置。
CREATE TABLE IF NOT EXISTS terminal_slots (
  node_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  reclaim_user_id TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'free',
  operation_token TEXT NOT NULL DEFAULT '',
  operation_deadline INTEGER,
  idle_deadline INTEGER,
  session_deadline INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_terminal_slots_user ON terminal_slots(user_id);
CREATE TABLE IF NOT EXISTS terminal_coord (
  key TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
`);

  migrateSqlite(sqlite, dataDir);
  migrateSqliteUserIds(sqlite, dataDir);
  sqlite.prepare("INSERT OR IGNORE INTO terminal_coord (key, version, updated_at) VALUES ('pool', 1, 0)").run();
  db.entityIdsMigrated = migrateSqliteEntityIds(sqlite, dataDir);
  const slotColumns = sqlite.prepare('PRAGMA table_info(terminal_slots)').all().map(column => column.name);
  if (!slotColumns.includes('reclaim_user_id')) {
    sqlite.exec("ALTER TABLE terminal_slots ADD COLUMN reclaim_user_id TEXT NOT NULL DEFAULT ''");
  }
  const taskColumns = sqlite.prepare('PRAGMA table_info(task_config)').all().map(column => column.name);
  if (!taskColumns.includes('event_key')) sqlite.exec("ALTER TABLE task_config ADD COLUMN event_key TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.includes('target_count')) sqlite.exec('ALTER TABLE task_config ADD COLUMN target_count INTEGER NOT NULL DEFAULT 1');
  sqlite.exec("UPDATE task_config SET event_key = `key` WHERE event_key = ''");
  sqlite.exec("UPDATE task_config SET label = '创建项目' WHERE `key` = 'create_project' AND label = '创建工程'");
  sqlite.exec("UPDATE task_config SET label = '修改文件' WHERE `key` = 'save_file' AND label = '修改并保存文件'");
  const legacyClaims = sqlite.prepare(`SELECT c.user_id, c.date, c.task_key
    FROM task_claims c WHERE c.task_key IN ('create_project', 'open_project', 'save_file')
    AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.user_id = c.user_id
      AND e.date = c.date AND e.event_key = c.task_key)`).all();
  const backfillEvent = sqlite.prepare('INSERT INTO task_events (user_id, event_id, date, event_key) VALUES (?, ?, ?, ?)');
  for (const claim of legacyClaims) backfillEvent.run(claim.user_id, createId('task_events'), claim.date, claim.task_key);

  // 审计日志保留 90 天，启动时清理一次。
  try {
    sqlite.prepare(
      "DELETE FROM audit_logs WHERE created_at < datetime('now', '-90 days')",
    ).run();
  } catch (_) {}

  const insertZone = sqlite.prepare(
    'INSERT OR IGNORE INTO zones (id, key, name, sort) VALUES (?, ?, ?, ?)',
  );
  for (const z of SEED_ZONES) insertZone.run(createId('zones'), z.key, z.name, z.sort);
  await seedTasks((sql, params) => sqlite.prepare(sql).run(...params));
}

async function initMysql(pool, cfg) {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `无法连接 MySQL（${cfg.host}:${cfg.port}/${cfg.database}）：${err.message}`,
    );
  }

  // 每条 DDL 单独执行（mysql2 默认不允许多语句）。
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      gateway_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin UNIQUE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS user_state (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      points INT NOT NULL DEFAULT 0,
      checkin_streak INT NOT NULL DEFAULT 0,
      last_checkin_date VARCHAR(10),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      credentials TEXT NOT NULL,
      access_expires_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_sessions_user (user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS zones (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      \`key\` VARCHAR(32) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      sort INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS posts (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      type VARCHAR(16) NOT NULL,
      zone_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      title VARCHAR(255) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES zones(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS post_tags (
      post_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      tag VARCHAR(32) NOT NULL,
      KEY idx_post_tags_tag (tag),
      KEY idx_post_tags_post (post_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS comments (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      post_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      parent_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_comments_post (post_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS likes (
      post_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_likes (post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS checkins (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      date VARCHAR(10) NOT NULL,
      points INT NOT NULL DEFAULT 5,
      UNIQUE KEY uk_checkins (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS task_config (
      \`key\` VARCHAR(32) PRIMARY KEY, label VARCHAR(64) NOT NULL,
      reward INT NOT NULL, enabled TINYINT NOT NULL DEFAULT 1,
      event_key VARCHAR(32) NOT NULL DEFAULT '', target_count INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS task_events (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      event_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      date VARCHAR(10) NOT NULL, event_key VARCHAR(32) NOT NULL,
      PRIMARY KEY (user_id, event_id), KEY idx_task_events_day (user_id, date, event_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS task_claims (
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      date VARCHAR(10) NOT NULL, task_key VARCHAR(32) NOT NULL, reward INT NOT NULL,
      PRIMARY KEY (user_id, date, task_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS point_ledger (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      amount INT NOT NULL, balance_after INT NOT NULL, kind VARCHAR(32) NOT NULL,
      reference_id VARCHAR(64) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_point_event (user_id, kind, reference_id),
      KEY idx_point_user (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS reward_items (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      title VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL,
      cost INT NOT NULL, stock INT NOT NULL DEFAULT -1, enabled TINYINT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS redemptions (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      item_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      item_title VARCHAR(80) NOT NULL, cost INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_redemptions_user (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin,
      username VARCHAR(64),
      action VARCHAR(64) NOT NULL,
      target VARCHAR(128),
      detail TEXT,
      ip VARCHAR(64),
      user_agent VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_created (created_at),
      KEY idx_audit_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS cloud_projects (
      id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      name VARCHAR(64) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_cloud_projects (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS terminal_slots (
      node_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin,
      reclaim_user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
      phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'free',
      operation_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
      operation_deadline BIGINT,
      idle_deadline BIGINT,
      session_deadline BIGINT,
      updated_at BIGINT NOT NULL DEFAULT 0,
      KEY idx_terminal_slots_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS terminal_coord (
      \`key\` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  await pool.query(ddl[0]);
  await migrateMysql(pool);
  await migrateMysqlUserIds(pool, path.join(__dirname, '..', 'data'));
  db.entityIdsMigrated = await migrateMysqlEntityIds(pool, path.join(__dirname, '..', 'data'));
  for (const sql of ddl.slice(1)) await pool.query(sql);
  const [taskColumns] = await pool.query('SHOW COLUMNS FROM task_config');
  if (!taskColumns.some(column => column.Field === 'event_key')) {
    await pool.query("ALTER TABLE task_config ADD COLUMN event_key VARCHAR(32) NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some(column => column.Field === 'target_count')) {
    await pool.query('ALTER TABLE task_config ADD COLUMN target_count INT NOT NULL DEFAULT 1');
  }
  const [slotColumns] = await pool.query('SHOW COLUMNS FROM terminal_slots');
  if (!slotColumns.some(column => column.Field === 'reclaim_user_id')) {
    await pool.query("ALTER TABLE terminal_slots ADD COLUMN reclaim_user_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''");
  }
  await pool.query("UPDATE task_config SET event_key = `key` WHERE event_key = ''");
  await pool.query("UPDATE task_config SET label = '创建项目' WHERE `key` = 'create_project' AND label = '创建工程'");
  await pool.query("UPDATE task_config SET label = '修改文件' WHERE `key` = 'save_file' AND label = '修改并保存文件'");
  const [legacyClaims] = await pool.query(`SELECT c.user_id, c.date, c.task_key
    FROM task_claims c WHERE c.task_key IN ('create_project', 'open_project', 'save_file')
    AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.user_id = c.user_id
      AND e.date = c.date AND e.event_key = c.task_key)`);
  for (const claim of legacyClaims) {
    await pool.query('INSERT INTO task_events (user_id, event_id, date, event_key) VALUES (?, ?, ?, ?)',
      [claim.user_id, createId('task_events'), claim.date, claim.task_key]);
  }
  await pool.query('INSERT IGNORE INTO user_state (user_id) SELECT id FROM users');
  await pool.query("INSERT IGNORE INTO terminal_coord (`key`, version, updated_at) VALUES ('pool', 1, 0)");

  // 审计日志保留 90 天，启动时清理一次。
  try {
    await pool.query('DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL 90 DAY');
  } catch (_) {}

  for (const z of SEED_ZONES) {
    await pool.query('INSERT IGNORE INTO zones (id, `key`, name, sort) VALUES (?, ?, ?, ?)', [
      createId('zones'),
      z.key,
      z.name,
      z.sort,
    ]);
  }
  await seedTasks((sql, params) => pool.query(sql.replace('INSERT OR IGNORE', 'INSERT IGNORE'), params));
}

async function seedTasks(run) {
  for (const [key, label, reward, eventKey, target] of [
    ['checkin', '每日签到', 5, 'checkin', 1],
    ['create_project', '创建项目', 10, 'create_project', 1],
    ['create_project_5', '创建项目', 20, 'create_project', 5],
    ['create_project_10', '创建项目', 40, 'create_project', 10],
    ['open_project', '打开项目', 2, 'open_project', 1],
    ['open_project_5', '打开项目', 5, 'open_project', 5],
    ['open_project_10', '打开项目', 10, 'open_project', 10],
    ['save_file', '修改文件', 5, 'save_file', 1],
    ['save_file_5', '修改文件', 10, 'save_file', 5],
    ['save_file_10', '修改文件', 20, 'save_file', 10],
  ]) {
    await run('INSERT OR IGNORE INTO task_config (`key`, label, reward, event_key, target_count) VALUES (?, ?, ?, ?, ?)',
      [key, label, reward, eventKey, target]);
  }
}

module.exports = db;
