import { Readable } from 'node:stream';
import { csvLine, insertStatement, quoteIdent, sqlLiteral, type SqlDialect } from '../drivers/helpers.js';
import type { ConnectionConfig, DbDriver, TableSchema } from './types.js';

export function dialectOf(cc: ConnectionConfig): SqlDialect {
  return cc.kind === 'postgres' ? 'pg' : cc.kind === 'sqlite' ? 'sqlite' : cc.kind === 'oracle' ? 'oracle' : 'mysql';
}

/**
 * Может ли движок отдавать дамп, который затем можно восстановить.
 *
 * Формат выбирается по типу движка, но восстановление идёт через `execScript`,
 * которого нет ни у MongoDB, ни у Redis. Для MongoDB это решено форматом json;
 * для Redis решения нет: дамп получился бы SQL-таблицей из псевдоколонок
 * key/type/ttl/len (redis.ts:101-106), который ничем не восстановить — да и
 * сам execScript у Redis отсутствует. Поэтому копию для Redis не создаём вовсе:
 * раньше панель радостно показывала успешно созданный бэкап, который был
 * бесполезен от момента создания.
 */
export function assertDumpRestorable(kind: string): void {
  if (kind === 'redis') {
    throw Object.assign(
      new Error('Redis backups are not supported: keys are of mixed types and cannot be restored from a dump'),
      { statusCode: 400 }
    );
  }
}

/** Источник батчей: streamRows драйвера, иначе фолбэк пагинацией getPage. */
export async function* batches(d: DbDriver, cc: ConnectionConfig, db: string, table: string): AsyncGenerator<Record<string, unknown>[]> {
  if (d.streamRows) {
    yield* d.streamRows(cc, db, table, 1000);
    return;
  }
  let page = 1;
  for (;;) {
    const p = await d.getPage(cc, db, table, page, 1000);
    if (p.rows.length) yield p.rows;
    if (p.rows.length < 1000) break;
    page++;
  }
}

function schemaColumns(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === 'object' && Array.isArray((value as { columns?: unknown }).columns)) {
    return (value as { columns: Record<string, unknown>[] }).columns;
  }
  return [];
}

function defaultSql(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const text = String(value).trim();
  if (/^(true|false|null)$/i.test(text)) return ` DEFAULT ${text.toUpperCase()}`;
  // Тип значения приходит с сервера (COLUMN_DEFAULT / pg_get_expr) и уже валиден
  // для своей СУБД: SERIAL → nextval(...), CURRENT_TIMESTAMP, now() и т.п.
  // Порядок проверок важен: литерал не должен оборачиваться в кавычки дважды.
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return ` DEFAULT ${text}`;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?$/.test(text)) return ` DEFAULT ${text}`;
  if (text.startsWith('(') && text.endsWith(')')) return ` DEFAULT ${text}`;
  return ` DEFAULT ${sqlLiteral(text)}`;
}

/**
 * CREATE TABLE (+ индексы и FK) по нормализованной модели TableSchema.
 *
 * Типы берутся от сервера как есть: раньше неизвестный тип молча заменялся на
 * TEXT, и дамп внешне выглядел корректно, а схема после restore отличалась.
 */
async function renderCreateTable(d: DbDriver, cc: ConnectionConfig, db: string, table: string): Promise<string> {  const schema = await d.getSchema(cc, db, table);
  const rows = schemaColumns(schema);
  if (!rows.length) return '';
  const dialect = dialectOf(cc);
  const q = (name: string) => quoteIdent(dialect, name);
  const model = schema as Partial<TableSchema>;
  const indexes = Array.isArray(model.indexes) ? model.indexes : [];
  const foreignKeys = Array.isArray(model.foreignKeys) ? model.foreignKeys : [];
  const primary: string[] = [];
  const definitions = rows.map((row) => {
    const name = String(row.name ?? row.Field ?? row.column_name ?? row.field ?? '');
    const type = String(row.type ?? row.Type ?? row.data_type ?? '').trim() || 'TEXT';
    const nullable = row.nullable === true || row.is_nullable === 'YES' || row.Null === 'YES' || row.notnull === 0;
    const isPrimary = row.primary === true || row.is_primary === true || row.Key === 'PRI' || row.pk === 1;
    if (isPrimary && !(cc.kind === 'sqlite' && row.autoInc === true)) primary.push(q(name));
    const extra = String(row.extra ?? row.Extra ?? '');
    const autoInc = row.autoInc === true || /auto_increment|identity|serial/i.test(extra) || /serial|identity/i.test(type);
    const defaultValue = row.default ?? row.Default ?? row.column_default ?? '';
    // MariaDB отдаёт COLUMN_DEFAULT = 'NULL' строкой для nullable-колонок
    // без значения по умолчанию — это не DEFAULT, а отсутствие оного.
    const noDefault = defaultValue === null || defaultValue === undefined || String(defaultValue).trim() === '' || String(defaultValue).trim().toUpperCase() === 'NULL';
    if (autoInc) {
      if (cc.kind === 'postgres') return `${q(name)} SERIAL`;
      // SQLite требует ровно один PRIMARY KEY: у AUTOINCREMENT он часть колонки
      if (cc.kind === 'sqlite') return `${q(name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
      // У Oracle нет AUTO_INCREMENT: IDENTITY объявляется на самой колонке
      if (cc.kind === 'oracle') return `${q(name)} ${type} GENERATED BY DEFAULT AS IDENTITY`;
      return `${q(name)} ${type} NOT NULL AUTO_INCREMENT`;
    }
    return `${q(name)} ${type}${nullable ? '' : ' NOT NULL'}${noDefault ? '' : defaultSql(defaultValue)}`;
  });
  const fkClause = (fk: (typeof foreignKeys)[number]) => {
    if (!fk.columns.length || !fk.refColumns.length) return '';
    const rules = [fk.onDelete ? `ON DELETE ${fk.onDelete}` : '', fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : ''].filter(Boolean).join(' ');
    return `FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.refTable)} (${fk.refColumns.map(q).join(', ')})${rules ? ' ' + rules : ''}`;
  };
  if (primary.length) definitions.push(`PRIMARY KEY (${primary.join(', ')})`);
  // SQLite не умеет ALTER TABLE ... ADD CONSTRAINT: FK уходят внутрь CREATE TABLE.
  // У MySQL/PG отдельный ALTER ещё и читается нагляднее.
  if (cc.kind === 'sqlite') {
    for (const fk of foreignKeys) {
      const clause = fkClause(fk);
      if (clause) definitions.push(clause);
    }
  }
  // Oracle не знает CREATE TABLE IF NOT EXISTS (ORA-00922): повторный restore в
// непустой схеме там закончится ORA-00955, а не тихим пропуском таблицы.
  const ifNotExists = cc.kind === 'oracle' ? '' : 'IF NOT EXISTS ';
  const lines = [`CREATE TABLE ${ifNotExists}${q(table)} (\n  ${definitions.join(',\n  ')}\n);\n`];
  // UNIQUE-индексы с уникальностью восстанавливаем отдельными CREATE INDEX,
  // иначе после restore теряется уникальность (было: терялось молча).
  // sqlite_* — служебные автоиндексы SQLite (UNIQUE/PK): их нельзя создать вручную,
  // сервер сам создаёт их из самих ограничений.
  for (const ix of indexes) {
    if (ix.primary || !ix.unique || !ix.columns.length || ix.name.startsWith('sqlite_')) continue;
    lines.push(`CREATE UNIQUE INDEX ${q(ix.name)} ON ${q(table)} (${ix.columns.map(q).join(', ')});\n`);
  }
  for (const ix of indexes) {
    if (ix.primary || ix.unique || !ix.columns.length || ix.name.startsWith('sqlite_')) continue;
    lines.push(`CREATE INDEX ${q(ix.name)} ON ${q(table)} (${ix.columns.map(q).join(', ')});\n`);
  }
  if (cc.kind !== 'sqlite') {
    for (const fk of foreignKeys) {
      const clause = fkClause(fk);
      if (clause) lines.push(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fk.name)} ${clause};\n`);
    }
  }
  return lines.join('');
}

/** DDL таблицы (CREATE + индексы + FK) по живой схеме. Используется дампом и
 *  снапшотом перед DDL-пакетом: по нему можно восстановить структуру вручную. */
export async function renderTableDdl(d: DbDriver, cc: ConnectionConfig, db: string, table: string): Promise<string> {
  return renderCreateTable(d, cc, db, table);
}

/** Генератор строк экспорта одной таблицы: csv | json (массив) | sql (CREATE + INSERT). */
export async function* renderTable(format: string, d: DbDriver, cc: ConnectionConfig, db: string, table: string): AsyncGenerator<string> {
  let columns: string[] | null = null;
  let first = true;
  if (format === 'json') yield '[\n';
  if (format === 'sql') {
    const create = await renderCreateTable(d, cc, db, table);
    if (create) yield create;
  }
  for await (const batch of batches(d, cc, db, table)) {
    for (const row of batch) {
      if (!columns) {
        columns = Object.keys(row);
        if (format === 'csv') yield csvLine(columns) + '\n';
        if (format === 'sql') yield `-- dbpanel dump ${db}.${table}\n`;
      }
      if (format === 'csv') yield csvLine(columns as string[], row) + '\n';
      else if (format === 'sql') yield insertStatement(dialectOf(cc), table, row) + '\n';
      else {
        if (!first) yield ',\n';
        first = false;
        yield JSON.stringify(row);
      }
    }
  }
  if (format === 'json') yield columns ? '\n]\n' : '[]\n';
}

/** Генератор дампа всей БД: sql — конкатенация таблиц; json — {"table":[...]}. */
export async function* renderDb(format: string, d: DbDriver, cc: ConnectionConfig, db: string, tables: string[]): AsyncGenerator<string> {
  if (format === 'json') {
    yield '{\n';
    let first = true;
    for (const t of tables) {
      if (!first) yield ',\n';
      first = false;
      yield `${JSON.stringify(t)}: [\n`;
      let f2 = true;
      for await (const batch of batches(d, cc, db, t)) {
        for (const row of batch) {
          if (!f2) yield ',\n';
          f2 = false;
          yield JSON.stringify(row);
        }
      }
      yield '\n]';
    }
    yield '\n}\n';
    return;
  }
  if (format === 'csv') {
    // В одном CSV несколько таблиц не помещаются: заголовок колонок у каждой
    // свой. Поэтому перед каждой таблицей печатаем строку-разделитель с её именем
    // и отдельно предупреждаем в ответе, что файл составной.
    yield `# dbpanel export ${db} ${new Date().toISOString()}\n`;
    yield `# format: csv, each table starts after a "# table: <name>" line\n`;
    for (const t of tables) {
      yield `# table: ${t}\n`;
      let header = false;
      for await (const batch of batches(d, cc, db, t)) {
        for (const row of batch) {
          if (!header) {
            header = true;
            yield csvLine(Object.keys(row)) + '\n';
          }
          yield csvLine(Object.keys(row), row) + '\n';
        }
      }
      yield '\n';
    }
    return;
  }
  yield `-- dbpanel backup ${db} ${new Date().toISOString()}\n`;
  for (const t of tables) yield* renderTable(format, d, cc, db, t);
}

export function toStream(gen: AsyncGenerator<string>): Readable {
  return Readable.from(gen);
}
