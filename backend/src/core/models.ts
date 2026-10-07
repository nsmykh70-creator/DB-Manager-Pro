import { randomUUID } from 'node:crypto';
import { openMeta } from './store.js';
import { audit } from './context.js';
import { withCode } from './errcodes.js';

/**
 * Модели проекта — сохранённые схемы. Отличаются от «точки восстановления»
 * (это дамп одной таблицы) и от снапшота DDL (это откат одного пакета):
 * модель хранит всю схему целиком, версионируется и может быть применена
 * к другой базе.
 *
 * Ограничения (намеренные, чтобы в БД не попало мусор):
 *  - 200 таблиц в модели, 200 колонок в таблице, имя до 128 символов;
 *  - JSON модели до 4 МБ;
 *  - 20 версий на модель, старые и их снапшоты удаляются;
 *  - имена таблиц/колонок проверяются регулярным выражением allowlist.
 */
export const MAX_TABLES = 200;
export const MAX_COLUMNS = 200;
export const MAX_NAME = 128;
export const MAX_JSON = 4 * 1024 * 1024;
export const KEEP_VERSIONS = 20;
/**
 * Латиница, цифры, подчёркивание, буквы Unicode — как в конструкторе, плюс
 * `#`, `$` и `-`: с ними приходят импортированные схемы CMS (`#__mywidget`,
 * `my-table`), и без них «Забрать схему» отказывал на реальной базе.
 * Пробелы, точки и кавычки по-прежнему запрещены — имя уходит в DDL уже
 * обёрнутым в кавычки диалекта (см. ident в drivers/helpers.ts).
 */
const IDENT = /^[\p{L}0-9_#$?-]+$/u;

export interface ModelColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
  autoInc?: boolean;
  default?: string | null;
  comment?: string | null;
  /** Метка диалекта: pg/SQLite/AUTO_INCREMENT и т. п. */
  extra?: string | null;
}

export interface ModelIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string | null;
  where?: string | null;
}

export interface ModelForeignKey {
  name?: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string | null;
  onUpdate?: string | null;
}

export interface ModelTrigger {
  name: string;
  timing: string;
  event: string;
  statement: string;
}

export interface ModelTable {
  name: string;
  comment?: string | null;
  /** table | view — представления в модель не применяются, но сохраняются. */
  kind?: string;
  columns: ModelColumn[];
  indexes?: ModelIndex[];
  foreignKeys?: ModelForeignKey[];
  triggers?: ModelTrigger[];
}

export interface ProjectModel {
  id: string;
  name: string;
  dbKind: string | null;
  dbName: string | null;
  comment: string | null;
  tables: ModelTable[];
  version: number;
  actor: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelSummary {
  id: string;
  name: string;
  dbKind: string | null;
  dbName: string | null;
  comment: string | null;
  tables: number;
  version: number;
  actor: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ModelRow {
  id: string;
  name: string;
  dbKind: string | null;
  dbName: string | null;
  comment: string | null;
  tablesJson: string;
  version: number;
  actor: string | null;
  createdAt: number;
  updatedAt: number;
}

interface VersionRow {
  id: string;
  modelId: string;
  version: number;
  tablesJson: string;
  note: string | null;
  actor: string | null;
  at: number;
}

export function ensureModelsTables(metaPath: string): void {
  openMeta(metaPath).exec(`
    CREATE TABLE IF NOT EXISTS project_models (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, dbKind TEXT, dbName TEXT,
      comment TEXT, tablesJson TEXT NOT NULL, version INTEGER NOT NULL,
      actor TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_versions (
      id TEXT PRIMARY KEY, modelId TEXT NOT NULL, version INTEGER NOT NULL,
      tablesJson TEXT NOT NULL, note TEXT, actor TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_versions ON model_versions(modelId, version DESC);
  `);
}

function bad(message: string, code = 400): never {
  throw Object.assign(new Error(message), { statusCode: code });
}

function ident(value: unknown, what: string): string {
  const v = String(value ?? '').trim();
  if (!v || v.length > MAX_NAME || !IDENT.test(v)) {
    // Ошибку строим здесь, а не через bad(): bad() бросает исключение, и
    // withCode(bad(...)) никогда не выполнился бы — код молча терялся.
    throw withCode(
      Object.assign(new Error(`Bad ${what}: ${String(value).slice(0, MAX_NAME)} (expected letters, digits, underscore, #, $ or -, max ${MAX_NAME})`), { statusCode: 400 }),
      'bad_identifier',
    );
  }
  return v;
}

/** Структурная проверка модели: имена, размеры, соответствие колонок индексам/FK. */
export function validateTables(input: unknown): ModelTable[] {
  if (!Array.isArray(input)) bad('tables must be an array');
  if (!input.length) bad('Model must contain at least one table');
  if (input.length > MAX_TABLES) bad(`Too many tables (max ${MAX_TABLES})`);
  const seen = new Set<string>();
  return input.map((raw, ti) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const name = ident(t.name, `table name #${ti + 1}`);
    const key = name.toLowerCase();
    if (seen.has(key)) bad(`Duplicate table in model: ${name}`);
    seen.add(key);
    const columnsRaw = t.columns;
    if (!Array.isArray(columnsRaw) || !columnsRaw.length) bad(`Table ${name}: columns required`);
    if (columnsRaw.length > MAX_COLUMNS) bad(`Table ${name}: too many columns (max ${MAX_COLUMNS})`);
    const columns: ModelColumn[] = columnsRaw.map((c, ci) => {
      const col = (c ?? {}) as Record<string, unknown>;
      const cname = ident(col.name, `column name in ${name} #${ci + 1}`);
      const type = String(col.type ?? '').trim();
      if (!type || type.length > 64) bad(`Table ${name}: column ${cname} needs a type (max 64 chars)`);
      const def = col.default === null || col.default === undefined ? null : String(col.default).slice(0, 2000);
      return {
        name: cname,
        type,
        nullable: col.nullable !== false,
        primary: col.primary === true,
        autoInc: col.autoInc === true,
        default: def,
        comment: col.comment ? String(col.comment).slice(0, 500) : null,
        extra: col.extra ? String(col.extra).slice(0, 100) : null
      };
    });
    const colNames = new Set(columns.map((c) => c.name.toLowerCase()));
    const indexes: ModelIndex[] = (Array.isArray(t.indexes) ? t.indexes : []).slice(0, 100).map((rawIdx) => {
      const idx = (rawIdx ?? {}) as Record<string, unknown>;
      const iname = ident(idx.name, `index name in ${name}`);
      const cols = (Array.isArray(idx.columns) ? idx.columns : []).map((c) => ident(c, `index column in ${name}.${iname}`));
      if (!cols.length) bad(`Table ${name}: index ${iname} needs columns`);
      for (const c of cols) if (!colNames.has(c.toLowerCase())) bad(`Table ${name}: index ${iname} refers to unknown column ${c}`);
      return {
        name: iname,
        columns: cols,
        unique: idx.unique === true,
        type: idx.type ? String(idx.type).slice(0, 32) : null,
        where: idx.where ? String(idx.where).slice(0, 500) : null
      };
    });
    const foreignKeys: ModelForeignKey[] = (Array.isArray(t.foreignKeys) ? t.foreignKeys : []).slice(0, 100).map((rawFk) => {
      const fk = (rawFk ?? {}) as Record<string, unknown>;
      const cols = (Array.isArray(fk.columns) ? fk.columns : []).map((c) => ident(c, `fk column in ${name}`));
      const refCols = (Array.isArray(fk.refColumns) ? fk.refColumns : []).map((c) => ident(c, `fk ref column in ${name}`));
      const refTable = ident(fk.refTable, `fk ref table in ${name}`);
      if (!cols.length || cols.length !== refCols.length) bad(`Table ${name}: foreign key needs matching column lists`);
      for (const c of cols) if (!colNames.has(c.toLowerCase())) bad(`Table ${name}: foreign key refers to unknown column ${c}`);
      return {
        name: fk.name ? ident(fk.name, `fk name in ${name}`) : null,
        columns: cols,
        refTable,
        refColumns: refCols,
        onDelete: fk.onDelete ? String(fk.onDelete).slice(0, 20) : null,
        onUpdate: fk.onUpdate ? String(fk.onUpdate).slice(0, 20) : null
      };
    });
    const triggers: ModelTrigger[] = (Array.isArray(t.triggers) ? t.triggers : []).slice(0, 50).map((rawTrg) => {
      const trg = (rawTrg ?? {}) as Record<string, unknown>;
      const tname = ident(trg.name, `trigger name in ${name}`);
      const timing = String(trg.timing ?? 'BEFORE').toUpperCase();
      const event = String(trg.event ?? 'INSERT').toUpperCase();
      const statement = String(trg.statement ?? '').trim();
      if (!statement || statement.length > 20_000) bad(`Table ${name}: trigger ${tname} needs a body (max 20000 chars)`);
      if (!/^(BEFORE|AFTER|INSTEAD OF)$/.test(timing)) bad(`Table ${name}: trigger ${tname} has bad timing ${timing}`);
      if (!/^(INSERT|UPDATE|DELETE)$/.test(event)) bad(`Table ${name}: trigger ${tname} has bad event ${event}`);
      return { name: tname, timing, event, statement };
    });
    return {
      name,
      comment: t.comment ? String(t.comment).slice(0, 500) : null,
      kind: t.kind === 'view' ? 'view' : 'table',
      columns,
      indexes,
      foreignKeys,
      triggers
    };
  });
}

function checkJsonSize(tables: ModelTable[]): string {
  const json = JSON.stringify(tables);
  if (json.length > MAX_JSON) bad(`Model is too large (${Math.round(json.length / 1024 / 1024)} MB, max ${MAX_JSON / 1024 / 1024} MB)`);
  return json;
}

function toSummary(row: ModelRow): ModelSummary {
  const tables = safeParse<ModelTable[]>(row.tablesJson, []);
  return {
    id: row.id, name: row.name, dbKind: row.dbKind, dbName: row.dbName, comment: row.comment,
    tables: tables.length, version: row.version, actor: row.actor, createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

export function listModels(metaPath: string, filter: { q?: string; dbKind?: string; limit?: number } = {}): ModelSummary[] {
  ensureModelsTables(metaPath);
  const lim = Math.min(Math.max(Number(filter.limit ?? 100) || 100, 1), 500);
  let sql = `SELECT * FROM project_models WHERE 1=1`;
  const params: unknown[] = [];
  if (filter.q) { sql += ` AND name LIKE ?`; params.push(`%${String(filter.q).slice(0, 100)}%`); }
  if (filter.dbKind) { sql += ` AND dbKind=?`; params.push(filter.dbKind); }
  sql += ` ORDER BY updatedAt DESC LIMIT ?`;
  params.push(lim);
  return (openMeta(metaPath).prepare(sql).all(...params) as ModelRow[]).map(toSummary);
}

export function getModel(metaPath: string, id: string): ProjectModel {
  ensureModelsTables(metaPath);
  const row = openMeta(metaPath).prepare(`SELECT * FROM project_models WHERE id=?`).get(id) as ModelRow | undefined;
  if (!row) bad('Model not found', 404);
  return {
    id: row.id, name: row.name, dbKind: row.dbKind, dbName: row.dbName, comment: row.comment,
    tables: safeParse<ModelTable[]>(row.tablesJson, []), version: row.version, actor: row.actor,
    createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}

export function createModel(
  metaPath: string,
  input: { name: unknown; dbKind?: string | null; dbName?: string | null; comment?: string | null; tables: unknown; actor?: string | null }
): ProjectModel {
  ensureModelsTables(metaPath);
  const name = ident(input.name, 'model name');
  const tables = validateTables(input.tables);
  const json = checkJsonSize(tables);
  const now = Date.now();
  const id = randomUUID();
  try {
    openMeta(metaPath).prepare(
      `INSERT INTO project_models (id,name,dbKind,dbName,comment,tablesJson,version,actor,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, input.dbKind ?? null, input.dbName ?? null, input.comment?.slice(0, 500) ?? null, json, 1, input.actor ?? null, now, now);
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) bad(`Model "${name}" already exists`, 409);
    throw e;
  }
  audit(metaPath, null, 'model.create', `${name}:${tables.length}t`, true, 0, input.actor);
  return getModel(metaPath, id);
}

/** Сохраняет новую версию; предыдущее содержимое уходит в историю. */
export function saveModel(
  metaPath: string,
  id: string,
  input: { tables: unknown; comment?: string | null; expectedVersion?: number; note?: string | null; actor?: string | null }
): ProjectModel {
  const current = getModel(metaPath, id);
  if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== current.version) {
    bad(`Model changed since it was opened (version ${current.version}, you have ${Number(input.expectedVersion)})`, 409);
  }
  const tables = validateTables(input.tables);
  const json = checkJsonSize(tables);
  const now = Date.now();
  const nextVersion = current.version + 1;
  const meta = openMeta(metaPath);
  meta.prepare(`INSERT INTO model_versions (id,modelId,version,tablesJson,note,actor,at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), id, current.version, current.tables ? JSON.stringify(current.tables) : '[]', input.note ?? null, input.actor ?? null, now);
  meta.prepare(`UPDATE project_models SET tablesJson=?, version=?, comment=?, updatedAt=? WHERE id=?`)
    .run(json, nextVersion, input.comment === undefined ? current.comment : input.comment?.slice(0, 500) ?? null, now, id);
  pruneVersions(metaPath, id);
  audit(metaPath, null, 'model.save', `${current.name}:v${nextVersion}:${tables.length}t`, true, 0, input.actor);
  return getModel(metaPath, id);
}

export function updateModelMeta(
  metaPath: string,
  id: string,
  patch: { name?: unknown; comment?: string | null; dbKind?: string | null; dbName?: string | null; actor?: string | null }
): ProjectModel {
  const current = getModel(metaPath, id);
  const name = patch.name === undefined ? current.name : ident(patch.name, 'model name');
  const comment = patch.comment === undefined ? current.comment : patch.comment?.slice(0, 500) ?? null;
  const dbKind = patch.dbKind === undefined ? current.dbKind : patch.dbKind;
  const dbName = patch.dbName === undefined ? current.dbName : patch.dbName;
  try {
    openMeta(metaPath).prepare(`UPDATE project_models SET name=?, comment=?, dbKind=?, dbName=?, updatedAt=? WHERE id=?`)
      .run(name, comment, dbKind, dbName, Date.now(), id);
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) bad(`Model "${name}" already exists`, 409);
    throw e;
  }
  audit(metaPath, null, 'model.update', name, true, 0, patch.actor);
  return getModel(metaPath, id);
}

export function deleteModel(metaPath: string, id: string, actor?: string | null): void {
  const current = getModel(metaPath, id);
  const meta = openMeta(metaPath);
  meta.prepare(`DELETE FROM model_versions WHERE modelId=?`).run(id);
  meta.prepare(`DELETE FROM project_models WHERE id=?`).run(id);
  audit(metaPath, null, 'model.delete', current.name, true, 0, actor);
}

export interface ModelVersionSummary {
  id: string;
  version: number;
  note: string | null;
  actor: string | null;
  at: number;
  tables: number;
}

export function listVersions(metaPath: string, modelId: string, limit = 20): ModelVersionSummary[] {
  getModel(metaPath, modelId);
  ensureModelsTables(metaPath);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = openMeta(metaPath)
    .prepare(`SELECT id, modelId, version, tablesJson, note, actor, at FROM model_versions WHERE modelId=? ORDER BY version DESC LIMIT ?`)
    .all(modelId, lim) as VersionRow[];
  return rows.map((r) => ({
    id: r.id, version: r.version, note: r.note, actor: r.actor, at: r.at,
    tables: safeParse<ModelTable[]>(r.tablesJson, []).length
  }));
}

export function getVersion(metaPath: string, modelId: string, versionId: string): ModelTable[] {
  getModel(metaPath, modelId);
  ensureModelsTables(metaPath);
  const row = openMeta(metaPath).prepare(`SELECT tablesJson FROM model_versions WHERE id=? AND modelId=?`).get(versionId, modelId) as { tablesJson: string } | undefined;
  if (!row) bad('Version not found', 404);
  return safeParse<ModelTable[]>(row.tablesJson, []);
}

/** Откат на версию — это новая версия с прежним содержимым, история не теряется. */
export function restoreVersion(metaPath: string, modelId: string, versionId: string, actor?: string | null): ProjectModel {
  const tables = getVersion(metaPath, modelId, versionId);
  const current = getModel(metaPath, modelId);
  return saveModel(metaPath, modelId, { tables, note: `restore of v${current.version - 1}`, actor });
}

function pruneVersions(metaPath: string, modelId: string): void {
  const meta = openMeta(metaPath);
  const olds = meta.prepare(`SELECT id FROM model_versions WHERE modelId=? ORDER BY version DESC`).all(modelId) as { id: string }[];
  for (const old of olds.slice(KEEP_VERSIONS)) meta.prepare(`DELETE FROM model_versions WHERE id=?`).run(old.id);
}
