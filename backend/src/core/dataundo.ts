import { randomUUID } from 'node:crypto';
import { assertNotReadOnly } from './types.js';
import type { DbDriver, ConnectionConfig, DbKind } from './types.js';
import { openMeta } from './store.js';
import { audit } from './context.js';
import { getDriver } from '../plugins/registry.js';

/**
 * Откат изменений ДАННЫХ (не структуры). Идея: перед изменением строк снимаем
 * образы затронутых строк (before/after) и умеем применить обратное действие.
 * В отличие от checkpoint не дампим таблицу целиком — это дешёво и не срабатывает
 * лимит 50 МБ на больших таблицах.
 *
 * Ограничения (намеренные, чтобы не «тихо» портить данные):
 *  - без первичного ключа откат невозможен — запись не создаётся;
 *  - >500 строк или >1 МБ образа — запись помечается неоткатываемой, помогает checkpoint;
 *  - PostgreSQL с serial/identity не умеет вернуть удалённые строки с теми же
 *    ключами, поэтому откат удаления для него запрещён явно (см. assertUndoable).
 */
export const KEEP_PER_TABLE = 30;
const MAX_ROWS = 500;
const MAX_BYTES = 1024 * 1024;

export type DataUndoOp = 'insert' | 'update' | 'delete';

export interface DataUndoEntry {
  id: string;
  connId: string;
  dbName: string;
  tableName: string;
  op: DataUndoOp;
  /** PK-колонки, по ним строятся фильтры обратной операции. */
  pkJson: string;
  beforeJson: string;
  afterJson: string;
  rows: number;
  summary: string;
  /** 1 — откат выполнен (можно повторить через redo). */
  undone: number;
  /** 1 — образ неполный, откат невозможен. */
  blocked: number;
  actor: string | null;
  at: number;
}

export interface DataUndoListItem {
  id: string;
  connId: string;
  dbName: string;
  tableName: string;
  op: DataUndoOp;
  rows: number;
  summary: string;
  undone: number;
  blocked: number;
  undoable: boolean;
  canRedo: boolean;
  actor: string | null;
  at: number;
}

export function ensureDataUndoTable(metaPath: string): void {
  openMeta(metaPath).exec(`
    CREATE TABLE IF NOT EXISTS data_undo (
      id TEXT PRIMARY KEY, connId TEXT NOT NULL, dbName TEXT NOT NULL, tableName TEXT NOT NULL,
      op TEXT NOT NULL, pkJson TEXT NOT NULL, beforeJson TEXT NOT NULL, afterJson TEXT NOT NULL,
      rows INTEGER NOT NULL, summary TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0, actor TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_data_undo ON data_undo(connId, dbName, tableName, at DESC);
  `);
}

function prune(metaPath: string, connId: string, db: string, table: string): void {
  const meta = openMeta(metaPath);
  const olds = meta
    .prepare(`SELECT id FROM data_undo WHERE connId=? AND dbName=? AND tableName=? ORDER BY at DESC`)
    .all(connId, db, table) as { id: string }[];
  for (const old of olds.slice(KEEP_PER_TABLE)) meta.prepare(`DELETE FROM data_undo WHERE id=?`).run(old.id);
}

function toItem(row: DataUndoEntry): DataUndoListItem {
  return {
    id: row.id, connId: row.connId, dbName: row.dbName, tableName: row.tableName, op: row.op,
    rows: row.rows, summary: row.summary, undone: row.undone, blocked: row.blocked,
    undoable: row.blocked === 0, canRedo: row.undone === 1 && row.blocked === 0,
    actor: row.actor, at: row.at
  };
}

export function listDataUndo(
  metaPath: string,
  filter: { connId: string; db?: string; table?: string; limit?: number }
): DataUndoListItem[] {
  ensureDataUndoTable(metaPath);
  const lim = Math.min(Math.max(Number(filter.limit ?? 20) || 20, 1), 100);
  let sql = `SELECT * FROM data_undo WHERE connId=?`;
  const params: unknown[] = [filter.connId];
  if (filter.db) { sql += ` AND dbName=?`; params.push(filter.db); }
  if (filter.table) { sql += ` AND tableName=?`; params.push(filter.table); }
  sql += ` ORDER BY at DESC LIMIT ?`;
  params.push(lim);
  return (openMeta(metaPath).prepare(sql).all(...params) as DataUndoEntry[]).map(toItem);
}

export function getDataUndo(metaPath: string, id: string): DataUndoEntry {
  ensureDataUndoTable(metaPath);
  const row = openMeta(metaPath).prepare(`SELECT * FROM data_undo WHERE id=?`).get(id) as DataUndoEntry | undefined;
  if (!row) throw Object.assign(new Error('Data undo entry not found'), { statusCode: 404 });
  return row;
}

export function deleteDataUndo(metaPath: string, id: string): void {
  getDataUndo(metaPath, id);
  openDataUndoMeta(metaPath).prepare(`DELETE FROM data_undo WHERE id=?`).run(id);
}

function openDataUndoMeta(metaPath: string) {
  ensureDataUndoTable(metaPath);
  return openMeta(metaPath);
}

export interface RecordInput {
  connId: string;
  db: string;
  table: string;
  op: DataUndoOp;
  /** Образы строк: до изменения и после. */
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
  pk: string[];
  /** Почему запись неоткатываема (попадёт в summary и в API). */
  blockedReason?: string;
  actor?: string | null;
}

/** Записывает образы изменений. Ошибки не мешают самой операции — только теряется откат. */
export function recordDataUndo(metaPath: string, input: RecordInput): DataUndoListItem | null {
  try {
    ensureDataUndoTable(metaPath);
    const beforeJson = JSON.stringify(input.before);
    const afterJson = JSON.stringify(input.after);
    const tooBig = beforeJson.length > MAX_BYTES || afterJson.length > MAX_BYTES;
    const blocked = tooBig ? 1 : input.blockedReason ? 1 : 0;
    const reason = tooBig
      ? `образ больше ${MAX_BYTES / 1024} КБ — используйте точку восстановления`
      : input.blockedReason ?? '';
    const entry: DataUndoEntry = {
      id: randomUUID(),
      connId: input.connId, dbName: input.db, tableName: input.table, op: input.op,
      pkJson: JSON.stringify(input.pk), beforeJson, afterJson,
      rows: input.op === 'insert' ? input.after.length : input.before.length,
      summary: reason || defaultSummary(input.op, input.op === 'insert' ? input.after.length : input.before.length),
      undone: 0, blocked, actor: input.actor ?? null, at: Date.now()
    };
    openMeta(metaPath).prepare(
      `INSERT INTO data_undo (id,connId,dbName,tableName,op,pkJson,beforeJson,afterJson,rows,summary,undone,blocked,actor,at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(entry.id, entry.connId, entry.dbName, entry.tableName, entry.op, entry.pkJson,
      beforeJson, afterJson, entry.rows, entry.summary, 0, blocked, entry.actor, entry.at);
    prune(metaPath, input.connId, input.db, input.table);
    return toItem(entry);
  } catch {
    // Откат — вспомогательная возможность; не даём ей ломать основную операцию.
    return null;
  }
}

function defaultSummary(op: DataUndoOp, rows: number): string {
  const n = `${rows} ${rows === 1 ? 'строка' : 'строк'}`;
  if (op === 'insert') return `Вставлено: ${n}`;
  if (op === 'update') return `Изменено: ${n}`;
  return `Удалено: ${n}`;
}

/**
 * Откат удаления в PostgreSQL с identity-колонкой невозможен: вернуть строку с
 * прежним ключом нельзя (нужен OVERRIDING SYSTEM VALUE), а генерировать заново —
 * значит разорвать ссылки. У обычного serial такой проблемы нет.
 */
export function assertUndoable(
  kind: DbKind,
  op: DataUndoOp,
  pk: { name: string; autoInc: boolean; identity?: boolean }[]
): string | null {
  if (!pk.length) return 'без первичного ключа откат невозможен';
  if (kind === 'postgres' && op === 'delete' && pk.some((c) => c.identity)) {
    return 'PostgreSQL: ключи identity пришлось бы сгенерировать заново — откат удаления недоступен';
  }
  return null;
}

interface ApplyContext {
  metaPath: string;
  cc: ConnectionConfig;
  d: DbDriver;
  db: string;
  table: string;
}

function pkFilter(row: Record<string, unknown>, pk: string[]): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const c of pk) f[c] = row[c];
  return f;
}

function withoutPk(row: Record<string, unknown>, pk: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (!pk.includes(k)) o[k] = row[k];
  return o;
}

async function restoreRows(ctx: ApplyContext, pk: string[], rows: Record<string, unknown>[]): Promise<{ restored: number; skipped: string[] }> {
  const { d, cc, db, table } = ctx;
  if (!d.updateRow || !d.insertRow || !d.findRows) {
    throw Object.assign(new Error('Undo is not supported for this database'), { statusCode: 400 });
  }
  let restored = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    const f = pkFilter(row, pk);
    const existing = await d.findRows(cc, db, table, f, 1);
    if (existing.length) {
      // PK в patch не пишем: у Mongo он неизменяемый, а у остальных он в фильтре
      const patch = withoutPk(row, pk);
      if (Object.keys(patch).length) await d.updateRow(cc, db, table, f, patch);
      restored++;
    } else {
      // Строки уже нет (удалили после правки) — вернуть её можно только вставкой
      // с прежним ключом, а его СУБД могла сгенерировать сама.
      try {
        await d.insertRow(cc, db, table, row);
      } catch (e) {
        throw Object.assign(
          new Error(`Cannot restore the missing row with its original key: ${(e as Error).message.slice(0, 120)}. Use a checkpoint instead`),
          { statusCode: 409 }
        );
      }
      restored++;
    }
  }
  return { restored, skipped };
}

async function removeRows(ctx: ApplyContext, pk: string[], rows: Record<string, unknown>[]): Promise<number> {
  const { d, cc, db, table } = ctx;
  if (!d.deleteRow) throw Object.assign(new Error('Undo is not supported for this database'), { statusCode: 400 });
  let deleted = 0;
  for (const row of rows) deleted += (await d.deleteRow(cc, db, table, pkFilter(row, pk))).deleted;
  return deleted;
}

export interface ApplyResult {
  ok: true;
  id: string;
  op: DataUndoOp;
  direction: 'undo' | 'redo';
  affected: number;
  skipped: string[];
}

/**
 * Применяет обратное (undo) или повторное (redo) действие к записи.
 * redo возможен только после undo — иначе «повтор» не имеет смысла.
 */
export async function applyDataUndo(
  metaPath: string,
  keyHex: string,
  id: string,
  direction: 'undo' | 'redo',
  load: (connId: string) => ConnectionConfig,
  actor?: string | null
): Promise<ApplyResult> {
  const entry = getDataUndo(metaPath, id);
  if (entry.blocked) {
    throw Object.assign(new Error(`Undo unavailable: ${entry.summary}`), { statusCode: 409 });
  }
  if (direction === 'undo' && entry.undone) {
    throw Object.assign(new Error('Already undone — use redo'), { statusCode: 409 });
  }
  if (direction === 'redo' && !entry.undone) {
    throw Object.assign(new Error('Nothing to redo: undo was not applied'), { statusCode: 409 });
  }
  const cc = load(entry.connId);
  assertNotReadOnly(cc);
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
  const pk: string[] = JSON.parse(entry.pkJson) as string[];
  if (!pk.length) throw Object.assign(new Error('Undo unavailable: no primary key'), { statusCode: 409 });
  const before = JSON.parse(entry.beforeJson) as Record<string, unknown>[];
  const after = JSON.parse(entry.afterJson) as Record<string, unknown>[];
  const ctx: ApplyContext = { metaPath, cc, d, db: entry.dbName, table: entry.tableName };
  const t0 = Date.now();

  // К откату «удаления» идут строки, которых в таблице уже нет, — их надо вставить.
  const insertsRows = (entry.op === 'delete' && direction === 'undo')
    || (entry.op === 'insert' && direction === 'redo');
  if (insertsRows && cc.kind === 'postgres') {
    const schema = await d.getSchema(cc, entry.dbName, entry.tableName).catch(() => null);
    // identity-колонка (ALWAYS/BY DEFAULT) не примет явное значение — только serial
    const identity = schema?.columns.filter((c) => c.primary && c.autoInc && c.extra).map((c) => c.name) ?? [];
    if (identity.length) {
      throw Object.assign(
        new Error('PostgreSQL: restoring rows would regenerate identity keys — use a checkpoint instead'),
        { statusCode: 409 }
      );
    }
  }

  let affected = 0;
  let skipped: string[] = [];
  if (entry.op === 'insert') {
    // откат вставки = удалить добавленную строку; повтор = вставить её заново
    if (direction === 'undo') affected = await removeRows(ctx, pk, after);
    else affected = (await restoreRows(ctx, pk, after)).restored;
  } else if (entry.op === 'delete') {
    if (direction === 'undo') ({ restored: affected, skipped } = await restoreRows(ctx, pk, before));
    else affected = await removeRows(ctx, pk, before);
  } else {
    const target = direction === 'undo' ? before : after;
    ({ restored: affected, skipped } = await restoreRows(ctx, pk, target));
  }

  openDataUndoMeta(metaPath).prepare(`UPDATE data_undo SET undone=? WHERE id=?`)
    .run(direction === 'undo' ? 1 : 0, id);
  audit(metaPath, entry.connId, `data.${direction}`, `${entry.dbName}.${entry.tableName}:${affected}r`, true, Date.now() - t0, actor);
  return { ok: true, id, op: entry.op, direction, affected, skipped };
}

export { MAX_ROWS, MAX_BYTES };
