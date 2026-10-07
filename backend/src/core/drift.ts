import type { ModelColumn, ModelForeignKey, ModelIndex, ModelTable, ModelTrigger } from './models.js';
import type { TableSchema } from './types.js';

/**
 * Сравнение модели с базой (drift). Показывает три вещи: чего не хватает,
 * что лишнее и что разошлось по существу.
 *
 * Что намеренно НЕ сравнивается (иначе будут постоянные ложные «различия»):
 *  - `default` у колонок: у SERIAL это `nextval(...)`, у PG — `NULL`, плюс СУБД
 *    нормализует регистр и кавычки;
 *  - `extra` и тела триггеров: сервер их переформатирует по-своему;
 *  - регистр имён и пробелы в типах.
 */
export interface ColumnDiff {
  column: string;
  changes: string[];
}

export interface TableDiff {
  table: string;
  missingColumns: string[];
  extraColumns: string[];
  changedColumns: ColumnDiff[];
  missingIndexes: string[];
  extraIndexes: string[];
  changedIndexes: { index: string; changes: string[] }[];
  missingForeignKeys: string[];
  extraForeignKeys: string[];
  changedForeignKeys: { foreignKey: string; changes: string[] }[];
  missingTriggers: string[];
  extraTriggers: string[];
  equal: boolean;
}

export interface ModelDiff {
  equal: boolean;
  missingTables: string[];
  extraTables: string[];
  changedTables: TableDiff[];
  summary: { missing: number; extra: number; changed: number; same: number };
}

/**
 * Приведение типа к каноническому виду. Одна и та же колонка после применения
 * модели выглядит по-разному в зависимости от диалекта: `INT` превращается в
 * `integer`, `VARCHAR(100)` — в `character varying(100)`. Без алиасов diff
 * показывал бы расхождения там, где их нет.
 *
 * Сознательно НЕ объединяем `datetime` и `timestamp` или `text` и `varchar`:
 * это разные типы с разным поведением.
 */
const TYPE_ALIASES: Record<string, string> = {
  int: 'int', integer: 'int', int4: 'int', mediumint: 'int',
  int2: 'smallint', smallint: 'smallint',
  int8: 'bigint', bigint: 'bigint', bigserial: 'bigint', serial8: 'bigint',
  serial: 'int', serial4: 'int',
  bool: 'boolean', boolean: 'boolean',
  float4: 'real', real: 'real',
  float8: 'double', double: 'double', 'double precision': 'double'
};

function normType(type: string | null | undefined): string {
  const raw = String(type ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // varchar(100) / character varying (100) → varchar(100)
  const m = raw.match(/^(character varying|character|varchar|char|numeric|decimal|varbinary|binary)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/);
  if (m) {
    const base = m[1] === 'character varying' ? 'varchar' : m[1] === 'character' ? 'char' : m[1] === 'decimal' ? 'numeric' : m[1];
    const args = raw.match(/\(\s*(\d+(?:\s*,\s*\d+)?)\s*\)/);
    return args ? `${base}(${args[1].replace(/\s+/g, '')})` : base;
  }
  const base = raw.includes('(') ? raw.slice(0, raw.indexOf('(')).trim() : raw;
  const args = raw.includes('(') ? raw.slice(raw.indexOf('(')).replace(/\s+/g, '') : '';
  return `${TYPE_ALIASES[base] ?? base}${args}`;
}

function key(name: string): string {
  return String(name).toLowerCase();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].map(key).sort();
  const sb = [...b].map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Схема СУБД → форма модели (используется и импортом, и сравнением). */
export function schemaToModelTable(schema: TableSchema): ModelTable {
  return {
    name: schema.table,
    comment: schema.comment,
    kind: schema.kind,
    columns: schema.columns.map((c): ModelColumn => ({
      name: c.name, type: c.type, nullable: c.nullable, primary: c.primary,
      autoInc: c.autoInc, default: c.default, comment: c.comment, extra: c.extra
    })),
    indexes: schema.indexes.map((i): ModelIndex => ({ name: i.name, columns: i.columns, unique: i.unique, type: i.type })),
    foreignKeys: schema.foreignKeys.map((f): ModelForeignKey => ({
      name: f.name, columns: f.columns, refTable: f.refTable, refColumns: f.refColumns,
      onDelete: f.onDelete, onUpdate: f.onUpdate
    })),
    triggers: schema.triggers
      .filter((t) => t.timing && t.event)
      .map((t): ModelTrigger => ({ name: t.name, timing: t.timing as string, event: t.event as string, statement: t.statement }))
  };
}

/** Подпись внешнего ключа, когда сервер не вернул имени (SQLite так делает). */
function fkLabel(fk: ModelForeignKey): string {
  if (fk.name) return fk.name;
  return `${fk.columns.join(',')}→${fk.refTable}(${fk.refColumns.join(',')})`;
}

/**
 * Индекс, который СУБД создала сама для первичного ключа (`PRIMARY` в
 * MySQL/SQLite, `t1_pkey` в PostgreSQL). В модели его нет, и показывать его
 * как «лишний» бессмысленно: он есть в любой таблице с первичным ключом.
 * Индекс с другим именем на тех же колонках — уже настоящий лишний объект.
 */
function isImplicitPkIndex(indexName: string, tableName: string): boolean {
  const name = key(indexName);
  if (name === 'primary') return true;
  return name === `${key(tableName)}_pkey`;
}

function diffTable(model: ModelTable, actual: ModelTable): TableDiff {  const modelCols = new Map(model.columns.map((c) => [key(c.name), c]));
  const actualCols = new Map(actual.columns.map((c) => [key(c.name), c]));

  const missingColumns: string[] = [];
  const changedColumns: ColumnDiff[] = [];
  for (const c of model.columns) {
    const have = actualCols.get(key(c.name));
    if (!have) { missingColumns.push(c.name); continue; }
    const changes: string[] = [];
    if (normType(c.type) !== normType(have.type)) changes.push(`тип: модель ${c.type} / база ${have.type}`);
    if (Boolean(c.nullable) !== Boolean(have.nullable)) changes.push(`not null: модель ${c.nullable ? 'нет' : 'да'} / база ${have.nullable ? 'нет' : 'да'}`);
    if (Boolean(c.primary) !== Boolean(have.primary)) changes.push(`первичный ключ: модель ${c.primary ? 'да' : 'нет'} / база ${have.primary ? 'да' : 'нет'}`);
    if (Boolean(c.autoInc) !== Boolean(have.autoInc)) changes.push(`автоинкремент: модель ${c.autoInc ? 'да' : 'нет'} / база ${have.autoInc ? 'да' : 'нет'}`);
    if (changes.length) changedColumns.push({ column: c.name, changes });
  }
  const extraColumns = actual.columns.filter((c) => !modelCols.has(key(c.name))).map((c) => c.name);

  const modelIdx = new Map((model.indexes ?? []).map((i) => [key(i.name), i]));
  const actualIdx = new Map((actual.indexes ?? []).map((i) => [key(i.name), i]));
  const missingIndexes: string[] = [];
  const changedIndexes: { index: string; changes: string[] }[] = [];
  for (const i of model.indexes ?? []) {
    const have = actualIdx.get(key(i.name));
    if (!have) { missingIndexes.push(i.name); continue; }
    const changes: string[] = [];
    if (!sameSet(i.columns, have.columns)) changes.push(`колонки: ${i.columns.join(',')} / ${have.columns.join(',')}`);
    if (Boolean(i.unique) !== Boolean(have.unique)) changes.push(`уникальность: модель ${i.unique ? 'да' : 'нет'} / база ${have.unique ? 'да' : 'нет'}`);
    if (changes.length) changedIndexes.push({ index: i.name, changes });
  }
  const extraIndexes = (actual.indexes ?? []).filter((i) => !modelIdx.has(key(i.name))).map((i) => i.name)
    .filter((name) => !isImplicitPkIndex(name, model.name));

  const modelFks = (model.foreignKeys ?? []).map((f) => ({ f, label: fkLabel(f) }));
  const actualFks = (actual.foreignKeys ?? []).map((f) => ({ f, label: fkLabel(f) }));
  const matchFk = (mf: (typeof modelFks)[number]) =>
    actualFks.find((af) => (mf.f.name && af.f.name && key(mf.f.name) === key(af.f.name))
      || (sameSet(mf.f.columns, af.f.columns) && key(mf.f.refTable) === key(af.f.refTable)));
  const missingForeignKeys: string[] = [];
  const changedForeignKeys: { foreignKey: string; changes: string[] }[] = [];
  const usedActual = new Set<number>();
  for (const mf of modelFks) {
    const hit = matchFk(mf);
    if (!hit) { missingForeignKeys.push(mf.label); continue; }
    usedActual.add(actualFks.indexOf(hit));
    const changes: string[] = [];
    if (!sameSet(mf.f.columns, hit.f.columns)) changes.push(`колонки: ${mf.f.columns.join(',')} / ${hit.f.columns.join(',')}`);
    if (!sameSet(mf.f.refColumns, hit.f.refColumns)) changes.push(`ссылается на: ${mf.f.refColumns.join(',')} / ${hit.f.refColumns.join(',')}`);
    const modelDel = (mf.f.onDelete ?? '').toUpperCase();
    const baseDel = (hit.f.onDelete ?? '').toUpperCase();
    if (modelDel && baseDel && modelDel !== baseDel) changes.push(`ON DELETE: модель ${modelDel} / база ${baseDel}`);
    if (changes.length) changedForeignKeys.push({ foreignKey: mf.label, changes });
  }
  const extraForeignKeys = actualFks.filter((_, i) => !usedActual.has(i)).map((x) => x.label);

  const modelTrg = new Map((model.triggers ?? []).map((t) => [key(t.name), t]));
  const actualTrg = new Map((actual.triggers ?? []).map((t) => [key(t.name), t]));
  const missingTriggers = (model.triggers ?? []).filter((t) => !actualTrg.has(key(t.name))).map((t) => t.name);
  const extraTriggers = (actual.triggers ?? []).filter((t) => !modelTrg.has(key(t.name))).map((t) => t.name);

  const equal = !missingColumns.length && !extraColumns.length && !changedColumns.length
    && !missingIndexes.length && !extraIndexes.length && !changedIndexes.length
    && !missingForeignKeys.length && !extraForeignKeys.length && !changedForeignKeys.length
    && !missingTriggers.length && !extraTriggers.length;

  return {
    table: model.name, missingColumns, extraColumns, changedColumns,
    missingIndexes, extraIndexes, changedIndexes,
    missingForeignKeys, extraForeignKeys, changedForeignKeys,
    missingTriggers, extraTriggers, equal
  };
}

/** Полное сравнение: модель против фактической схемы базы. */
export function diffModelTables(model: ModelTable[], actual: ModelTable[]): ModelDiff {
  const modelTables = new Map(model.map((t) => [key(t.name), t]));
  const actualTables = new Map(actual.map((t) => [key(t.name), t]));

  const missingTables = model.filter((t) => !actualTables.has(key(t.name))).map((t) => t.name);
  const extraTables = actual.filter((t) => !modelTables.has(key(t.name))).map((t) => t.name);
  const changedTables: TableDiff[] = [];
  let same = 0;
  for (const t of model) {
    const have = actualTables.get(key(t.name));
    if (!have) continue;
    const d = diffTable(t, have);
    if (d.equal) same += 1;
    else changedTables.push(d);
  }
  return {
    equal: !missingTables.length && !extraTables.length && !changedTables.length,
    missingTables,
    extraTables,
    changedTables,
    summary: { missing: missingTables.length, extra: extraTables.length, changed: changedTables.length, same }
  };
}
