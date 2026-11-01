const fs = require('node:fs');
const path = require('node:path');
const { createId, isId } = require('./entity-id');

const fields = {
  zones: { id: 'zones' },
  posts: { id: 'posts', zone_id: 'zones' },
  post_tags: { post_id: 'posts' },
  comments: { id: 'comments', post_id: 'posts', parent_id: 'comments' },
  likes: { post_id: 'posts' },
  audit_logs: { id: 'audit_logs' },
  cloud_projects: { id: 'cloud_projects' },
};
const entities = Object.keys(fields).filter((table) => fields[table].id);

function quote(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('数据库标识无效');
  return `\`${value}\``;
}

function moveProjectDirectories(dataDir, rows) {
  for (const row of rows) {
    if (!/^\d+$/.test(row.old_id) || !isId('cloud_projects', row.new_id) || !isId('users', row.user_id)) {
      throw new Error('云项目迁移映射无效');
    }
    const root = path.resolve(dataDir, 'cloud', `u${row.user_id}`);
    const source = path.resolve(root, `p${row.old_id}`);
    const target = path.resolve(root, `p${row.new_id}`);
    if (path.dirname(source) !== root || path.dirname(target) !== root) throw new Error('云项目目录越界');
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) throw new Error(`云项目迁移目标已存在：${target}`);
    fs.renameSync(source, target);
  }
}

const projectMappingSql = `SELECT m.old_id, m.new_id, p.user_id FROM qfli_entity_id_migration m
  JOIN cloud_projects p ON p.id = m.new_id WHERE m.entity_type = 'cloud_projects'`;

function migrateSqliteEntityIds(sqlite, dataDir) {
  const oldTables = entities.filter((table) => sqlite.prepare(`PRAGMA table_info(${table})`).all()
    .some((column) => column.name === 'id' && column.type.toUpperCase() === 'INTEGER'));
  if (oldTables.length) {
    sqlite.prepare('VACUUM INTO ?').run(path.join(dataDir, `qfli.before-entity-ids.${Date.now()}.db`));
    sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    try {
      sqlite.exec(`CREATE TABLE qfli_entity_id_migration (
        entity_type TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (entity_type, old_id)
      )`);
      const insert = sqlite.prepare('INSERT INTO qfli_entity_id_migration VALUES (?, ?, ?)');
      for (const table of oldTables) {
        for (const row of sqlite.prepare(`SELECT id FROM ${table}`).all()) insert.run(table, String(row.id), createId(table));
      }
      for (const [table, tableFields] of Object.entries(fields)) {
        const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!schema) continue;
        const objects = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ?
          AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all(table);
        const temporary = `${table}_entity_ids`;
        let ddl = schema.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[\w"`]+/i, `CREATE TABLE ${temporary}`);
        ddl = ddl.replace(/\bid\s+INTEGER\s+PRIMARY KEY\s+AUTOINCREMENT/i, 'id TEXT PRIMARY KEY NOT NULL');
        for (const column of Object.keys(tableFields)) ddl = ddl.replace(new RegExp(`\\b${column}\\s+INTEGER`, 'ig'), `${column} TEXT`);
        sqlite.exec(ddl);
        const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        const projection = columns.map((column) => tableFields[column]
          ? `COALESCE((SELECT new_id FROM qfli_entity_id_migration WHERE entity_type = '${tableFields[column]}'
              AND old_id = CAST(${table}.${column} AS TEXT)), CAST(${table}.${column} AS TEXT))`
          : `${table}.${quote(column)}`).join(', ');
        sqlite.exec(`INSERT INTO ${temporary} (${columns.map(quote).join(', ')}) SELECT ${projection} FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table}`);
        for (const object of objects) sqlite.exec(object.sql);
      }
      if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('实体 ID 迁移外键异常');
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    } finally { sqlite.exec('PRAGMA foreign_keys = ON'); }
  }
  const migration = sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'qfli_entity_id_migration' AND type = 'table'").get();
  if (migration) moveProjectDirectories(dataDir, sqlite.prepare(projectMappingSql).all());
  return Boolean(migration);
}

async function migrateMysqlEntityIds(pool, dataDir) {
  const connection = await pool.getConnection();
  try {
    const [allColumns] = await connection.query(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
      DATA_TYPE AS data_type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
    const oldTables = entities.filter((table) => allColumns.some((c) => c.table_name === table && c.column_name === 'id'
      && ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(c.data_type)));
    const [states] = await connection.query("SHOW TABLES LIKE 'qfli_entity_id_migration_state'");
    if (!oldTables.length && !states.length) return false;
    await connection.query(`CREATE TABLE IF NOT EXISTS qfli_entity_id_migration (
      entity_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      old_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      new_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      PRIMARY KEY (entity_type, old_id)
    ) ENGINE=InnoDB`);
    await connection.query(`CREATE TABLE IF NOT EXISTS qfli_entity_id_migration_state (
      id VARCHAR(16) PRIMARY KEY, metadata TEXT NOT NULL, completed TINYINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`);
    let [stateRows] = await connection.query("SELECT * FROM qfli_entity_id_migration_state WHERE id = 'entities'");
    if (!stateRows.length) {
      const columns = allColumns.filter((c) => fields[c.table_name]?.[c.column_name]);
      const [keys] = await connection.query(`SELECT k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
        k.CONSTRAINT_NAME AS constraint_name, k.REFERENCED_TABLE_NAME AS referenced_table,
        r.DELETE_RULE AS delete_rule, r.UPDATE_RULE AS update_rule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.REFERENCED_COLUMN_NAME = 'id'`);
      const foreignKeys = keys.filter((fk) => entities.includes(fk.referenced_table));
      if (foreignKeys.some((fk) => fields[fk.table_name]?.[fk.column_name] !== fk.referenced_table)) {
        throw new Error('发现额外实体外键，请先补充迁移范围');
      }
      await connection.query("INSERT INTO qfli_entity_id_migration_state (id, metadata) VALUES ('entities', ?)",
        [JSON.stringify({ oldTables, columns, foreignKeys })]);
      [stateRows] = await connection.query("SELECT * FROM qfli_entity_id_migration_state WHERE id = 'entities'");
    }
    if (!stateRows[0].completed) {
      const metadata = JSON.parse(stateRows[0].metadata);
      for (const table of metadata.oldTables) {
        await connection.query(`CREATE TABLE IF NOT EXISTS ${quote(`${table}_before_string_ids`)} AS SELECT * FROM ${quote(table)}`);
        const [rows] = await connection.query(`SELECT id FROM ${quote(table)}`);
        for (const row of rows) {
          if (/^\d+$/.test(String(row.id))) await connection.query('INSERT IGNORE INTO qfli_entity_id_migration VALUES (?, ?, ?)', [table, String(row.id), createId(table)]);
        }
      }
      // Persisted metadata allows retries after any of MySQL's auto-committed DDL.
      for (const fk of metadata.foreignKeys) {
        const [existing] = await connection.query(`SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [fk.table_name, fk.constraint_name]);
        if (existing.length) await connection.query(`ALTER TABLE ${quote(fk.table_name)} DROP FOREIGN KEY ${quote(fk.constraint_name)}`);
      }
      for (const column of metadata.columns) await connection.query(`ALTER TABLE ${quote(column.table_name)}
        MODIFY ${quote(column.column_name)} VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin ${column.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
      await connection.beginTransaction();
      try {
        for (const column of metadata.columns) await connection.query(`UPDATE ${quote(column.table_name)} t
          JOIN qfli_entity_id_migration m ON m.entity_type = ? AND t.${quote(column.column_name)} = m.old_id
          SET t.${quote(column.column_name)} = m.new_id`, [fields[column.table_name][column.column_name]]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      const rules = new Set(['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL']);
      for (const fk of metadata.foreignKeys) {
        if (!rules.has(fk.delete_rule) || !rules.has(fk.update_rule)) throw new Error('外键规则无效');
        await connection.query(`ALTER TABLE ${quote(fk.table_name)} ADD CONSTRAINT ${quote(fk.constraint_name)}
          FOREIGN KEY (${quote(fk.column_name)}) REFERENCES ${quote(fk.referenced_table)}(id)
          ON DELETE ${fk.delete_rule} ON UPDATE ${fk.update_rule}`);
      }
      await connection.query("UPDATE qfli_entity_id_migration_state SET completed = 1 WHERE id = 'entities'");
    }
    if (allColumns.some((c) => c.table_name === 'cloud_projects')) {
      moveProjectDirectories(dataDir, (await connection.query(projectMappingSql))[0]);
    }
    return true;
  } finally { connection.release(); }
}

module.exports = { migrateSqliteEntityIds, migrateMysqlEntityIds };
