import Database from 'better-sqlite3';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ConnectionConfig, DbDriver, QueryLimits, Relation, SchemaForeignKey, SchemaIndex, SchemaTrigger, TablePage, TableSchema, TabularResult } from '../core/types.js';
import { assertWritable } from '../core/types.js';
import { buildWhere, addForeignKeySql, alterColumnSql, capSelect, checkTriggerBody, checkTriggerEvent, checkTriggerTiming, checkViewSql, columnSql, countStatements, dropForeignKeySql, dropIndexSql, inlineForeignKeySql, dropPrimaryKeySql, filterValue, ident, indexSql, likePattern, quoteIdent, setPrimaryKeySql, splitStatements, validateRow } from './helpers.js';

function open(cfg: ConnectionConfig): Database.Database {
  if (!cfg.filePath) throw Object.assign(new Error('sqlite filePath required'), { statusCode: 400 });
  mkdirSync(dirname(cfg.filePath), { recursive: true });
  return new Database(cfg.filePath, { readonly: Boolean(cfg.readOnly) });
}

/** Версия SQLite из открытого соединения: часть возможностей появилась в 3.25. */
function sqliteVersionAtLeast(db: Database.Database, major: number, minor: number): boolean {
  const parts = (db.prepare('SELECT sqlite_version() AS v').get() as { v?: unknown } | undefined)?.v;
  const m = /(\d+)\.(\d+)/.exec(String(parts ?? ''));
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

// PRAGMA не понимает bind-параметры: имя объекта обязано быть в кавычках
// в самом тексте запроса. Имена из sqlite_master экранируем сами (ident()
// на autoindex-именах вроде sqlite_autoindex_t_1 уже проходит, но с кавычками
// в имени таблицы он дал бы 400) — двойная кавычка удваивается.
function pragmaIdent(name: string): string {
  try {
    return quoteIdent('sqlite', ident(name, 'index'));
  } catch {
    return `"${String(name).replace(/"/g, '""')}"`;
  }
}

// SQLite отдаёт действия как 'NO ACTION' почти всегда — это шум, приводим к null
function fkAction(v: unknown): string | null {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return !s || /^no action$/i.test(s) ? null : s.toUpperCase();
}

/** AUTOINCREMENT в SQLite не попадает в table_info — слово живёт только в DDL
 *  таблицы. Режем тело CREATE TABLE по запятым верхнего уровня (скобки типов
 *  пропускаем) и отмечаем колонки, у которых в своём определении есть
 *  AUTOINCREMENT. Возвращает null, если разобрать нечего. */
function autoIncColumns(ddl: string | null): Set<string> | null {
  const sql = String(ddl ?? '');
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (!/autoincrement/i.test(sql) || open < 0 || close <= open) return null;
  const out = new Set<string>();
  let depth = 0;
  let part = '';
  const parts: string[] = [];
  for (let i = open + 1; i < close; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(part); part = ''; continue; }
    part += ch;
  }
  parts.push(part);
  for (const p of parts) {
    if (!/autoincrement/i.test(p)) continue;
    const name = p.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\p{L}0-9_]+))/u);
    const col = name && (name[1] ?? name[2] ?? name[3] ?? name[4]);
    if (col) out.add(col);
  }
  return out.size ? out : null;
}

interface PragmaColumn { cid: number; name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number; }
interface PragmaIndex { seq: number; name: string; unique: number; origin: string; partial: number; }
interface PragmaForeignKey { id: number; seq: number; table: string; from: string; to: string | null; on_update: string | null; on_delete: string | null; }

/**
 * Пересборка таблицы SQLite (recreate-table migration).
 *
 * SQLite не умеет ALTER COLUMN и смену PK/FK без пересоздания таблицы —
 * генераторы helpers.ts честно кидают 400. Вместо отказа здесь строится
 * полный скрипт: CREATE tmp → INSERT SELECT → DROP → RENAME → индексы/триггеры.
 * Вызывается из planAlter/alterTable, когда в пакете есть alterColumn,
 * set/dropPrimaryKey или add/dropForeignKey. Простые ops (add/drop/rename
 * колонки, индексы) идут обычными ALTER/CREATE INDEX и в rebuild не входят,
 * но могут быть в одном пакете — тогда rebuild выполняется первым, а
 * индексные ops применяются уже к новой таблице в той же транзакции.
 */
function buildRebuildStatements(
  db: Database.Database,
  table: string,
  ops: { op: string; [k: string]: unknown }[],
): { statements: string[]; finalName: string } {
  const t = ident(table, 'table');
  const q = (n: string) => `"${n}"`;
  const cols = db.prepare(`PRAGMA table_info(${quoteIdent('sqlite', t)})`).all() as PragmaColumn[];
  if (!cols.length) throw Object.assign(new Error(`Table not found: ${table}`), { statusCode: 404 });
  const fkRows = db.prepare(`PRAGMA foreign_key_list(${quoteIdent('sqlite', t)})`).all() as PragmaForeignKey[];
  const ddlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(t) as { sql: string | null } | undefined;
  const autoInc = autoIncColumns(ddlRow?.sql ?? null);

  type Col = { name: string; type: string; nullable: boolean; primary: boolean; autoInc: boolean; def: string | null };
  let model: Col[] = cols.map((c) => ({
    name: String(c.name),
    type: String(c.type ?? '').trim() || 'BLOB',
    nullable: !Number(c.notnull),
    primary: Number(c.pk) > 0,
    autoInc: Boolean(autoInc?.has(String(c.name))),
    def: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
  }));
  // FK как spec-список для inlineForeignKeySql.
  const fkById = new Map<number, { name?: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: string; onUpdate?: string }>();
  for (const fk of fkRows.slice().sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    let f = fkById.get(Number(fk.id));
    if (!f) {
      f = { columns: [], refTable: String(fk.table), refColumns: [] };
      const del = fkAction(fk.on_delete);
      const upd = fkAction(fk.on_update);
      if (del) f.onDelete = del;
      if (upd) f.onUpdate = upd;
      fkById.set(Number(fk.id), f);
    }
    f.columns.push(String(fk.from));
    if (fk.to !== null && fk.to !== undefined) f.refColumns.push(String(fk.to));
  }
  let fks = [...fkById.values()];
  // Маппинг новое имя -> старое для копирования данных (rename/alter с переименованием).
  const copyFrom = new Map<string, string>();
  for (const c of model) copyFrom.set(c.name, c.name);
  let finalName = t;

  for (const o of ops) {
    if (o.op === 'addColumn') {
      const c = o.column as { name: string; type: string; nullable?: boolean; primary?: boolean; autoInc?: boolean; default?: string | null };
      model.push({
        name: ident(c.name, 'column'),
        type: String(c.type),
        nullable: c.nullable !== false,
        primary: Boolean(c.primary),
        autoInc: Boolean(c.autoInc),
        def: c.default ?? null,
      });
      copyFrom.delete(ident(c.name, 'column'));
    } else if (o.op === 'dropColumn') {
      const n = ident(String(o.name), 'column');
      model = model.filter((c) => c.name !== n);
      copyFrom.delete(n);
      fks = fks.filter((f) => !f.columns.includes(n));
    } else if (o.op === 'renameColumn') {
      const from = ident(String(o.from), 'column');
      const to = ident(String(o.to), 'column');
      model = model.map((c) => (c.name === from ? { ...c, name: to } : c));
      fks = fks.map((f) => ({ ...f, columns: f.columns.map((x) => (x === from ? to : x)) }));
      copyFrom.set(to, from);
      copyFrom.delete(from);
    } else if (o.op === 'alterColumn') {
      const n = ident(String(o.name), 'column');
      const c = o.column as { name?: string; type: string; nullable?: boolean; default?: string | null };
      const to = c.name ? ident(c.name, 'column') : n;
      model = model.map((m) =>
        m.name === n ? { name: to, type: String(c.type), nullable: c.nullable !== false, primary: m.primary, autoInc: false, def: c.default ?? null } : m,
      );
      if (to !== n) {
        fks = fks.map((f) => ({ ...f, columns: f.columns.map((x) => (x === to || x === n ? to : x)) }));
        copyFrom.set(to, n);
        copyFrom.delete(n);
      }
    } else if (o.op === 'setPrimaryKey') {
      const colsPk = (o.columns as string[]).map((x) => ident(x, 'column'));
      model = model.map((m) => ({ ...m, primary: colsPk.includes(m.name), autoInc: false }));
    } else if (o.op === 'dropPrimaryKey') {
      model = model.map((m) => ({ ...m, primary: false, autoInc: false }));
    } else if (o.op === 'addForeignKey') {
      const fk = o.fk as { name?: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: string; onUpdate?: string };
      fks.push({
        name: fk.name,
        columns: fk.columns.map((x) => ident(x, 'column')),
        refTable: ident(fk.refTable, 'table'),
        refColumns: fk.refColumns.map((x) => ident(x, 'column')),
        ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
        ...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
      });
    } else if (o.op === 'dropForeignKey') {
      const n = String(o.name);
      // У SQLite имён нет (синтез fk_<table>_<id>): матчим по имени или по
      // колонкам, иначе дроп по автогенератному имени из схемы не найдётся.
      fks = fks.filter((f, i) => f.name !== n && `fk_${t}_${i}` !== n);
    } else if (o.op === 'renameTable') {
      finalName = ident(String(o.to), 'table');
    }
  }

  // Валидация типов через те же allowlist-генераторы, что и прямые ALTER.
  for (const c of model) {
    columnSql('sqlite', { name: c.name, type: c.type, nullable: c.nullable, primary: false, autoInc: false, default: c.def });
  }
  for (const f of fks) inlineForeignKeySql('sqlite', f);

  // Определение колонок: одиночный PK — inline, составной — табличным constraint.
  const pkCols = model.filter((c) => c.primary && !c.autoInc).map((c) => c.name);
  const singlePkInline = pkCols.length === 1;
  const defs: string[] = model.map((c) =>
    columnSql('sqlite', {
      name: c.name, type: c.type,
      nullable: singlePkInline && pkCols[0] === c.name ? true : c.nullable,
      primary: singlePkInline && pkCols[0] === c.name,
      autoInc: c.autoInc, default: c.def,
    }),
  );
  if (!singlePkInline && pkCols.length > 1) defs.push(`PRIMARY KEY (${pkCols.map((x) => q(x)).join(', ')})`);
  for (const f of fks) defs.push(inlineForeignKeySql('sqlite', f));

  const tmp = `_dbpanel_rebuild_${t}`.slice(0, 60);
  // Временная таблица могла остаться от оборванного прошлого rebuild.
  const statements: string[] = [
    `DROP TABLE IF EXISTS ${q(tmp)}`,
    `CREATE TABLE ${q(tmp)} (${defs.join(', ')})`,
  ];
  // Копируем только общие колонки (добавленные получат DEFAULT/NULL).
  const common = model.filter((c) => {
    const src = copyFrom.get(c.name);
    return src !== undefined && cols.some((o) => String(o.name) === src);
  });
  if (common.length) {
    statements.push(
      `INSERT INTO ${q(tmp)} (${common.map((c) => q(c.name)).join(', ')}) SELECT ${common.map((c) => q(copyFrom.get(c.name)!)).join(', ')} FROM ${q(t)}`,
    );
  }
  statements.push(`DROP TABLE ${q(t)}`);
  statements.push(`ALTER TABLE ${q(tmp)} RENAME TO ${q(finalName)}`);
  // Индексы и триггеры принадлежат таблице и умирают вместе с DROP: пересоздаём
  // их на финальном имени. Автоиндексы (sqlite_autoindex_*) сервер построит сам.
  const idxSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`).all(t) as { sql: string }[];
  const trgSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`).all(t) as { sql: string }[];
  const swapTable = (sql: string) => (finalName === t ? sql : sql.split(`"${t}"`).join(`"${finalName}"`));
  for (const r of idxSql) {
    const sql = String(r.sql ?? '').trim();
    if (sql) statements.push(swapTable(sql));
  }
  for (const r of trgSql) {
    const sql = String(r.sql ?? '').trim();
    if (sql) statements.push(swapTable(sql));
  }
  return { statements, finalName };
}

export const sqliteDriver: DbDriver = {
  kind: 'sqlite',
  async test(cfg) {
    if (!cfg.filePath) throw Object.assign(new Error('sqlite filePath required'), { statusCode: 400 });
    // Файла нет — это НЕ успешный тест: раньше open() молча создавал пустую БД
    // и отдавал ok:true на удалённом/переименованном файле.
    if (!existsSync(cfg.filePath)) throw Object.assign(new Error(`SQLite file not found: ${basename(cfg.filePath)}`), { statusCode: 404 });
    const t0 = Date.now();
    const db = new Database(cfg.filePath, { readonly: true, fileMustExist: true });
    try {
      db.prepare('SELECT 1').get();
      return { ok: true, latencyMs: Date.now() - t0 };
    } finally {
      db.close();
    }
  },
  async listDatabases(cfg) {
    // Файла нет (удалён) — категория пуста, но подключение живёт
    if (!cfg.filePath) return ['main'];
    const { existsSync } = await import('node:fs');
    if (!existsSync(cfg.filePath)) return [];
    return [basename(cfg.filePath)];
  },
  async listTables(cfg) {
    const db = open(cfg);
    try {
      // Представления — тоже объекты списка: созданный через панель VIEW иначе
      // нигде не виден (как уже у MySQL через SHOW TABLES).
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
      return rows.map((r) => r.name);
    } finally {
      db.close();
    }
  },
  async getSchema(cfg, _db, table): Promise<TableSchema> {
    const db = open(cfg);
    try {
      const t = ident(table, 'table');
      const meta = db.prepare(`SELECT type, sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(t) as { type: string; sql: string | null } | undefined;
      if (!meta) throw Object.assign(new Error(`Table not found: ${table}`), { statusCode: 404 });
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent('sqlite', t)})`).all() as PragmaColumn[];
      const idxList = db.prepare(`PRAGMA index_list(${quoteIdent('sqlite', t)})`).all() as PragmaIndex[];
      const fkList = db.prepare(`PRAGMA foreign_key_list(${quoteIdent('sqlite', t)})`).all() as PragmaForeignKey[];
      const trgList = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ? ORDER BY name`).all(t) as { name: string; sql: string | null }[];

      // Индексы: index_list даёт по строке на индекс, составные колонки — в index_info
      const indexes: SchemaIndex[] = idxList.slice().sort((a, b) => a.seq - b.seq).map((ix) => {
        const info = db.prepare(`PRAGMA index_info(${pragmaIdent(String(ix.name))})`).all() as { name: string | null }[];
        return {
          name: String(ix.name),
          unique: Number(ix.unique) === 1,
          // origin='pk' — индекс PRIMARY KEY (обычно sqlite_autoindex_<t>_1);
          // у INTEGER PRIMARY KEY его нет вовсе: это rowid-алиас
          primary: String(ix.origin) === 'pk',
          type: null,
          // у индекса по выражению index_info отдаёт name = NULL — такие пропускаем
          columns: info.map((r) => r.name).filter((n): n is string => n !== null && n !== undefined).map(String),
          where: null, // частичных индексов в SQLite нет
          definition: null
        };
      });

      // FK: строки идут по одной на колонку, группируем по id в порядке объявления.
      // Имени у FK в SQLite нет — генерируем стабильное fk_<table>_<id>
      const byFk = new Map<number, SchemaForeignKey>();
      for (const fk of fkList.slice().sort((a, b) => a.id - b.id || a.seq - b.seq)) {
        const id = Number(fk.id);
        let f = byFk.get(id);
        if (!f) {
          f = { name: `fk_${t}_${id}`, columns: [], refTable: String(fk.table), refColumns: [], onDelete: fkAction(fk.on_delete), onUpdate: fkAction(fk.on_update) };
          byFk.set(id, f);
        }
        f.columns.push(String(fk.from));
        if (fk.to !== null && fk.to !== undefined) f.refColumns.push(String(fk.to));
      }

      // Триггеры: тело — это весь CREATE TRIGGER, timing/event вытаскиваем регуляркой
      const triggers: SchemaTrigger[] = trgList.map((r) => {
        const sql = String(r.sql ?? '');
        return {
          name: String(r.name),
          timing: sql.match(/\b(BEFORE|AFTER|INSTEAD OF)\b/i)?.[1].toUpperCase() ?? null,
          event: sql.match(/\b(INSERT|UPDATE|DELETE)\b/i)?.[1].toUpperCase() ?? null,
          statement: sql
        };
      });

      const autoInc = autoIncColumns(meta.sql);
      return {
        table,
        kind: String(meta.type) === 'view' ? 'view' : 'table',
        comment: null, // у таблиц/представлений SQLite комментариев нет
        extra: {},
        columns: cols.map((c) => {
          const type = String(c.type ?? '').trim();
          const def = c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value);
          return {
            name: String(c.name),
            // колонка может быть объявлена вообще без типа — афинити тогда BLOB
            type: type || 'BLOB',
            nullable: !Number(c.notnull),
            primary: Number(c.pk) > 0,
            autoInc: /autoincrement/i.test(type) || (def !== null && /autoincrement/i.test(def)) || Boolean(autoInc?.has(String(c.name))),
            default: def,
            ordinal: Number(c.cid) + 1,
            comment: null,
            extra: null
          };
        }),
        indexes,
        foreignKeys: [...byFk.values()],
        triggers
      };
    } finally {
      db.close();
    }
  },
  async getPage(cfg, _db, table, page, pageSize, sort, filter): Promise<TablePage> {
    const t = ident(table, 'table');
    const p = Math.max(1, page || 1);
    const ps = Math.min(500, Math.max(1, pageSize || 50));
    let order = '';
    if (sort) {
      const [column, direction] = sort.split(':');
      order = `ORDER BY "${ident(column, 'column')}" ${direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }
    const params: unknown[] = [];
    const { clause: where, params: whereParams } = buildWhere(filter, (c) => `"${c}"`, { placeholder: () => '?', like: 'escape' });
    params.push(...whereParams);
    const db = open(cfg);
    try {
      const rows = db.prepare(`SELECT * FROM "${t}" ${where} ${order} LIMIT ? OFFSET ?`).all(...params, ps + 1, (p - 1) * ps) as Record<string, unknown>[];
      const truncated = rows.length > ps;
      const slice = rows.slice(0, ps);
      return { columns: Object.keys(slice[0] ?? {}), rows: slice, page: p, pageSize: ps, truncated };
    } finally {
      db.close();
    }
  },
  async updateRowsBulk(cfg, _db, table, filter, patch) {
    assertWritable(cfg, 'update bulk');
    validateRow(patch, 'patch');
    if (!Object.keys(patch).length) throw Object.assign(new Error('Bulk update needs at least one column'), { statusCode: 400 });
    const t = ident(table, 'table');
    const db = open(cfg);
    try {
      const set = Object.keys(patch).map(k => `"${ident(k, 'column')}"=?`).join(', ');
      const { clause, params } = buildWhere(filter, (c) => `"${c}"`, { placeholder: () => '?', like: 'escape' });
      const info = db.prepare(`UPDATE "${t}" SET ${set} ${clause}`).run(...Object.values(patch) as any[], ...params as any[]);
      return { affected: info.changes };
    } finally { db.close(); }
  },
  async deleteRowsBulk(cfg, _db, table, filter) {
    assertWritable(cfg, 'delete bulk');
    const t = ident(table, 'table');
    const db = open(cfg);
    try {
      const { clause, params } = buildWhere(filter, (c) => `"${c}"`, { placeholder: () => '?', like: 'escape' });
      const info = db.prepare(`DELETE FROM "${t}" ${clause}`).run(...params as any[]);
      return { affected: info.changes };
    } finally { db.close(); }
  },
  async query(cfg, sql, limits: QueryLimits): Promise<TabularResult> {
    assertWritable(cfg, sql);
    const t0 = Date.now();
    const db = open(cfg);
    try {
      // prepare() выполняет только первый стейтмент — скрипт крутим по частям,
      // возвращаем результат последнего
      const statements = splitStatements(sql);
      let last: TabularResult = { columns: [], rows: [], rowCount: 0, truncated: false, execMs: 0 };
      for (const stmtSql of statements.length ? statements : [sql]) {
        const capped = capSelect(stmtSql, limits.maxRows);
        const stmt = db.prepare(capped);
        if (stmt.reader) {
          const rows = stmt.all() as Record<string, unknown>[];
          const truncated = rows.length > limits.maxRows;
          const slice = rows.slice(0, limits.maxRows);
          last = { columns: Object.keys(slice[0] ?? {}), rows: slice, rowCount: slice.length, truncated, execMs: Date.now() - t0 };
        } else {
          const info = stmt.run();
          last = { columns: ['changes'], rows: [{ changes: info.changes }], rowCount: 1, truncated: false, execMs: Date.now() - t0 };
        }
      }
      return last;
    } finally {
      db.close();
    }
  },
  async execScript(cfg, _db, script) {
    assertWritable(cfg, script);
    if (script.length > 5_000_000) throw Object.assign(new Error('Script too large (5MB)'), { statusCode: 413 });
    const t0 = Date.now();
    const db = open(cfg);
    try {
      db.exec(script);
      return { statements: countStatements(script), execMs: Date.now() - t0 };
    } finally {
      db.close();
    }
  },
  async importRows(cfg, _db, table, rows) {
    assertWritable(cfg, 'insert');
    if (!rows.length) return { inserted: 0, execMs: 0 };
    if (rows.length > 50_000) throw Object.assign(new Error('Too many rows (50k)'), { statusCode: 413 });
    const t = ident(table, 'table');
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => ident(c, 'column'));
    const t0 = Date.now();
    const db = open(cfg);
    try {
      const stmt = db.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      const tx = db.transaction((list: Record<string, unknown>[]) => {
        for (const r of list) stmt.run(...cols.map((c) => (r[c] ?? null) as unknown));
      });
      tx(rows);
      return { inserted: rows.length, execMs: Date.now() - t0 };
    } finally {
      db.close();
    }
  },
  async *streamRows(cfg, _db, table, batchSize = 1000) {
    const t = ident(table, 'table');
    const db = open(cfg);
    try {
      // better-sqlite3 iterate(): ленивый курсор, по одной строке
      let batch: Record<string, unknown>[] = [];
      for (const r of db.prepare(`SELECT * FROM "${t}"`).iterate()) {
        batch.push(r as Record<string, unknown>);
        if (batch.length >= batchSize) { yield batch; batch = []; }
      }
      if (batch.length) yield batch;
    } finally {
      db.close();
    }
  },
  async getRelations(cfg, _db): Promise<Relation[]> {
    const db = open(cfg);
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
      const out: Relation[] = [];
      for (const { name } of tables) {
        const t = ident(name, 'table');
        const fks = (db.prepare(`PRAGMA foreign_key_list(${quoteIdent('sqlite', t)})`).all() as PragmaForeignKey[])
          .slice().sort((a, b) => a.id - b.id || a.seq - b.seq);
        for (const fk of fks) {
          out.push({
            table: name,
            column: ident(String(fk.from), 'column'),
            refTable: ident(String(fk.table), 'table'),
            refColumn: fk.to === null || fk.to === undefined ? '' : ident(String(fk.to), 'column'),
            // имени у FK нет — то же сгенерированное имя, что и в getSchema
            constraint: `fk_${t}_${Number(fk.id)}`,
            onDelete: fkAction(fk.on_delete),
            onUpdate: fkAction(fk.on_update)
          });
        }
      }
      return out;
    } finally {
      db.close();
    }
  },
  async getStatus(cfg) {
    if (!cfg.filePath) throw Object.assign(new Error('sqlite filePath required'), { statusCode: 400 });
    if (!existsSync(cfg.filePath)) {
      return {
        version: 'SQLite (file missing)',
        processlist: [],
        dbSizes: [{ db: basename(cfg.filePath), bytes: 0, tables: 0 }],
        extra: { fileMissing: true },
      };
    }
    const st = statSync(cfg.filePath);
    const db = open(cfg);
    try {
      const ver = db.prepare(`SELECT sqlite_version() AS v`).get() as { v: string };
      const pageCount = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
      const pageSize = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;
      const free = (db.prepare(`PRAGMA freelist_count`).get() as { freelist_count: number }).freelist_count;
      const tables = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get() as { c: number };
      return {
        version: `SQLite ${ver.v}`,
        processlist: [],
        dbSizes: [{ db: basename(cfg.filePath), bytes: st.size, tables: tables.c }],
        extra: { pageCount, pageSize, freelistCount: free }
      };
    } finally {
      db.close();
    }
  },
  async clearTable(cfg, _db, table) {
    assertWritable(cfg, 'delete');
    const t = ident(table, 'table');
    const db = open(cfg);
    try {
      const info = db.prepare(`DELETE FROM "${t}"`).run();
      return { deleted: info.changes };
    } finally {
      db.close();
    }
  },
  async createTable(cfg, _db, def) {
    assertWritable(cfg, 'create');
    const t = ident(def.name, 'table');
    if (!def.columns?.length || def.columns.length > 200) throw Object.assign(new Error('Need 1..200 columns'), { statusCode: 400 });
    const cols = def.columns.map((c) => columnSql('sqlite', c));
    // Внешние ключи объявляем прямо в CREATE: у SQLite нет
    // ALTER TABLE ADD CONSTRAINT, поэтому ключ, добавленный позже, добавить
    // нельзя, а модель, применённая к SQLite, теряла все связи.
    for (const fk of def.foreignKeys ?? []) cols.push(inlineForeignKeySql('sqlite', fk));
    const db = open(cfg);
    try {
      const statement = `CREATE TABLE "${t}" (${cols.join(', ')})`;
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async planAlter(cfg, _db, table, ops) {
    const t = ident(table, 'table');
    if (!ops?.length || ops.length > 50) throw Object.assign(new Error('Need 1..50 ops'), { statusCode: 400 });
    const q = (n: string) => `"${n}"`;
    const db = open(cfg);
    const statements: string[] = [];
    try {
      // Операции, требующие пересоздания таблицы: строим rebuild-скрипт первым,
      // остальные (индексы, переименование) идут после него в той же транзакции.
      // Имя для последующих индексных стейтментов — финальное (после renameTable).
      const NEEDS_REBUILD = new Set(['alterColumn', 'setPrimaryKey', 'dropPrimaryKey', 'addForeignKey', 'dropForeignKey']);
      const needsRebuild = ops.some((o) => NEEDS_REBUILD.has((o as { op: string }).op));
      let target = t;
      if (needsRebuild) {
        const rb = buildRebuildStatements(db, t, ops as { op: string; [k: string]: unknown }[]);
        statements.push(...rb.statements);
        target = rb.finalName;
      }
      for (const o of ops) {
        switch (o.op) {
          case 'addColumn':
            if (needsRebuild) break; // уже в rebuild-скрипте
            statements.push(`ALTER TABLE ${q(target)} ADD COLUMN ${columnSql('sqlite', o.column)}`); break;
          case 'dropColumn':
            if (needsRebuild) break;
            statements.push(`ALTER TABLE ${q(target)} DROP COLUMN ${q(ident(o.name, 'column'))}`); break;
          case 'renameColumn':
            if (needsRebuild) break;
            statements.push(`ALTER TABLE ${q(target)} RENAME COLUMN ${q(ident(o.from, 'column'))} TO ${q(ident(o.to, 'column'))}`); break;
          // alterColumn/setPK/dropPK/addFK/dropFK — уже в rebuild-скрипте выше.
          case 'alterColumn': case 'setPrimaryKey': case 'dropPrimaryKey': case 'addForeignKey': case 'dropForeignKey':
            if (!needsRebuild) throw Object.assign(new Error(`Unsupported alter op: ${(o as { op: string }).op}`), { statusCode: 400 });
            break;
          case 'renameTable': {
            if (needsRebuild) break; // финальное имя уже применено в rebuild
            if (sqliteVersionAtLeast(db, 3, 25)) statements.push(`ALTER TABLE ${q(target)} RENAME TO ${q(ident(o.to, 'table'))}`);
            else throw Object.assign(new Error('Renaming a table requires SQLite 3.25+'), { statusCode: 400 });
            break;
          }
          case 'addIndex': statements.push(indexSql('sqlite', target, o.index)); break;
          case 'dropIndex': statements.push(dropIndexSql('sqlite', target, o.name)); break;
          default: throw Object.assign(new Error(`Unsupported alter op: ${(o as { op: string }).op}`), { statusCode: 400 });
        }
      }
    } finally {
      db.close();
    }
    return { statements, transactional: true };
  },
  async alterTable(cfg, _db, table, ops) {
    assertWritable(cfg, 'alter');
    const t = ident(table, 'table');
    // Тот же построитель, что и в предпросмотре: apply не может разойтись
    // с тем, что показали пользователю.
    const { statements, transactional } = await this.planAlter!(cfg, _db, table, ops);
    const db2 = open(cfg);
    try {
      // DDL в SQLite транзакционный: пакет применяется целиком, ошибка
      // откатывает всё (в отличие от MySQL, где DDL коммитится неявно).
      // На время rebuild гасим FK и триггеры по официальной 12-шаговой
      // процедуре SQLite, иначе DROP TABLE упрётся в чужие ссылки.
      let applied = 0;
      const run = db2.transaction(() => {
        db2.exec('PRAGMA foreign_keys=OFF');
        try {
          for (const s of statements) {
            db2.exec(s);
            applied++;
          }
          const bad = db2.prepare('PRAGMA foreign_key_check').all() as unknown[];
          if (bad.length) throw Object.assign(new Error(`Foreign key check failed: ${JSON.stringify(bad).slice(0, 200)}`), { statusCode: 400 });
        } finally {
          db2.exec('PRAGMA foreign_keys=ON');
        }
      });
      run();
      return { ok: true as const, statements, applied, transactional };
    } finally {
      db2.close();
    }
  },
  async dropTable(cfg, _db, table) {
    assertWritable(cfg, 'drop');
    const db = open(cfg);
    try {
      const statement = `DROP TABLE "${ident(table, 'table')}"`;
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async createView(cfg, _db, def) {
    assertWritable(cfg, 'create view');
    const t = ident(def.name, 'table');
    const select = checkViewSql(def.sql);
    const db = open(cfg);
    try {
      // Дубликат — 409, а не 500 от сервера (как translateDriverError для остальных).
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(t);
      if (exists) throw Object.assign(new Error(`Already exists: ${t}`), { statusCode: 409 });
      const statement = `CREATE VIEW "${t}" AS ${select}`;
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async dropView(cfg, _db, name) {
    assertWritable(cfg, 'drop view');
    const t = ident(name, 'table');
    const db = open(cfg);
    try {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`).get(t);
      if (!exists) throw Object.assign(new Error(`Not found: ${t}`), { statusCode: 404 });
      const statement = `DROP VIEW "${t}"`;
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async createTrigger(cfg, _db, table, def) {
    assertWritable(cfg, 'create trigger');
    const t = ident(table, 'table');
    const name = ident(def.name, 'trigger');
    const timing = checkTriggerTiming(def.timing);
    const event = checkTriggerEvent(def.event);
    // Тело — свободный SQL, стейтментов может быть несколько: оборачиваем их
    // в BEGIN ... END. Если пользователь BEGIN/END уже написал — не трогаем.
    const body = checkTriggerBody(def.statement, true);
    const wrapped = /^BEGIN\b/i.test(body) ? body : `BEGIN ${body}; END`;
    const statement = `CREATE TRIGGER "${name}" ${timing} ${event} ON "${t}" ${wrapped}`;
    const db = open(cfg);
    try {
      // Именно exec: query() режет скрипт по ';' и тело из нескольких
      // стейтментов выполнил бы только частично.
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async dropTrigger(cfg, _db, _table, name) {
    assertWritable(cfg, 'drop trigger');
    const db = open(cfg);
    try {
      // Имя триггера в SQLite уникально для всей схемы, таблица не нужна
      const statement = `DROP TRIGGER IF EXISTS "${ident(name, 'trigger')}"`;
      db.exec(statement);
      return { ok: true as const, statement };
    } finally {
      db.close();
    }
  },
  async listDbUsers() {
    return []; // SQLite без пользователей
  },
  async createDbUser() {
    throw Object.assign(new Error('SQLite has no DB users'), { statusCode: 400 });
  },
  async dropDbUser() {
    throw Object.assign(new Error('SQLite has no DB users'), { statusCode: 400 });
  },
  async listGrants() { return []; },
  async grant() { throw Object.assign(new Error('SQLite has no grants'), { statusCode: 400 }); },
  async revoke() { throw Object.assign(new Error('SQLite has no grants'), { statusCode: 400 }); },
  async insertRow(cfg, _db, table, row) {
    assertWritable(cfg, 'insert');
    validateRow(row);
    const t = ident(table,'table');
    const cols = Object.keys(row).map(k=>ident(k,'column'));
    const db = open(cfg);
    try {
      const info = db.prepare(`INSERT INTO "${t}" (${cols.map(c=>`"${c}"`).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c] as any));
      return { insertedId: info.lastInsertRowid };
    } finally { db.close(); }
  },
  async updateRow(cfg, _db, table, filter, patch) {
    assertWritable(cfg, 'update');
    validateRow(filter,'filter'); validateRow(patch,'patch');
    const t = ident(table,'table');
    const db = open(cfg);
    try {
      const set = Object.keys(patch).map(k=>`"${ident(k,'column')}"=?`).join(', ');
      const where = Object.keys(filter).map(k=>`"${ident(k,'column')}"=?`).join(' AND ');
      const info = db.prepare(`UPDATE "${t}" SET ${set} WHERE ${where}`).run(...Object.values(patch) as any[], ...Object.values(filter) as any[]);
      return { matched: info.changes };
    } finally { db.close(); }
  },
  async deleteRow(cfg, _db, table, filter) {
    assertWritable(cfg, 'delete');
    validateRow(filter,'filter');
    const t = ident(table,'table');
    const db = open(cfg);
    try {
      const where = Object.keys(filter).map(k=>`"${ident(k,'column')}"=?`).join(' AND ');
      const info = db.prepare(`DELETE FROM "${t}" WHERE ${where}`).run(...Object.values(filter) as any[]);
      return { deleted: info.changes };
    } finally {
      db.close();
    }
  },
  // Точное чтение по фильтру-объекту: нужно для отката изменений данных.
  async findRows(cfg, _db, table, filter, limit = 50) {
    validateRow(filter, 'filter');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 501);
    const t = ident(table, 'table');
    const db = open(cfg);
    try {
      const where = Object.keys(filter).map(k=>`"${ident(k,'column')}"=?`).join(' AND ');
      return db.prepare(`SELECT * FROM "${t}" WHERE ${where} LIMIT ${lim}`).all(...Object.values(filter) as any[]) as Record<string, unknown>[];
    } finally {
      db.close();
    }
  },
  async explain(cfg, _db, sql) {
    assertWritable(cfg, 'select');
    const t0 = Date.now();
    const db = open(cfg);
    try {
      // В SQLite это план без выполнения запроса (байткод — отдельный EXPLAIN)
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Record<string, unknown>[];
      return { columns: ['id', 'parent', 'notused', 'detail'], rows, rowCount: rows.length, truncated: false, execMs: Date.now() - t0 };
    } finally {
      db.close();
    }
  },

  async killQuery() {
    throw Object.assign(new Error('Kill not supported for SQLite'), { statusCode: 400 });
  }
};
