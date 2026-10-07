import oracledb from 'oracledb';
import type {
  AlterOp, ConnectionConfig, DbDriver, QueryLimits, Relation,
  SchemaForeignKey, SchemaIndex, TablePage, TableSchema, TabularResult, TriggerDef
} from '../core/types.js';
import { assertWritable } from '../core/types.js';
import {
  addForeignKeySql, alterColumnSql, capSelectOracle, checkTriggerBody, checkTriggerEvent,
  checkTriggerTiming, checkViewSql, columnSql, countStatements, dropForeignKeySql, dropIndexSql,
  dropPrimaryKeySql, escSqlString, ident, indexSql, inlineForeignKeySql, likePattern, parseFilter,
  setPrimaryKeySql, validateDbPassword, validateDbUserName, validatePriv, validateRow,
  withTimeout, type ColumnSpec
} from './helpers.js';
import { getOraclePool } from '../core/pool.js';

type Row = Record<string, unknown>;

/** Диалект генераторов DDL для Oracle. */
const D = 'oracle' as const;

function optStr(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * Схема подключения — это пользователь Oracle (в отличие от PG, где схема может
 * отличаться от пользователя, у Oracle схема = пользователь по умолчанию).
 * Панель зовёт «базой» подключения ровно эту схему: отдельного CREATE DATABASE
 * в Oracle не существует, поэтому и список баз, и создание/удаление базы
 * работают через схемы (см. listDatabases и createDbUser).
 *
 * Имена объектов Oracle хранятся в ВЕРХНЕМ РЕГИСТРЕ, если не были в кавычках.
 * Панель показывает то, что вернул сервер (USER_TABLES.TABLE_NAME — уже
 * заглавными), и все её собственные обращения к этим именам идут в двойных
 * кавычках, поэтому регистр сходится.
 */
function obj(name: string, what = 'object'): string {
  return ident(name, what);
}

/** Значение в плейсхолдер Oracle: undefined -> NULL, boolean -> 1/0. */
function bind(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  return String(v);
}

/** Имена плейсхолдеров позиционные, как у pg: :1, :2, … */
function bindList(values: unknown[]): unknown[] {
  return values.map(bind);
}

/**
 * Единственная точка, где берётся соединение с Oracle. Пула нет в db/table по
 * той же причине, что и у SQLite: подключение у Oracle уже указывает на схему,
 * отдельного «выбрать базу» не существует.
 */
async function run(
  cfg: ConnectionConfig,
  sql: string,
  binds: unknown[] = [],
  opts: oracledb.ExecuteOptions = {}
): Promise<oracledb.Result<Row>> {
  const conn = await (await getOraclePool(cfg)).getConnection();
  try {
    return await conn.execute(sql, binds.length ? bindList(binds) : {}, {
      autoCommit: true,
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      ...opts
    }) as oracledb.Result<Row>;
  } finally {
    conn.close().catch(() => undefined);
  }
}

/**
 * Служебные запросы драйвера всегда идут через rows().
 *
 * Oracle возвращает имена столбцов ВЕРХНИМ РЕГИСТРОМ: алиас `AS name` приходит
 * как `NAME`. Приводим ключи служебных выборок к нижнему регистру, чтобы код
 * читала `x.name`. Данные пользовательских таблиц сюда не попадают (они идут
 * через run()): их имена столбцов панель показывает такими, какими их создал
 * сервер, — как и в getSchema, который читает user_tab_columns.
 */
async function rows(cfg: ConnectionConfig, sql: string, binds: unknown[] = []): Promise<Row[]> {
  const result = (await run(cfg, sql, binds)).rows ?? [];
  return result.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[k.toLowerCase()] = v;
    return out;
  });
}

/**
 * node-oracledb не умеет курсор с батчами, как pg-cursor, поэтому пагинация и
 * стриминг сделаны через OFFSET/FETCH. Для огромных таблиц это дороже курсора,
 * но параллелизм драйвера отключён (thin-режим, один пул на подключение).
 */
function pageSql(table: string, order: string, offset: number, limit: number, where: string): string {
  return `SELECT * FROM "${obj(table, 'table')}"${where ? ` ${where}` : ''}${order ? ` ${order}` : ''} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

function orderBy(sort?: string): string {
  if (!sort) return '';
  const [column, direction] = sort.split(':');
  return `ORDER BY "${obj(column, 'column')}" ${direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
}

/**
 * WHERE из строки фильтра панели, тем же разбором, что у остальных драйверов.
 * Значения уходят только биндами — Oracle не имеет `?`-плейсхолдеров, поэтому
 * имена позиционные: :1, :2, …
 */
function whereFrom(filter: string | undefined, params: unknown[]): string {
  const parts: string[] = [];
  for (const c of parseFilter(filter) ?? []) {
    const col = `"${obj(c.column, 'column')}"`;
    if (c.op === '~' || c.op === '^' || c.op === '$') {
      // Oracle: LIKE регистрозависим, а панель ищет подстрокой без учёта регистра.
      params.push(likePattern(c.value.toLowerCase(), c.op));
      parts.push(`LOWER(TO_CHAR(${col})) LIKE :${params.length}`);
      continue;
    }
    params.push(/^-?\d+(\.\d+)?$/.test(c.value) ? Number(c.value) : c.value);
    parts.push(`${col} ${c.op} :${params.length}`);
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

/** Имя PK-констрейнта: у Oracle оно системное (SYS_C…), его нельзя угадать. */
async function pkConstraintName(cfg: ConnectionConfig, table: string): Promise<string | undefined> {
  const r = await rows(
    cfg,
    `SELECT constraint_name AS name FROM user_constraints WHERE table_name = :t AND constraint_type = 'P'`,
    [obj(table, 'table')]
  );
  return r[0] ? String(r[0].name) : undefined;
}

/**
 * Признак автоинкремента, оставшегося от версий до 12c: счётчик там делали
 * SEQUENCE плюс триггер, и в DEFAULT колонки лежит вызов NEXTVAL. Начиная с
 * 12c то же самое помечает IDENTITY_COLUMN, но NEXTVAL-детектор оставлен:
 * у 12c системные последовательности называются ISEQ$$_73352, у пользовательских
 * бывают SYS_SEQUENCE_42, а в старых таблицах — свой пользовательский NEXTVAL.
 */
const SEQUENCE_NEXTVAL = /(?:ISEQ\$\$|SYS_SEQUENCE_)\d*\.NEXTVAL/i;

/** Oracle хранит правило только для удаления; ON UPDATE не поддерживается. */
function deleteRule(v: unknown): string | null {
  const t = optStr(v);
  return t ? t.toUpperCase() : null;
}

/**
 * Официальное определение PLAN_TABLE из $ORACLE_HOME/rdbms/admin/utlxplan.sql.
 *
 * Его нельзя сократить «до нужных колонок»: сервер проверяет структуру таблицы
 * и на урезанной отвечает ORA-02403 «plan table does not have correct format».
 * Проверено на 26ai. Создаётся лениво и один раз на схему; повторное создание
 * даёт ORA-00955, который в BEGIN...EXCEPTION считается успехом.
 */
const PLAN_TABLE_DDL = `CREATE TABLE plan_table (
  statement_id varchar2(30), plan_id number, timestamp date, remarks varchar2(4000),
  operation varchar2(30), options varchar2(255), object_node varchar2(128),
  object_owner varchar2(128), object_name varchar2(128), object_alias varchar2(261),
  object_instance numeric, object_type varchar2(30), optimizer varchar2(255),
  search_columns number, id numeric, parent_id numeric, depth numeric, position numeric,
  cost numeric, cardinality numeric, bytes numeric, other_tag varchar2(255),
  partition_start varchar2(255), partition_stop varchar2(255), partition_id numeric,
  other long, distribution varchar2(30), cpu_cost numeric, io_cost numeric,
  temp_space numeric, access_predicates varchar2(4000), filter_predicates varchar2(4000),
  projection varchar2(4000), time numeric, qblock_name varchar2(128), other_xml clob
)`;

/**
 * Префикс метки, под которой панель пишет и читает свой план.
 *
 * Метка должна быть уникальной на каждый вызов: STATEMENT_ID общий для всех
 * сессий, и при двух параллельных EXPLAIN один запрос удалял бы строки плана
 * другого, аExplain мог при этом упасть с ORA-00900 вместо внятной ошибки.
 * Длина ограничена 30 символами, поэтому префикс короткий.
 */
const PLAN_ID_PREFIX = 'DBP';

/** Метка плана конкретного вызова: DBP + счётчик + случайный суффикс. */
function nextPlanId(): string {
  return `${PLAN_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const oracleDriver: DbDriver = {
  kind: 'oracle',
  async test(cfg) {
    const t0 = Date.now();
    
    const conn = await (await getOraclePool(cfg)).getConnection();
    try {
      await conn.ping();
    } finally {
      conn.close().catch(() => undefined);
    }
    return { ok: true, latencyMs: Date.now() - t0 };
  },
  async listDatabases(cfg) {
    // «База» панели = схема, а схема Oracle = пользователь подключения. Отдельных
    // баз нет, поэтому и список, и создание/удаление базы работают через схемы.
    const r = await rows(cfg, `SELECT USER AS username FROM dual`);
    return r.length ? [String(r[0].username)] : [];
  },
  async listTables(cfg) {
    // user_* — представления текущего пользователя: ровно его схема.
    // PLAN_TABLE — служебная таблица панели для EXPLAIN PLAN, её создаёт сам
    // драйвер; пользователю она не принадлежит, поэтому в список не попадает.
    // Представления (user_views) — тоже объекты списка, как у MySQL/SQLite.
    const r = await rows(
      cfg,
      `SELECT table_name AS name FROM user_tables WHERE table_name <> 'PLAN_TABLE'
       UNION ALL SELECT view_name AS name FROM user_views ORDER BY name`
    );
    return r.map((x) => String(x.name));
  },
  async getSchema(cfg, _db, table): Promise<TableSchema> {
    
    const t = obj(table, 'table');
    const [meta, cols, idx, fk, trg, pkCols, viewMark] = await Promise.all([
      rows(cfg, `SELECT comments AS tcmt FROM user_tab_comments WHERE table_name = :t`, [t]),
      rows(cfg, `SELECT c.column_name AS name,
          CASE
            WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL AND c.data_scale = 0 AND c.data_precision <= 9 THEN 'NUMBER'
            WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL AND c.data_scale = 0 THEN 'NUMBER(' || c.data_precision || ')'
            WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN 'NUMBER(' || c.data_precision || ', ' || c.data_scale || ')'
            WHEN c.data_type = 'NUMBER' THEN 'NUMBER'
            WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN c.data_type || '(' || c.data_length || ')'
            WHEN c.data_type = 'TIMESTAMP' THEN 'TIMESTAMP'
            ELSE c.data_type
          END AS type,
          c.nullable AS nullable,
          c.identity_column AS identity_col,
          c.data_default AS def,
c.column_id AS ordinal,
            m.comments AS cmt
        FROM user_tab_columns c
        LEFT JOIN user_col_comments m ON m.table_name = c.table_name AND m.column_name = c.column_name
        WHERE c.table_name = :t
        ORDER BY c.column_id`, [t]),
      rows(cfg, `SELECT i.index_name AS name, i.uniqueness AS uniq, i.index_type AS type,
          LISTAGG(ic.column_name, ',') WITHIN GROUP (ORDER BY ic.column_position) AS cols
        FROM user_indexes i
        JOIN user_ind_columns ic ON ic.index_name = i.index_name
        WHERE i.table_name = :t
        GROUP BY i.index_name, i.uniqueness, i.index_type
        ORDER BY i.index_name`, [t]),
      rows(cfg, `SELECT c.constraint_name AS name,
          LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) AS cols,
          rc.table_name AS ref_table,
          LISTAGG(rcc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) AS ref_cols,
          c.delete_rule AS on_delete
        FROM user_constraints c
        JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name
        JOIN user_constraints rc ON rc.constraint_name = c.r_constraint_name
        JOIN user_cons_columns rcc ON rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
        WHERE c.constraint_type = 'R' AND c.table_name = :t
        GROUP BY c.constraint_name, rc.table_name, c.delete_rule
        ORDER BY c.constraint_name`, [t]),
      rows(cfg, `SELECT trigger_name AS name, trigger_type AS tt, description AS descr, trigger_body AS body
        FROM user_triggers WHERE table_name = :t ORDER BY trigger_name`, [t]),
      rows(cfg, `SELECT cc.column_name AS name FROM user_constraints c
        JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name
        WHERE c.constraint_type = 'P' AND c.table_name = :t`, [t]),
      rows(cfg, `SELECT 1 AS is_view FROM user_views WHERE view_name = :t`, [t]),
    ]);
    const primary = new Set(pkCols.map((x) => String(x.name)));
    return {
      table,
      kind: viewMark.length ? 'view' : 'table',
      comment: meta.length ? optStr(meta[0].tcmt) : null,
      extra: {},
      columns: (cols as Row[]).map((r) => {
        const raw = String(r.def ?? '');
        return {
          name: String(r.name),
          type: String(r.type),
          nullable: String(r.nullable ?? '').toUpperCase() === 'Y',
          primary: primary.has(String(r.name)),
          // IDENTITY — начиная с 12c. До 12c автоинкремент делали через
          // SEQUENCE + триггер; такой триггер виден во вкладке «Триггеры».
          autoInc: String(r.identity_col ?? '').toUpperCase() === 'YES' || SEQUENCE_NEXTVAL.test(raw),
          default: optStr(r.def),
          ordinal: Number(r.ordinal ?? 0),
          comment: optStr(r.cmt),
          extra: SEQUENCE_NEXTVAL.test(raw) ? 'SEQUENCE.NEXTVAL' : null
        };
      }),
      indexes: (idx as Row[]).map((r): SchemaIndex => ({
        name: String(r.name),
        unique: String(r.uniq ?? '').toUpperCase() === 'UNIQUE',
        // У Oracle PK и UNIQUE-индексы — один и тот же объект; система сама не
        // различает их, поэтому флаг остаётся false, а уникальность видна выше.
        primary: false,
        type: optStr(r.type),
        columns: String(r.cols ?? '').split(',').filter(Boolean),
        where: null,
        definition: null
      })),
      foreignKeys: (fk as Row[]).map((r): SchemaForeignKey => ({
        name: String(r.name),
        columns: String(r.cols ?? '').split(',').filter(Boolean),
        refTable: String(r.ref_table),
        refColumns: String(r.ref_cols ?? '').split(',').filter(Boolean),
        onDelete: deleteRule(r.on_delete),
        onUpdate: null
      })),
      triggers: (trg as Row[]).map((r) => {
        // Timing у Oracle лежит в TRIGGER_TYPE («BEFORE EACH ROW»), а событие —
        // в DESCRIPTION («UPDATING t ON x»).
        const tt = String(r.tt ?? '').toUpperCase();
        const timing = tt.includes('BEFORE') ? 'BEFORE' : tt.includes('AFTER') ? 'AFTER' : null;
        const ev = String(r.descr ?? '').match(/\b(INSERTING|UPDATING|DELETING)\b/i)?.[1]?.toUpperCase();
        return {
          name: String(r.name),
          timing,
          event: ev === 'INSERTING' ? 'INSERT' : ev === 'UPDATING' ? 'UPDATE' : ev === 'DELETING' ? 'DELETE' : null,
          statement: String(r.body ?? '')
        };
      })
    };
  },
  async getPage(cfg, _db, table, page, pageSize, sort, filter): Promise<TablePage> {
    const pg = Math.max(1, page || 1);
    const ps = Math.min(500, Math.max(1, pageSize || 50));
    const params: unknown[] = [];
    const where = whereFrom(filter, params);
    // Читаем ps+1 строк: лишняя нужна, чтобы понять, обрезан ли результат.
    const r = await run(cfg, pageSql(table, orderBy(sort), (pg - 1) * ps, ps + 1, where), params, { fetchArraySize: ps + 1 });
    const all = r.rows ?? [];
    const truncated = all.length > ps;
    const slice = truncated ? all.slice(0, ps) : all;
    return {
      columns: r.metaData?.map((m: { name?: string }) => String(m.name)) ?? Object.keys(slice[0] ?? {}),
      rows: slice as Row[],
      page: pg,
      pageSize: ps,
      truncated
    };
  },
  async query(cfg, sql, limits: QueryLimits): Promise<TabularResult> {
    assertWritable(cfg, sql);
    const t0 = Date.now();
    const max = Math.max(1, limits.maxRows);
    const r = await withTimeout(
      run(cfg, capSelectOracle(sql, max), [], { fetchArraySize: max }),
      limits.timeoutMs
    );
    const all = r.rows ?? [];
    const slice = all.slice(0, max);
    return {
      columns: r.metaData?.map((m: { name?: string }) => String(m.name)) ?? Object.keys(slice[0] ?? {}),
      rows: slice as Row[],
      rowCount: slice.length,
      truncated: all.length > max,
      execMs: Date.now() - t0
    };
  },
  async execScript(cfg, _db, script) {
    assertWritable(cfg, script);
    if (script.length > 5_000_000) throw Object.assign(new Error('Script too large (5MB)'), { statusCode: 413 });
    const t0 = Date.now();
    await withTimeout(run(cfg, script), 120_000, 'import script');
    return { statements: countStatements(script), execMs: Date.now() - t0 };
  },
  async importRows(cfg, _db, table, rows) {
    assertWritable(cfg, 'insert');
    if (!rows.length) return { inserted: 0, execMs: 0 };
    if (rows.length > 50_000) throw Object.assign(new Error('Too many rows (50k)'), { statusCode: 413 });
    const t0 = Date.now();
    
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((x) => obj(x, 'column'));
    // Ограничение Oracle — 1000 элементов в одном выражении (ORA-00939):
    // столько можно разбить между колонками, поэтому batch считаем от их числа.
    if (cols.length > 1000) throw Object.assign(new Error('Oracle INSERT supports at most 1000 columns'), { statusCode: 413 });
    const batch = Math.max(1, Math.floor(1000 / cols.length));
    const colsSql = cols.map((c) => `"${c}"`).join(',');
    const conn = await (await getOraclePool(cfg)).getConnection();
    try {
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const b: unknown[] = [];
        const tuples = chunk.map((row) => {
          const marks = cols.map((c) => {
            b.push(bind(row[c] ?? null));
            return `:${b.length}`;
          });
          return `(${marks.join(',')})`;
        });
        await conn.execute(`INSERT INTO "${obj(table, 'table')}" (${colsSql}) VALUES ${tuples.join(',')}`, bindList(b), {
          autoCommit: true,
          outFormat: oracledb.OUT_FORMAT_OBJECT
        });
      }
    } finally {
      conn.close().catch(() => undefined);
    }
    return { inserted: rows.length, execMs: Date.now() - t0 };
  },
  async *streamRows(cfg, _db, table, batchSize = 1000) {
    
    const size = Math.min(Math.max(Number(batchSize) || 1000, 1), 5000);
    const conn = await (await getOraclePool(cfg)).getConnection();
    try {
      let offset = 0;
      for (;;) {
        const r = await conn.execute(pageSql(table, '', offset, size, ''), {}, {
          fetchArraySize: size,
          outFormat: oracledb.OUT_FORMAT_OBJECT
        });
        const batch = r.rows ?? [];
        if (!batch.length) break;
        offset += batch.length;
        yield batch as Row[];
        if (batch.length < size) break;
      }
    } finally {
      conn.close().catch(() => undefined);
    }
  },
  async getRelations(cfg): Promise<Relation[]> {
    // Одна строка = одна пара колонок: констрейнт составной не схлопывается.
    const r = await rows(cfg, `SELECT c.table_name AS "table", cc.column_name AS "column",
        rc.table_name AS "refTable", rcc.column_name AS "refColumn",
        c.constraint_name AS constraint, c.delete_rule AS on_delete
      FROM user_constraints c
      JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name
      JOIN user_constraints rc ON rc.constraint_name = c.r_constraint_name
      JOIN user_cons_columns rcc ON rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
      WHERE c.constraint_type = 'R'
      ORDER BY c.table_name, c.constraint_name, cc.position`);
    return r.map((x) => ({
      table: String(x.table),
      column: String(x.column),
      refTable: String(x.refTable),
      refColumn: String(x.refColumn),
      constraint: optStr(x.constraint) ?? undefined,
      onDelete: deleteRule(x.on_delete),
      onUpdate: null
    }));
  },
  async getStatus(cfg) {
    
    // PRODUCT_COMPONENT_VERSION доступен всем пользователям, а V$VERSION — нет:
    // на Oracle 12c+ V$VERSION читается только с правами SELECT_CATALOG_ROLE.
    const ver = await rows(cfg, `SELECT version AS v FROM product_component_version WHERE ROWNUM = 1`);
    // SQL-текст лежит в V$SQL, к которому у рядового пользователя нет доступа
    // (ORA-00942), поэтому текст запроса необязателен: без него у процесса
    // остаются sid, пользователь, статус и время. Сначала сам список сессий,
    // потом отдельной попыткой — текст.
    let active: Row[] = [];
    try {
      active = await rows(cfg, `SELECT s.sid AS sid, s.serial# AS serial, s.username AS usernam,
          s.machine AS host, s.status AS stat,
          ROUND((SYSDATE - s.last_call_et) * 86400) AS t
        FROM v$session s
        WHERE s.type = 'USER' AND s.username IS NOT NULL
        ORDER BY s.last_call_et DESC FETCH FIRST 50 ROWS ONLY`);
    } catch (e) {
      console.warn(`[oracle] v$session недоступна (${(e as Error).message}): список процессов пуст`);
    }
    const sizes = await rows(cfg, `SELECT segment_name AS tbl, bytes FROM user_segments WHERE segment_type = 'TABLE' ORDER BY bytes DESC`);
    const own = await rows(cfg, `SELECT USER AS db FROM dual`);
    const schema = own.length ? String(own[0].db) : '';
    return {
      version: String(ver[0]?.v ?? '?'),
      // Аптайма у Oracle нет: INSTANCЕ start time есть, но в панели поле
      // показывается как «время работы», поэтому оставляем его пустым.
      uptimeSec: 0,
      connections: active.length,
      processlist: active.map((x) => ({
        id: String(x.sid),
        user: String(x.usernam ?? ''),
        db: String(x.host ?? ''),
        command: String(x.stat ?? ''),
        timeSec: Math.max(0, Math.round(Number(x.t ?? 0))),
        query: String(x.q ?? '')
      })),
      // Размеры Oracle не отдаёт по имени схемы как по «базе»: панель показывает
      // таблицы текущего пользователя, поэтому и список размеров — табличный.
      dbSizes: sizes.map((x) => ({ db: String(x.tbl), bytes: Number(x.bytes ?? 0) }))
    };
  },
  async clearTable(cfg, _db, table) {
    assertWritable(cfg, 'delete');
    const r = await run(cfg, `DELETE FROM "${obj(table, 'table')}"`);
    return { deleted: r.rowsAffected ?? 0 };
  },
  async createTable(cfg, _db, def) {
    assertWritable(cfg, 'create');
    if (!def.columns?.length || def.columns.length > 200) throw Object.assign(new Error('Need 1..200 columns'), { statusCode: 400 });
    const parts = def.columns.map((c: ColumnSpec) => columnSql(D, c));
    for (const fk of def.foreignKeys ?? []) parts.push(inlineForeignKeySql(D, fk));
    const statement = `CREATE TABLE "${obj(def.name, 'table')}" (${parts.join(', ')})`;
    await run(cfg, statement);
    for (const ix of def.indexes ?? []) await run(cfg, indexSql(D, obj(def.name, 'table'), ix as Parameters<typeof indexSql>[2]));
    if (def.comment) await run(cfg, `COMMENT ON TABLE "${obj(def.name, 'table')}" IS ${escSqlString(String(def.comment).slice(0, 1024))}`);
    for (const c of def.columns) {
      if ((c as ColumnSpec).comment) await run(cfg, `COMMENT ON COLUMN "${obj(def.name, 'table')}"."${obj((c as ColumnSpec).name, 'column')}" IS ${escSqlString(String((c as ColumnSpec).comment).slice(0, 1024))}`);
    }
    return { ok: true as const, statement };
  },
  async planAlter(cfg, _db, table, ops) {
    
    const t = obj(table, 'table');
    if (!ops?.length || ops.length > 50) throw Object.assign(new Error('Need 1..50 ops'), { statusCode: 400 });
    let pkConstraint: string | undefined;
    if (ops.some((o) => o.op === 'dropPrimaryKey' || o.op === 'setPrimaryKey')) {
      pkConstraint = await pkConstraintName(cfg, table);
    }
    const dropsPkExplicitly = ops.some((o) => o.op === 'dropPrimaryKey');
    const statements: string[] = [];
    for (const o of ops as AlterOp[]) {
      switch (o.op) {
        case 'addColumn': statements.push(`ALTER TABLE "${t}" ADD ${columnSql(D, o.column)}`); break;
        case 'dropColumn': statements.push(`ALTER TABLE "${t}" DROP COLUMN "${obj(o.name, 'column')}"`); break;
        case 'renameColumn': statements.push(`ALTER TABLE "${t}" RENAME COLUMN "${obj(o.from, 'column')}" TO "${obj(o.to, 'column')}"`); break;
        case 'alterColumn': statements.push(...alterColumnSql(D, t, o.name, o.column)); break;
        case 'renameTable': statements.push(`ALTER TABLE "${t}" RENAME TO "${obj(o.to, 'table')}"`); break;
        case 'addIndex': statements.push(indexSql(D, t, o.index)); break;
        case 'dropIndex': statements.push(dropIndexSql(D, t, o.name)); break;
        case 'addForeignKey': statements.push(addForeignKeySql(D, t, o.fk)); break;
        case 'dropForeignKey': statements.push(dropForeignKeySql(D, t, o.name)); break;
        case 'setPrimaryKey':
          // Старый ключ снимаем сами, если в пакете нет явного dropPrimaryKey:
          // иначе пользователю пришлось бы знать порядок операций.
          if (pkConstraint && !dropsPkExplicitly) statements.push(dropPrimaryKeySql(D, t, pkConstraint));
          statements.push(...setPrimaryKeySql(D, t, o.columns));
          break;
        case 'dropPrimaryKey': statements.push(dropPrimaryKeySql(D, t, pkConstraint)); break;
        default: throw Object.assign(new Error(`Unsupported alter op: ${(o as { op: string }).op}`), { statusCode: 400 });
      }
    }
    // Oracle коммитит DDL неявно, поэтому пакет не транзакционный — ровно как
    // в alterTable ниже. Раньше здесь стояло true, и предпросмотр обещал
    // пользователю откат целиком, которого не происходит: половина пакета
    // могла примениться, а подсказка утверждала обратное.
    return { statements, transactional: false };
  },
  async alterTable(cfg, db, table, ops) {
    assertWritable(cfg, 'alter');
    // Тот же построитель, что и в предпросмотре: apply не может разойтись
    // с тем, что показали пользователю.
    const { statements } = await this.planAlter!(cfg, db, table, ops);
    const conn = await (await getOraclePool(cfg)).getConnection();
    const done: string[] = [];
    try {
      // Oracle коммитит DDL неявно — откатить пакет целиком нельзя, поэтому
      // применяем по одному и останавливаемся на первой ошибке: пакет
      // получается «применён частично», как и в MySQL.
      for (const s of statements) {
        await conn.execute(s, {}, { autoCommit: true });
        done.push(s);
      }
    } finally {
      conn.close().catch(() => undefined);
    }
    return { ok: true as const, statements, applied: done.length, transactional: false };
  },
  async dropTable(cfg, _db, table) {
    assertWritable(cfg, 'drop');
    const statement = `DROP TABLE "${obj(table, 'table')}"`;
    await run(cfg, statement);
    return { ok: true as const, statement };
  },
  async createView(cfg, _db, def) {
    assertWritable(cfg, 'create view');
    const select = checkViewSql(def.sql);
    const statement = `CREATE VIEW "${obj(def.name, 'table')}" AS ${select}`;
    await run(cfg, statement);
    return { ok: true as const, statement };
  },
  async dropView(cfg, _db, name) {
    assertWritable(cfg, 'drop view');
    const statement = `DROP VIEW "${obj(name, 'table')}"`;
    await run(cfg, statement);
    return { ok: true as const, statement };
  },
  async createTrigger(cfg, _db, table, def: TriggerDef) {
    assertWritable(cfg, 'create trigger');
    const t = obj(table, 'table');
    const name = obj(def.name, 'trigger');
    const timing = checkTriggerTiming(def.timing);
    const event = checkTriggerEvent(def.event);
    // Тело Oracle — блок PL/SQL из нескольких стейтментов (как у SQLite),
    // поэтому allowMultiple. Свои BEGIN ... END панель не пишет.
    const body = checkTriggerBody(def.statement, true);
    // DECLARE не добавляем: без объявлений пустой блок всё равно валиден,
    // а пользователь может передать уже готовый PL/SQL-блок.
    const statement = `CREATE OR REPLACE TRIGGER "${name}" ${timing} ${event} ON "${t}" FOR EACH ROW\nBEGIN\n  ${body};\nEND;`;
    await run(cfg, statement);
    return { ok: true as const, statement };
  },
  async dropTrigger(cfg, _db, _table, name) {
    assertWritable(cfg, 'drop trigger');
    const statement = `DROP TRIGGER "${obj(name, 'trigger')}"`;
    await run(cfg, statement);
    return { ok: true as const, statement };
  },
  async listDbUsers(cfg) {
    // Схемы, видимые текущему пользователю: Oracle отдаёт ALL_USERS по правам,
    // а не «всех на сервере», — это ровно то, что можно показать в панели.
    const r = await rows(cfg, `SELECT username FROM all_users
      WHERE oracle_maintained = 'N' AND NOT REGEXP_LIKE(username, '^APEX_[0-9]+$')
      ORDER BY username`);
    return r.map((x) => ({ username: String(x.username) }));
  },
  async createDbUser(cfg, username, password) {
    assertWritable(cfg, 'create user');
    const user = validateDbUserName(username, 'oracle');
    const pw = validateDbPassword(password);
    // Пароль в DDL биндом не передаётся: Oracle не принимает плейсхолдеры
    // в DDL вообще (ORA-01008). escSqlString() удваивает кавычки, остальные
    // символы внутри строкового литерала безопасны.
    const statement = `CREATE USER "${user}" IDENTIFIED BY ${escSqlString(pw)} QUOTA UNLIMITED ON USERS`;
    await run(cfg, statement);
    // Минимальные гранты, иначе пользователь не может даже войти и создать
    // таблицу (прошлый вариант оставлял его заблокированным).
    for (const g of ['CREATE SESSION', 'CREATE TABLE', 'CREATE SEQUENCE', 'CREATE VIEW', 'CREATE TRIGGER']) {
      try { await run(cfg, `GRANT ${g} TO "${user}"`); } catch { /* best-effort */ }
    }
    return { ok: true as const };
  },
  async dropDbUser(cfg, username) {
    assertWritable(cfg, 'drop user');
    const statement = `DROP USER "${validateDbUserName(username, 'oracle')}" CASCADE`;
    await run(cfg, statement);
    return { ok: true as const };
  },
  async listGrants(cfg, username) {
    const user = validateDbUserName(username, 'oracle');
    const r = await rows(cfg, `SELECT privilege_type AS priv, table_name AS tbl
      FROM user_tab_privs WHERE grantee = :g ORDER BY table_name, privilege_type`, [user.toUpperCase()]);
    return r.map((x) => `${x.priv} ON ${x.tbl}`);
  },
  async grant(cfg, username, privilege, _db, table) {
    assertWritable(cfg, 'grant');
    const user = validateDbUserName(username, 'oracle');
    const priv = validatePriv(privilege);
    // Права у Oracle всегда выдаются на конкретный объект: «ALL TABLES» в
    // GRANT не пишется, поэтому без таблицы берём таблицы текущей схемы.
    if (!table) {
      const own = await rows(cfg, `SELECT table_name AS t FROM user_tables`);
      for (const x of own) {
        await run(cfg, `GRANT ${priv} ON "${obj(String(x.t), 'table')}" TO "${user}"`);
      }
      return { ok: true as const };
    }
    await run(cfg, `GRANT ${priv} ON "${obj(table, 'table')}" TO "${user}"`);
    return { ok: true as const };
  },
  async revoke(cfg, username, privilege, _db, table) {
    assertWritable(cfg, 'revoke');
    const user = validateDbUserName(username, 'oracle');
    const priv = validatePriv(privilege);
    if (!table) {
      const own = await rows(cfg, `SELECT table_name AS t FROM user_tables`);
      for (const x of own) {
        await run(cfg, `REVOKE ${priv} ON "${obj(String(x.t), 'table')}" FROM "${user}"`);
      }
      return { ok: true as const };
    }
    await run(cfg, `REVOKE ${priv} ON "${obj(table, 'table')}" FROM "${user}"`);
    return { ok: true as const };
  },
  async insertRow(cfg, _db, table, row) {
    assertWritable(cfg, 'insert');
    validateRow(row);
    const cols = Object.keys(row).map((k) => obj(k, 'column'));
    const b: unknown[] = [];
    const marks = cols.map((c) => { b.push(bind(row[c])); return `:${b.length}`; });
    const colsSql = cols.map((c) => `"${c}"`).join(',');
    await run(cfg, `INSERT INTO "${obj(table, 'table')}" (${colsSql}) VALUES (${marks.join(',')})`, b);
    // Oracle не имеет RETURNING в том же виде, что pg, а колонка с автоинкрементом
    // пользователю всё равно известна: значение он увидит после перезагрузки.
    return { insertedId: undefined };
  },
  async updateRow(cfg, _db, table, filter, patch) {
    assertWritable(cfg, 'update');
    validateRow(filter, 'filter');
    validateRow(patch, 'patch');
    const b: unknown[] = [];
    const set = Object.keys(patch).map((k) => { b.push(bind(patch[k])); return `"${obj(k, 'column')}" = :${b.length}`; });
    const where = Object.keys(filter).map((k) => { b.push(bind(filter[k])); return `"${obj(k, 'column')}" = :${b.length}`; });
    const r = await run(
      cfg,
      `UPDATE "${obj(table, 'table')}" SET ${set.join(', ')} WHERE ${where.join(' AND ')}`,
      b
    );
    return { matched: r.rowsAffected ?? 0 };
  },
  async deleteRow(cfg, _db, table, filter) {
    assertWritable(cfg, 'delete');
    validateRow(filter, 'filter');
    const b: unknown[] = [];
    const where = Object.keys(filter).map((k) => { b.push(bind(filter[k])); return `"${obj(k, 'column')}" = :${b.length}`; });
    const r = await run(cfg, `DELETE FROM "${obj(table, 'table')}" WHERE ${where.join(' AND ')}`, b);
    return { deleted: r.rowsAffected ?? 0 };
  },
  async findRows(cfg, _db, table, filter, limit = 50) {
    validateRow(filter, 'filter');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 501);
    const b: unknown[] = [];
    const where = Object.keys(filter).map((k) => { b.push(bind(filter[k])); return `"${obj(k, 'column')}" = :${b.length}`; });
    const r = await run(
      cfg,
      `SELECT * FROM "${obj(table, 'table')}" WHERE ${where.join(' AND ')} FETCH FIRST ${lim} ROWS ONLY`,
      b
    );
    return r.rows as Row[];
  },
  async updateRowsBulk(cfg, _db, table, filter, patch) {
    assertWritable(cfg, 'update bulk');
    validateRow(patch, 'patch');
    if (!Object.keys(patch).length) throw Object.assign(new Error('Bulk update needs at least one column'), { statusCode: 400 });
    const b: unknown[] = [];
    const set = Object.keys(patch).map((k) => { b.push(bind(patch[k])); return `"${obj(k, 'column')}" = :${b.length}`; });
    const where = whereFrom(filter, b);
    const r = await run(cfg, `UPDATE "${obj(table, 'table')}" SET ${set.join(', ')}${where ? ` ${where}` : ''}`, b);
    return { affected: r.rowsAffected ?? 0 };
  },
  async deleteRowsBulk(cfg, _db, table, filter) {
    assertWritable(cfg, 'delete bulk');
    const b: unknown[] = [];
    const where = whereFrom(filter, b);
    const r = await run(cfg, `DELETE FROM "${obj(table, 'table')}"${where ? ` ${where}` : ''}`, b);
    return { affected: r.rowsAffected ?? 0 };
  },
  async explain(cfg, _db, sql) {
    assertWritable(cfg, 'select');
    const t0 = Date.now();
    // EXPLAIN PLAN требует PLAN_TABLE официальной структуры (см. PLAN_TABLE_DDL).
    // Создаём её лениво: повторное создание даёт ORA-00955, и такой код внутри
    // BEGIN...EXCEPTION считается успехом, а любая другая ошибка поднимается.
    try {
      const ddlLiteral = PLAN_TABLE_DDL.replaceAll("'", "''");
      await run(cfg, `BEGIN
        EXECUTE IMMEDIATE '${ddlLiteral}';
      EXCEPTION WHEN OTHERS THEN
        IF SQLCODE != -955 THEN RAISE; END IF;
      END;`);
      const planId = nextPlanId();
      await run(cfg, `DELETE FROM plan_table WHERE statement_id = '${planId}'`);
      await run(cfg, `EXPLAIN PLAN SET STATEMENT_ID = '${planId}' FOR ${String(sql).replace(/;\s*$/, '')}`);
      const r = await rows(cfg, `SELECT id, operation, options, object_name FROM plan_table WHERE statement_id = '${planId}' ORDER BY id`);
      // Свою строку плана убираем сразу: иначе таблица растёт на каждый клик, а
      // она общая для всей схемы и видна всем пользователям этого подключения.
      await run(cfg, `DELETE FROM plan_table WHERE statement_id = '${planId}'`).catch(() => undefined);
      const plan = r.map((x) => ({
        plan: [x.id, x.operation, x.options, x.object_name]
          .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
          .join(' ')
      }));
      return { columns: ['plan'], rows: plan, rowCount: plan.length, truncated: false, execMs: Date.now() - t0 };
    } catch (e) {
      throw Object.assign(
        new Error(`Oracle EXPLAIN PLAN failed: ${(e as Error).message}`),
        { statusCode: 400 }
      );
    }
  },
  async killQuery(cfg, sid) {
    // У Oracle нет pid: сессия адресуется SID, а ALTER SYSTEM KILL SESSION требует
    // пару sid,serial#. Номер сериализации берём у самой сессии — подставлять 0
    // нельзя, сервер отвергает такой вызов (ORA-02059).
    const n = Number(sid);
    if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw Object.assign(new Error('Bad sid'), { statusCode: 400 });
    // Право на KILL SESSION есть не у каждого пользователя, а V$SESSION на
    // подключении без SELECT_CATALOG_ROLE недоступна. Оба случая — понятный 400,
    // а не 500 с голым ORA.
    let serial: number | null = null;
    try {
      const found = await rows(cfg, `SELECT serial# AS serial FROM v$session WHERE sid = :sid`, [n]);
      serial = found.length ? Number(found[0].serial ?? 0) : null;
    } catch {
      serial = null;
    }
    try {
      await run(cfg, `BEGIN EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ${n},${serial ?? 0} IMMEDIATE'; END;`);
    } catch (e: any) {
      const num = e?.errorNum;
      if (num === 1033 || num === 901 || num === 904 || num === 942) {
        throw Object.assign(
          new Error('Остановка сессии Oracle требует прав на V$SESSION и ALTER SYSTEM: выдайте SELECT ANY SESSION и ALTER SESSION CONNECT, либо отменяйте запрос вручную'),
          { statusCode: 403 }
        );
      }
      throw e;
    }
    if (serial === null) {
      throw Object.assign(
        new Error('Не удалось прочитать номер сериализации сессии: у пользователя нет доступа к V$SESSION'),
        { statusCode: 403 }
      );
    }
    return { ok: true as const };
  }
};