const fs = require('node:fs');
const path = require('node:path');
const { createUserId, isUserId } = require('./user-id');

const USER_TABLES = [
  'user_state', 'auth_sessions', 'posts', 'comments', 'likes',
  'checkins', 'audit_logs', 'cloud_projects',
];

function moveUserDirectories(dataDir, mappings) {
  for (const { old_id: oldId, new_id: newId } of mappings) {
    if (!/^\d+$/.test(oldId) || !isUserId(newId)) throw new Error('用户 ID 迁移映射无效');
    for (const area of ['cloud', 'terminals']) {
      const root = path.resolve(dataDir, area);
      const source = path.resolve(root, `u${oldId}`);
      const target = path.resolve(root, `u${newId}`);
      if (path.dirname(source) !== root || path.dirname(target) !== root) {
        throw new Error('用户目录超出数据目录');
      }
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) throw new Error(`迁移目标已存在，请人工核对：${target}`);
      fs.renameSync(source, target);
    }
  }
}

function migrateSqliteUserIds(sqlite, dataDir) {
  const id = sqlite.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'id');
  const numericIds = sqlite.prepare("SELECT 1 FROM users WHERE CAST(id AS TEXT) NOT LIKE 'user_%' LIMIT 1").get();
  if (id.type.toUpperCase() === 'INTEGER' || numericIds) {
    const backup = path.join(dataDir, `qfli.before-string-id.${Date.now()}.db`);
    sqlite.prepare('VACUUM INTO ?').run(backup);
    console.log(`[db] 用户 ID 迁移前备份：${backup}`);
    sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      sqlite.exec(`CREATE TABLE qfli_user_id_migration (
        old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL UNIQUE
      )`);
      const insert = sqlite.prepare('INSERT INTO qfli_user_id_migration (old_id, new_id) VALUES (?, ?)');
      for (const user of sqlite.prepare('SELECT id FROM users').all()) {
        insert.run(String(user.id), createUserId());
      }
      const archivedIds = sqlite.prepare(`SELECT DISTINCT CAST(user_id AS TEXT) AS id FROM audit_logs
        WHERE user_id IS NOT NULL AND CAST(user_id AS TEXT) NOT IN (SELECT old_id FROM qfli_user_id_migration)`).all();
      for (const user of archivedIds) insert.run(user.id, createUserId());
      // Rebuild integer columns so both SQLite and MySQL have string user IDs.
      for (const table of ['users', ...USER_TABLES]) {
        const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!schema) continue;
        const objects = sqlite.prepare(`SELECT sql FROM sqlite_master
          WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all(table);
        const temporary = `${table}_string_ids`;
        let ddl = schema.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[\w"`]+/i, `CREATE TABLE ${temporary}`);
        if (table === 'users') {
          ddl = ddl.replace(/\bid\s+INTEGER\s+PRIMARY KEY\s+AUTOINCREMENT/i, 'id TEXT PRIMARY KEY NOT NULL');
        } else {
          ddl = ddl.replace(/\buser_id\s+INTEGER/ig, 'user_id TEXT');
        }
        sqlite.exec(ddl);
        const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        const key = table === 'users' ? 'id' : 'user_id';
        const projection = columns.map((column) => column === key
          ? `(SELECT new_id FROM qfli_user_id_migration WHERE old_id = CAST(${table}.${key} AS TEXT))`
          : `${table}."${column}"`).join(', ');
        const unknown = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}
          WHERE ${key} IS NOT NULL AND CAST(${key} AS TEXT) NOT IN (SELECT old_id FROM qfli_user_id_migration)`).get();
        if (unknown.count) throw new Error(`${table} 存在无法映射的用户 ID，已回滚`);
        sqlite.exec(`INSERT INTO ${temporary} (${columns.map((c) => `"${c}"`).join(', ')})
          SELECT ${projection} FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table};`);
        for (const object of objects) sqlite.exec(object.sql);
      }
      // Integer-ID JWTs cannot identify the migrated users; force a fresh login.
      sqlite.exec('DELETE FROM auth_sessions');
      if (sqlite.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('用户 ID 迁移发现外键异常，已回滚');
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON');
    }
  }
  const migration = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qfli_user_id_migration'").get();
  if (migration) moveUserDirectories(dataDir, sqlite.prepare('SELECT * FROM qfli_user_id_migration').all());
}

function identifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('数据库标识无效');
  return `\`${value}\``;
}

async function migrateMysqlUserIds(pool, dataDir) {
  const connection = await pool.getConnection();
  try {
    const [ids] = await connection.query('SHOW COLUMNS FROM users');
    const integerIds = /^(?:tinyint|smallint|mediumint|int|bigint)\b/i.test(ids.find((c) => c.Field === 'id').Type);
    const [states] = await connection.query("SHOW TABLES LIKE 'qfli_user_id_migration_state'");
    if (!integerIds && !states.length) return;
    await connection.query(`CREATE TABLE IF NOT EXISTS qfli_user_id_migration (
      old_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      new_id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE
    ) ENGINE=InnoDB`);
    await connection.query(`CREATE TABLE IF NOT EXISTS qfli_user_id_migration_state (
      id VARCHAR(16) PRIMARY KEY, metadata TEXT NOT NULL, completed TINYINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`);
    await connection.query('ALTER TABLE qfli_user_id_migration_state MODIFY id VARCHAR(16) NOT NULL');
    let [stateRows] = await connection.query('SELECT * FROM qfli_user_id_migration_state WHERE id = 1');
    if (!stateRows.length) {
      const [columns] = await connection.query(`SELECT TABLE_NAME AS table_name, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'user_id'`);
      const [foreignKeys] = await connection.query(`SELECT k.TABLE_NAME AS table_name,
        k.COLUMN_NAME AS column_name, k.CONSTRAINT_NAME AS constraint_name,
        r.DELETE_RULE AS delete_rule, r.UPDATE_RULE AS update_rule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'users' AND k.REFERENCED_COLUMN_NAME = 'id'`);
      if (foreignKeys.some((fk) => fk.column_name !== 'user_id')) {
        throw new Error('发现额外的用户 ID 外键，需先更新迁移范围');
      }
      const metadata = { columns: columns.filter((c) => USER_TABLES.includes(c.table_name)), foreignKeys };
      if (foreignKeys.some((fk) => !metadata.columns.some((c) => c.table_name === fk.table_name))) {
        throw new Error('发现额外的用户关联表，需先更新迁移范围');
      }
      await connection.query('INSERT INTO qfli_user_id_migration_state (id, metadata) VALUES (1, ?)', [JSON.stringify(metadata)]);
      [stateRows] = await connection.query('SELECT * FROM qfli_user_id_migration_state WHERE id = 1');
    }
    const state = stateRows[0];
    if (!state.completed) {
      const { columns, foreignKeys } = JSON.parse(state.metadata);
      await connection.query('CREATE TABLE IF NOT EXISTS users_before_string_ids AS SELECT * FROM users');
      const hasAudit = columns.some((c) => c.table_name === 'audit_logs');
      const [users] = await connection.query(hasAudit
        ? 'SELECT CAST(id AS CHAR) AS id FROM users UNION SELECT CAST(user_id AS CHAR) AS id FROM audit_logs WHERE user_id IS NOT NULL'
        : 'SELECT id FROM users');
      for (const user of users) {
        const oldId = String(user.id);
        if (/^\d+$/.test(oldId)) {
          await connection.query('INSERT IGNORE INTO qfli_user_id_migration (old_id, new_id) VALUES (?, ?)', [oldId, createUserId()]);
        }
      }
      // Persist constraints before dropping them: MySQL DDL commits independently.
      for (const fk of foreignKeys) {
        const [existing] = await connection.query(`SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [fk.table_name, fk.constraint_name]);
        if (existing.length) await connection.query(`ALTER TABLE ${identifier(fk.table_name)} DROP FOREIGN KEY ${identifier(fk.constraint_name)}`);
      }
      await connection.query('ALTER TABLE users MODIFY id VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
      for (const column of columns) {
        await connection.query(`ALTER TABLE ${identifier(column.table_name)} MODIFY user_id
          VARCHAR(37) CHARACTER SET ascii COLLATE ascii_bin ${column.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
      }
      await connection.beginTransaction();
      try {
        for (const [table, column] of [['users', 'id'], ...columns.map((c) => [c.table_name, 'user_id'])]) {
          await connection.query(`UPDATE ${identifier(table)} t JOIN qfli_user_id_migration m
            ON t.${identifier(column)} = m.old_id SET t.${identifier(column)} = m.new_id`);
        }
        if (columns.some((c) => c.table_name === 'auth_sessions')) await connection.query('DELETE FROM auth_sessions');
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      }
      for (const column of columns) {
        const [orphans] = await connection.query(`SELECT COUNT(*) AS count FROM ${identifier(column.table_name)} t
          LEFT JOIN users u ON t.user_id = u.id WHERE t.user_id IS NOT NULL AND u.id IS NULL`);
        if (orphans[0].count && column.table_name !== 'audit_logs') throw new Error(`${column.table_name} 存在无效用户关联`);
      }
      for (const fk of foreignKeys) {
        const rules = new Set(['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL']);
        if (!rules.has(fk.delete_rule) || !rules.has(fk.update_rule)) throw new Error('外键规则无效');
        await connection.query(`ALTER TABLE ${identifier(fk.table_name)} ADD CONSTRAINT ${identifier(fk.constraint_name)}
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE ${fk.delete_rule} ON UPDATE ${fk.update_rule}`);
      }
      await connection.query('UPDATE qfli_user_id_migration_state SET completed = 1 WHERE id = 1');
    }
    const [mappings] = await connection.query('SELECT * FROM qfli_user_id_migration');
    moveUserDirectories(dataDir, mappings);
  } finally {
    connection.release();
  }
}

module.exports = { migrateSqliteUserIds, migrateMysqlUserIds };
