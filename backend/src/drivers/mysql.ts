import mysql from 'mysql2/promise';
import mysqlCb from 'mysql2';
import type { ConnectionConfig, DbDriver, QueryLimits, Relation, SchemaForeignKey, SchemaIndex, TablePage, TableSchema, TabularResult } from '../core/types.js';
import { assertWritable } from '../core/types.js';
import { addForeignKeySql, alterColumnSql, buildWhere, capSelect, checkTriggerBody, checkTriggerEvent, checkTriggerTiming, checkViewSql, columnSql, countStatements, dbIdent, dropForeignKeySql, dropIndexSql, dropPrimaryKeySql, escSqlString, filterValue, ident, indexSql, inlineForeignKeySql, likePattern, setPrimaryKeySql, splitStatements, validateDbHost, validateDbPassword, validateDbUserName, validatePid, validatePriv, validateRow, withTimeout } from './helpers.js';
import { getMysqlPool } from '../core/pool.js';

function trunc(rows: Record<string, unknown>[], max: number) {
  return { slice: rows.slice(0, max), truncated: rows.length > max };
}

function pool(cfg: ConnectionConfig) {
  return getMysqlPool(cfg);
}

// Пул без default-БД для запросов с явным указанием БД (SHOW TABLES FROM db,
// `db`.`table`, ...): работает даже если default-БД подключения удалена
function poolNoDb(cfg: ConnectionConfig) {
  return getMysqlPool({ ...cfg, database: undefined });
}

type Row = Record<string, unknown>;

/**
 * COLUMN_DEFAULT: у MySQL это NULL, у MariaDB — строка 'NULL' для nullable
 * колонок без значения по умолчанию. Приводим оба случая к null, иначе в UI
 * и в SQL-дампе появляется фиктивное `DEFAULT 'NULL'`.
 */
function normalizeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === '' || text.trim().toUpperCase() === 'NULL' ? null : text;
}

/** Строки индексов приходят по одной на колонку — собираем в SchemaIndex. */
function groupIndexes(rows: Row[]): SchemaIndex[] {
  const byName = new Map<string, SchemaIndex>();
  for (const r of rows) {
    const name = String(r.name);
    let idx = byName.get(name);
    if (!idx) {
      idx = { name, unique: Number(r.non_unique) === 0, primary: name === 'PRIMARY', type: (r.index_type as string) || null, columns: [], where: null, definition: null };
      byName.set(name, idx);
    }
    // Функциональные индексы (MySQL 8) отдают COLUMN_NAME = NULL
    if (r.column_name !== null && r.column_name !== undefined) idx.columns.push(String(r.column_name));
  }
  return [...byName.values()];
}

/** Строки FK приходят по одной на колонку — собираем в SchemaForeignKey. */
function groupForeignKeys(rows: Row[]): SchemaForeignKey[] {
  const byName = new Map<string, SchemaForeignKey>();
  for (const r of rows) {
    const name = String(r.name);
    let fk = byName.get(name);
    if (!fk) {
      fk = { name, columns: [], refTable: String(r.ref_table), refColumns: [], onDelete: (r.on_delete as string) || null, onUpdate: (r.on_update as string) || null };
      byName.set(name, fk);
    }
    fk.columns.push(String(r.column_name));
    if (r.ref_column !== null && r.ref_column !== undefined) fk.refColumns.push(String(r.ref_column));
  }
  return [...byName.values()];
}

function make(kind: 'mysql' | 'mariadb', defaultPort: number): DbDriver {
  return {
    kind,
    async test(cfg) {
      const t0 = Date.now();
      // Без выбора БД: проверка соединения не зависит от существования default-БД
      const c = await mysql.createConnection({
        host: cfg.host ?? 'localhost', port: cfg.port ?? defaultPort,
        user: cfg.user, password: cfg.password
      });
      try {
        await c.query('SELECT 1');
        return { ok: true, latencyMs: Date.now() - t0 };
      } finally {
        await c.end();
      }
    },
    async listDatabases(cfg) {
      // Без выбора БД: работает даже если default-БД подключения удалена
      const c = await mysql.createConnection({
        host: cfg.host ?? 'localhost', port: cfg.port ?? defaultPort,
        user: cfg.user, password: cfg.password
      });
      try {
        const [rows] = await c.query('SHOW DATABASES');
        // mysql — движковая БД с грантами: неудаляема, поэтому скрыта из списка
        return (rows as { Database: string }[]).map((r) => r.Database).filter((d) => !['information_schema', 'performance_schema', 'sys', 'mysql'].includes(d));
      } finally {
        await c.end();
      }
    },
    async listTables(cfg, db) {
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const d = dbIdent(db);
      const [rows] = await p.query(`SHOW TABLES FROM \`${d}\``);
      return (rows as Record<string, string>[]).map((r) => Object.values(r)[0]);
    },
    async getSchema(cfg, db, table): Promise<TableSchema> {
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      // information_schema вместо SHOW: одинаково для mysql и mariadb, отдаёт
      // позиции, комментарии, PRIMARY/UNIQUE-колонки и тип целиком.
      const [[metaRows], [colRows], [idxRows], [fkRows], [trgRows]] = await Promise.all([
        p.query(`SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [d, t]),
        p.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS def,
                        EXTRA AS extra, ORDINAL_POSITION AS pos, COLUMN_COMMENT AS comment, COLUMN_KEY AS colkey
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [d, t]),
        p.query(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name,
                        INDEX_TYPE AS index_type, INDEX_COMMENT AS comment
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [d, t]),
        p.query(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS ref_table,
                        k.REFERENCED_COLUMN_NAME AS ref_column, r.DELETE_RULE AS on_delete, r.UPDATE_RULE AS on_update,
                        k.ORDINAL_POSITION AS pos
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                  AND r.TABLE_NAME = k.TABLE_NAME
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [d, t]),
        p.query(`SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
                        ACTION_STATEMENT AS statement
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
                 ORDER BY TRIGGER_NAME`, [d, t])
      ]);
      const metaRow = ((metaRows as unknown as Row[])[0] ?? {}) as Row;
      return {
        table,
        kind: String(metaRow.type ?? 'BASE TABLE').toUpperCase().includes('VIEW') ? 'view' : 'table',
        comment: (metaRow.comment as string) || null,
        extra: { engine: (metaRow.engine as string) || null, collation: (metaRow.collation as string) || null },
        columns: (colRows as unknown as Row[]).map((r) => ({
          name: String(r.name),
          type: String(r.type),
          nullable: String(r.is_nullable).toUpperCase() === 'YES',
          primary: r.colkey === 'PRI',
          autoInc: /auto_increment/i.test(String(r.extra ?? '')),
          // MariaDB отдаёт COLUMN_DEFAULT = 'NULL' строкой, где у MySQL настоящий NULL
          default: normalizeDefault(r.def),
          ordinal: Number(r.pos),
          comment: (r.comment as string) || null,
          extra: (r.extra as string) || null
        })),
        indexes: groupIndexes(idxRows as unknown as Row[]),
        foreignKeys: groupForeignKeys(fkRows as unknown as Row[]),
        triggers: (trgRows as unknown as Row[]).map((r) => ({
          name: String(r.name),
          timing: (r.timing as string) || null,
          event: (r.event as string) || null,
          statement: String(r.statement ?? '')
        }))
      };
    },
    async getPage(cfg, db, table, page, pageSize, sort, filter): Promise<TablePage> {
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const d = dbIdent(db);
      const t = ident(table, 'table');
      const pg = Math.max(1, page || 1);
      const ps = Math.min(500, Math.max(1, pageSize || 50));
      let order = '';
      if (sort) {
        const [col, dir] = sort.split(':');
        order = `ORDER BY \`${ident(col, 'column')}\` ${dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
      }
      // Условия читаются и массовой правкой через одну buildWhere(), иначе
      // предпросмотр мог бы показать одно число строк, а UPDATE затронул бы другое
      const { clause: where, params } = buildWhere(filter, (c) => `\`${c}\``, { placeholder: () => '?', like: 'plain' });
      const [rows] = await p.query(`SELECT * FROM \`${d}\`.\`${t}\` ${where} ${order} LIMIT ? OFFSET ?`, [...params, ps + 1, (pg - 1) * ps]);      const arr = (rows as Record<string, unknown>[]);
      const truncated = arr.length > ps;
      const slice = arr.slice(0, ps);
      return { columns: Object.keys(slice[0] ?? {}), rows: slice, page: pg, pageSize: ps, truncated };
    },
    async query(cfg, sql, limits: QueryLimits): Promise<TabularResult> {
      assertWritable(cfg, sql);
      const t0 = Date.now();
      // Ad-hoc SQL выполняется в default-БД подключения (квалифицируйте именем при нужде)
      const port = cfg.port ?? defaultPort;
      // Пул без multipleStatements: скрипт из N стейтментов выполняем по одному,
      // возвращаем результат последнего (как в psql-клиентах)
      const statements = splitStatements(sql);
      const runAll = async (p: mysql.Pool): Promise<TabularResult> => {
        let last: TabularResult = { columns: [], rows: [], rowCount: 0, truncated: false, execMs: 0 };
        for (const stmt of statements.length ? statements : [sql]) {
          const capped = capSelect(stmt, limits.maxRows);
          const [rows] = await withTimeout(Promise.resolve(p.query(capped) as Promise<[unknown, unknown]>), limits.timeoutMs) as unknown as [unknown, unknown];
          const arr = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
          const { slice, truncated } = trunc(arr, limits.maxRows);
          last = { columns: Object.keys(slice[0] ?? {}), rows: slice, rowCount: slice.length, truncated, execMs: Date.now() - t0 };
        }
        return last;
      };
      try {
        return await runAll(pool({ ...cfg, port }));
      } catch (e: any) {
        // default-БД подключения удалена — повторяем без неё:
        // квалифицированные запросы (db.table) всё равно выполнятся
        if (cfg.database && e?.code === 'ER_BAD_DB_ERROR') {
          return await runAll(poolNoDb({ ...cfg, port }));
        }
        throw e;
      }
    },
    async execScript(cfg, db, script) {
      assertWritable(cfg, script);
      if (script.length > 5_000_000) throw Object.assign(new Error('Script too large (5MB)'), { statusCode: 413 });
      const t0 = Date.now();
      const c = await mysql.createConnection({
        host: cfg.host ?? 'localhost', port: cfg.port ?? defaultPort,
        user: cfg.user, password: cfg.password, database: db || cfg.database, multipleStatements: true
      });
      try {
        await withTimeout(c.query(script), 120_000);
        return { statements: countStatements(script), execMs: Date.now() - t0 };
      } finally {
        await c.end();
      }
    },
    async importRows(cfg, db, table, rows) {
      assertWritable(cfg, 'insert');
      if (!rows.length) return { inserted: 0, execMs: 0 };
      if (rows.length > 50_000) throw Object.assign(new Error('Too many rows (50k)'), { statusCode: 413 });
      const t0 = Date.now();
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((x) => ident(x, 'column'));
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const vals = chunk.map((r) => cols.map((x) => r[x] ?? null));
        await p.query(`INSERT INTO \`${d}\`.\`${t}\` (${cols.map((x) => `\`${x}\``).join(',')}) VALUES ?`, [vals]);
      }
      return { inserted: rows.length, execMs: Date.now() - t0 };
    },
    async *streamRows(cfg, db, table, batchSize = 1000) {
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const c = mysqlCb.createConnection({
        host: cfg.host ?? 'localhost', port: cfg.port ?? defaultPort,
        user: cfg.user, password: cfg.password, database: db || cfg.database
      });
      try {
        const stream = c.query(`SELECT * FROM \`${d}\`.\`${t}\``).stream({ highWaterMark: Math.min(batchSize, 5000) });
        let batch: Record<string, unknown>[] = [];
        for await (const row of stream) {
          batch.push({ ...(row as Record<string, unknown>) });
          if (batch.length >= batchSize) { yield batch; batch = []; }
        }
        if (batch.length) yield batch;
      } finally {
        c.destroy();
      }
    },
    async getRelations(cfg, db): Promise<Relation[]> {
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const [rows] = await p.query(
        `SELECT k.TABLE_NAME AS \`table\`, k.COLUMN_NAME AS \`column\`, k.REFERENCED_TABLE_NAME AS refTable,
                k.REFERENCED_COLUMN_NAME AS refColumn, k.CONSTRAINT_NAME AS \`constraint\`,
                r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [db || cfg.database]
      );
      return (rows as Relation[]).map((r) => ({
        table: String(r.table), column: String(r.column), refTable: String(r.refTable), refColumn: String(r.refColumn),
        constraint: r.constraint === null || r.constraint === undefined ? undefined : String(r.constraint),
        onDelete: (r.onDelete as string) || null,
        onUpdate: (r.onUpdate as string) || null
      }));
    },
    async getStatus(cfg) {
      // Без выбора БД: статус сервера не зависит от существования default-БД
      const c = await mysql.createConnection({
        host: cfg.host ?? 'localhost', port: cfg.port ?? defaultPort,
        user: cfg.user, password: cfg.password
      });
      try {
        const [ver] = await c.query(`SELECT VERSION() AS v`);
        const [st] = await c.query(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Queries','Slow_queries')`);
        const stat: Record<string, number> = {};
        for (const r of st as { Variable_name: string; Value: string }[]) stat[r.Variable_name] = Number(r.Value);
        const [proc] = await c.query(`SHOW FULL PROCESSLIST`);
        const [sizes] = await c.query(
          `SELECT table_schema AS db, SUM(data_length + index_length) AS bytes, COUNT(*) AS tables
           FROM information_schema.TABLES GROUP BY table_schema ORDER BY bytes DESC LIMIT 50`
        );
        return {
          version: (ver as { v: string }[])[0]?.v ?? '?',
          uptimeSec: stat.Uptime, connections: stat.Threads_connected, queries: stat.Queries, slowQueries: stat.Slow_queries,
          processlist: (proc as Record<string, unknown>[]).slice(0, 50).map((x) => ({
            id: String(x.Id), user: String(x.User ?? ''), db: String(x.db ?? ''), command: String(x.Command ?? ''),
            timeSec: Number(x.Time ?? 0), state: String(x.State ?? ''), query: String(x.Info ?? '').slice(0, 300)
          })),
          dbSizes: (sizes as { db: string; bytes: string; tables: string }[]).map((s) => ({ db: s.db, bytes: Number(s.bytes ?? 0), tables: Number(s.tables ?? 0) }))
        };
      } finally {
        await c.end();
      }
    },
    async clearTable(cfg, db, table) {
      assertWritable(cfg, 'delete');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const [r] = await p.query(`DELETE FROM \`${d}\`.\`${t}\``);
      return { deleted: Number((r as { affectedRows?: number }).affectedRows ?? 0) };
    },
    async createTable(cfg, db, def) {
      assertWritable(cfg, 'create');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(def.name, 'table');
      if (!def.columns?.length || def.columns.length > 200) throw Object.assign(new Error('Need 1..200 columns'), { statusCode: 400 });
      const parts = def.columns.map((c) => columnSql('mysql', c));
      for (const fk of def.foreignKeys ?? []) parts.push(inlineForeignKeySql('mysql', fk));
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      // ENGINE/CHARSET — только из белого списка, иначе это инъекция в DDL.
      const engine = def.engine ? String(def.engine).toUpperCase().replace(/[^A-Z0-9_]/g, '') : '';
      const charset = def.charset ? String(def.charset).toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
      const collate = def.collate ? String(def.collate).toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
      const tableOpts = [
        engine && ['INNODB', 'MYISAM', 'MEMORY'].includes(engine) ? ` ENGINE=${engine}` : '',
        charset ? ` DEFAULT CHARSET=${charset}` : '',
        collate ? ` COLLATE=${collate}` : '',
        def.comment ? ` COMMENT=${escSqlString(String(def.comment).slice(0, 1024))}` : '',
      ].join('');
      const statement = `CREATE TABLE \`${d}\`.\`${t}\` (${parts.join(', ')})${tableOpts}`;
      await p.query(statement);
      const applied: string[] = [statement];
      for (const ix of def.indexes ?? []) {
        const s = indexSql('mysql', t, ix as Parameters<typeof indexSql>[2]);
        // Индексы MySQL принадлежат таблице, но синтаксис CREATE INDEX без БД
        // создаёт в default-БД пула без БД — выполняем в контексте базы.
        const c = await getMysqlPool({ ...cfg, port: cfg.port ?? defaultPort, database: d }).getConnection();
        try { await c.query(s); } finally { c.release(); }
        applied.push(s);
      }
      return { ok: true as const, statement: applied.join(';\n') };
    },
    async planAlter(_cfg, db, table, ops) {
      const d = dbIdent(db || _cfg.database || '');
      const t = ident(table, 'table');
      if (!ops?.length || ops.length > 50) throw Object.assign(new Error('Need 1..50 ops'), { statusCode: 400 });
      const qualified = `\`${d}\`.\`${t}\``;
      // RENAME COLUMN понимают только MySQL 8.0+ и MariaDB 10.5.2+: на старых
      // серверах это синтаксическая ошибка от сервера, а не внятный 400 —
      // проверяем версию заранее, как SQLite проверяет 3.25 для RENAME TABLE.
      if (ops.some((o) => o.op === 'renameColumn')) {
        const p = poolNoDb({ ..._cfg, port: _cfg.port ?? defaultPort });
        const [verRows] = await p.query('SELECT VERSION() AS v');
        const ver = String((verRows as { v?: unknown }[])[0]?.v ?? '');
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(ver);
        const nums = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
        // MySQL 8.0+, MariaDB 10.5.2+ (и новее, включая 11.x).
        const ok = kind === 'mysql'
          ? nums[0] >= 8
          : nums[0] > 10 || (nums[0] === 10 && (nums[1] > 5 || (nums[1] === 5 && nums[2] >= 2)));
        if (!ok) {
          throw Object.assign(new Error(`Renaming a column requires MySQL 8.0+ / MariaDB 10.5.2+ (server reports ${ver || 'unknown version'})`), { statusCode: 400 });
        }
      }
      // setPrimaryKey на таблице, где ключ уже есть, раньше падал с 500
      // «Multiple primary key defined» — пользователю приходилось знать, что
      // сначала надо снять старый ключ отдельной операцией. Снимаем его сами,
      // если в пакете нет явного dropPrimaryKey.
      let hasPrimaryKey = false;
      const wantsSetPk = ops.some((o) => o.op === 'setPrimaryKey');
      const wantsDropPk = ops.some((o) => o.op === 'dropPrimaryKey');
      if (wantsSetPk && !wantsDropPk) {
        const p = poolNoDb({ ..._cfg, port: _cfg.port ?? defaultPort });
        const [pkRows] = await p.query(
          `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'`,
          [d, t]
        );
        hasPrimaryKey = Array.isArray(pkRows) && pkRows.length > 0;
      }
      const statements: string[] = [];
      for (const o of ops) {
        switch (o.op) {
          case 'addColumn': statements.push(`ALTER TABLE ${qualified} ADD COLUMN ${columnSql('mysql', o.column)}`); break;
          case 'dropColumn': statements.push(`ALTER TABLE ${qualified} DROP COLUMN \`${ident(o.name, 'column')}\``); break;
          case 'renameColumn': statements.push(`ALTER TABLE ${qualified} RENAME COLUMN \`${ident(o.from, 'column')}\` TO \`${ident(o.to, 'column')}\``); break;
          case 'alterColumn': statements.push(...alterColumnSql('mysql', t, o.name, o.column)); break;
          case 'renameTable': statements.push(`ALTER TABLE ${qualified} RENAME TO \`${ident(o.to, 'table')}\``); break;
          case 'addIndex': statements.push(indexSql('mysql', t, o.index)); break;
          case 'dropIndex': statements.push(dropIndexSql('mysql', t, o.name)); break;
          case 'addForeignKey': statements.push(addForeignKeySql('mysql', t, o.fk)); break;
          case 'dropForeignKey': statements.push(dropForeignKeySql('mysql', t, o.name)); break;
          case 'setPrimaryKey':
            if (hasPrimaryKey) statements.push(dropPrimaryKeySql('mysql', t));
            statements.push(...setPrimaryKeySql('mysql', t, o.columns));
            break;
          case 'dropPrimaryKey': statements.push(dropPrimaryKeySql('mysql', t)); break;
          default: throw Object.assign(new Error(`Unsupported alter op: ${(o as { op: string }).op}`), { statusCode: 400 });
        }
      }
      return { statements, transactional: false };
    },
    async alterTable(cfg, db, table, ops) {
      assertWritable(cfg, 'alter');
      // Тот же построитель, что и в предпросмотре: apply не может разойтись
      // с тем, что показали пользователю.
      const { statements, transactional } = await this.planAlter!(cfg, db, table, ops);
      // MySQL коммитит DDL неявно: настоящей транзакции нет. Поэтому операции
      // идут по одной выделенной сессии и останавливаются на первой ошибке —
      // applied в ответе покажет, сколько уже применено.
      // Соединение с выбранной БД: операции над индексами/FK не принимают
      // квалификатор базы, а пул без default-БД её не выбирает.
      const d = dbIdent(db || cfg.database || '');
      const c = await getMysqlPool({ ...cfg, port: cfg.port ?? defaultPort, database: d }).getConnection();
      let applied = 0;
      try {
        for (const s of statements) {
          await c.query(s);
          applied++;
        }
      } catch (e: any) {
        // DDL уже применён неоткатываемо — сообщаем, сколько операций прошло,
        // чтобы маршрут вернул 409 с честным «применено частично».
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { partial: applied > 0, applied });
      } finally {
        c.release();
      }
      return { ok: true as const, statements, applied, transactional };
    },
    async dropTable(cfg, db, table) {
      assertWritable(cfg, 'drop');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const statement = `DROP TABLE \`${d}\`.\`${t}\``;
      await p.query(statement);
      return { ok: true as const, statement };
    },
    async createView(cfg, db, def) {
      assertWritable(cfg, 'create view');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(def.name, 'table');
      const select = checkViewSql(def.sql);
      // Пул С выбранной БД: имя представления квалифицировано (`db`.`t`), а
      // таблицы внутри пользовательского SELECT — нет, и на пуле без default-БД
      // сервер отвечает ER_NO_DB_ERROR (как уже делает alterTable).
      const c = await getMysqlPool({ ...cfg, port: cfg.port ?? defaultPort, database: d }).getConnection();
      try {
        const statement = `CREATE VIEW \`${d}\`.\`${t}\` AS ${select}`;
        await c.query(statement);
        return { ok: true as const, statement };
      } finally {
        c.release();
      }
    },
    async dropView(cfg, db, name) {
      assertWritable(cfg, 'drop view');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(name, 'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const statement = `DROP VIEW \`${d}\`.\`${t}\``;
      await p.query(statement);
      return { ok: true as const, statement };
    },
    async createTrigger(cfg, db, table, def) {
      assertWritable(cfg, 'create trigger');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const n = ident(def.name, 'index');
      // MySQL не знает INSTEAD OF (это диалект представлений) — отсекаем
      // на входе, чтобы не отправлять заведомо невалидный DDL
      const timing = checkTriggerTiming(def.timing);
      if (timing === 'INSTEAD OF') throw Object.assign(new Error('MySQL triggers support only BEFORE / AFTER'), { statusCode: 400 });
      const event = checkTriggerEvent(def.event);
      // FOR EACH ROW принимает ровно один стейтмент, поэтому тело не оборачиваем
      const body = checkTriggerBody(def.statement, false);
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const statement = `CREATE TRIGGER \`${d}\`.\`${n}\` ${timing} ${event} ON \`${d}\`.\`${t}\` FOR EACH ROW ${body}`;
      await p.query(statement);
      return { ok: true as const, statement };
    },
    async dropTrigger(cfg, db, table, name) {
      assertWritable(cfg, 'drop trigger');
      const d = dbIdent(db || cfg.database || '');
      // MySQL триггер принадлежит таблице, но DROP TRIGGER принимает только
      // имя — таблицу квалифицировать нельзя, она лишь для проверки прав
      void ident(table, 'table');
      const n = ident(name, 'index');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const statement = `DROP TRIGGER IF EXISTS \`${d}\`.\`${n}\``;
      await p.query(statement);
      return { ok: true as const, statement };
    },
    async listDbUsers(cfg) {
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const [rows] = await p.query(`SELECT User AS username, Host AS host FROM mysql.user ORDER BY User`);
      return (rows as { username: string; host: string }[]).map((r) => ({ username: r.username, host: r.host }));
    },
    async createDbUser(cfg, username, password, _db, host) {
      assertWritable(cfg, 'create user');
      const u = validateDbUserName(username, 'mysql');
      const pw = validateDbPassword(password);
      const h = validateDbHost(host);
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      await p.query(`CREATE USER ${escSqlString(u)}@${escSqlString(h)} IDENTIFIED BY ${escSqlString(pw)}`);
      return { ok: true as const };
    },
    async dropDbUser(cfg, username, _db, host) {
      assertWritable(cfg, 'drop user');
      const u = validateDbUserName(username, 'mysql');
      const h = validateDbHost(host);
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      await p.query(`DROP USER ${escSqlString(u)}@${escSqlString(h)}`);
      return { ok: true as const };
    },
    async listGrants(cfg, username, _db, host) {
      const u = validateDbUserName(username, 'mysql');
      const h = validateDbHost(host);
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const [rows] = await p.query(`SHOW GRANTS FOR ${escSqlString(u)}@${escSqlString(h)}`);
      return (rows as Record<string,string>[]).map(r=>Object.values(r)[0]);
    },
    async grant(cfg, username, privilege, db, table, host) {
      assertWritable(cfg, 'grant');
      const u = validateDbUserName(username, 'mysql');
      const h = validateDbHost(host);
      const priv = validatePriv(privilege);
      const d = db ? dbIdent(db) : '*';
      const t = table ? ident(table,'table') : '*';
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const target = d==='*' && t==='*' ? `*.*` : t==='*' ? `\`${d}\`.*` : `\`${d}\`.\`${t}\``;
      await p.query(`GRANT ${priv} ON ${target} TO ${escSqlString(u)}@${escSqlString(h)}`);
      return { ok: true as const };
    },
    async revoke(cfg, username, privilege, db, table, host) {
      assertWritable(cfg, 'revoke');
      const u = validateDbUserName(username, 'mysql');
      const h = validateDbHost(host);
      const priv = validatePriv(privilege);
      const d = db ? dbIdent(db) : '*';
      const t = table ? ident(table,'table') : '*';
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const target = d==='*' && t==='*' ? `*.*` : t==='*' ? `\`${d}\`.*` : `\`${d}\`.\`${t}\``;
      await p.query(`REVOKE ${priv} ON ${target} FROM ${escSqlString(u)}@${escSqlString(h)}`);
      return { ok: true as const };
    },
    async insertRow(cfg, db, table, row) {
      assertWritable(cfg, 'insert');
      validateRow(row);
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table,'table');
      const cols = Object.keys(row).map(k=>ident(k,'column'));
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const [r] = await p.query(`INSERT INTO \`${d}\`.\`${t}\` (${cols.map(c=>`\`${c}\``).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`, cols.map(k=>row[k]));
      return { insertedId: (r as any).insertId };
    },
    async updateRow(cfg, db, table, filter, patch) {
      assertWritable(cfg, 'update');
      validateRow(filter,'filter'); validateRow(patch,'patch');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table,'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const set = Object.keys(patch).map(k=>`\`${ident(k,'column')}\`=?`).join(', ');
      const where = Object.keys(filter).map(k=>`\`${ident(k,'column')}\`=?`).join(' AND ');
      const [r] = await p.query(`UPDATE \`${d}\`.\`${t}\` SET ${set} WHERE ${where}`, [...Object.values(patch), ...Object.values(filter)]);
      return { matched: Number((r as any).affectedRows ?? 0) };
    },
    async updateRowsBulk(cfg, db, table, filter, patch) {
      assertWritable(cfg, 'update bulk');
      validateRow(patch,'patch');
      if (!Object.keys(patch).length) throw Object.assign(new Error('Bulk update needs at least one column'), { statusCode: 400 });
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table,'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const set = Object.keys(patch).map(k=>`\`${ident(k,'column')}\`=?`).join(', ');
      const { clause, params } = buildWhere(filter, (c) => `\`${c}\``, { placeholder: () => '?', like: 'plain' });
      // Фильтр обязателен: без него это «обновить всю таблицу», а панель
      // специально запрещает такой вызов — пустой фильтр проходит только с
      // allowAll, и тогда условие действительно пустое намеренно
      const [r] = await p.query(`UPDATE \`${d}\`.\`${t}\` SET ${set} ${clause}`, [...Object.values(patch), ...params]);
      return { affected: Number((r as any).affectedRows ?? 0) };
    },
    async deleteRowsBulk(cfg, db, table, filter) {
      assertWritable(cfg, 'delete bulk');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table,'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const { clause, params } = buildWhere(filter, (c) => `\`${c}\``, { placeholder: () => '?', like: 'plain' });
      const [r] = await p.query(`DELETE FROM \`${d}\`.\`${t}\` ${clause}`, params);
      return { affected: Number((r as any).affectedRows ?? 0) };
    },
    async deleteRow(cfg, db, table, filter) {
      assertWritable(cfg, 'delete');
      validateRow(filter,'filter');
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table,'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const where = Object.keys(filter).map(k=>`\`${ident(k,'column')}\`=?`).join(' AND ');
      const [r] = await p.query(`DELETE FROM \`${d}\`.\`${t}\` WHERE ${where}`, Object.values(filter));
      return { deleted: Number((r as any).affectedRows ?? 0) };
    },
    // Точное чтение по фильтру-объекту: нужно для отката изменений данных.
    async findRows(cfg, db, table, filter, limit = 50) {
      validateRow(filter, 'filter');
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 501);
      const d = dbIdent(db || cfg.database || '');
      const t = ident(table, 'table');
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      const where = Object.keys(filter).map(k=>`\`${ident(k,'column')}\`=?`).join(' AND ');
      const [r] = await p.query(`SELECT * FROM \`${d}\`.\`${t}\` WHERE ${where} LIMIT ${lim}`, Object.values(filter));
      return r as Record<string, unknown>[];
    },
    async explain(cfg, db, sql, opts) {
      // EXPLAIN не меняет данные, поэтому assertWritable проверяет только
      // read-only подключение, а не характер запроса (это делает маршрут).
      assertWritable(cfg, 'select');
      const t0 = Date.now();
      // БД выбирается подключением, а не префиксом в тексте запроса:
      // в MySQL допустимо только `EXPLAIN <select>`, `db`.SELECT не разбирается.
      // Здесь нужен пул С базой (poolNoDb по определению её не подключает).
      const p = getMysqlPool({ ...cfg, port: cfg.port ?? defaultPort, database: db || cfg.database });
      const [rows] = await p.query(`EXPLAIN ${sql}`);
      const arr = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
      return { columns: Object.keys(arr[0] ?? {}), rows: arr, rowCount: arr.length, truncated: false, execMs: Date.now() - t0 };
    },
    async killQuery(cfg, pid) {
      const n = validatePid(pid);
      const p = poolNoDb({ ...cfg, port: cfg.port ?? defaultPort });
      await p.query(`KILL ${n}`);
      return { ok: true as const };
    }
  };
}

export const mysqlDriver = make('mysql', 3306);
// Официальный порт MariaDB — такой же 3306, как у MySQL (3307 — нестандартный
// локальный конвент, его всё равно нужно указывать явно в настройках подключения)
export const mariadbDriver = make('mariadb', 3306);
