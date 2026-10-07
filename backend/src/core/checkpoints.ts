import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { assertNotReadOnly } from './types.js';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDriver } from '../plugins/registry.js';
import { openMeta } from './store.js';
import { loadDecrypted, audit } from './context.js';
import { renderTable, toStream, assertDumpRestorable } from './dump.js';
import type { DbKind } from './types.js';

export interface Checkpoint {
  id: string;
  connId: string;
  dbName: string;
  tableName: string;
  /** Человекочитаемая причина: «drop table», «drop column», «manual». */
  reason: string;
  file: string;
  format: 'sql' | 'json';
  bytes: number;
  rows: number;
  /** DDL таблицы на момент точки — чтобы восстановить структуру целиком. */
  ddl: string | null;
  actor: string | null;
  at: number;
}

/** Сколько точек держим на таблицу: старые файлы удаляются вместе с записями. */
const KEEP_PER_TABLE = 20;
/** Дамп больше 50 МБ не сохраняем: это уже задача бэкапов по расписанию. */
const MAX_BYTES = 50 * 1024 * 1024;

export function checkpointDir(metaPath: string): string {
  const dir = join(dirname(metaPath), 'checkpoints');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureCheckpointTables(metaPath: string): void {
  openMeta(metaPath).exec(`
    CREATE TABLE IF NOT EXISTS table_checkpoints (
      id TEXT PRIMARY KEY, connId TEXT NOT NULL, dbName TEXT NOT NULL, tableName TEXT NOT NULL,
      reason TEXT NOT NULL, file TEXT NOT NULL, format TEXT NOT NULL,
      bytes INTEGER NOT NULL, rows INTEGER NOT NULL, ddl TEXT,
      actor TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_table_checkpoints ON table_checkpoints(connId, dbName, tableName, at DESC);
  `);
}

export function listCheckpoints(metaPath: string, connId: string, dbName?: string, tableName?: string, limit = 50): Checkpoint[] {
  ensureCheckpointTables(metaPath);
  const db = openMeta(metaPath);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  if (dbName && tableName) {
    return db.prepare(`SELECT * FROM table_checkpoints WHERE connId=? AND dbName=? AND tableName=? ORDER BY at DESC LIMIT ?`)
      .all(connId, dbName, tableName, lim) as Checkpoint[];
  }
  return db.prepare(`SELECT * FROM table_checkpoints WHERE connId=? ORDER BY at DESC LIMIT ?`).all(connId, lim) as Checkpoint[];
}

function prune(metaPath: string, connId: string, dbName: string, tableName: string): void {
  const meta = openMeta(metaPath);
  const olds = meta
    .prepare(`SELECT * FROM table_checkpoints WHERE connId=? AND dbName=? AND tableName=? ORDER BY at DESC`)
    .all(connId, dbName, tableName) as Checkpoint[];
  for (const old of olds.slice(KEEP_PER_TABLE)) {
    rmSync(join(checkpointDir(metaPath), old.file), { force: true });
    meta.prepare(`DELETE FROM table_checkpoints WHERE id=?`).run(old.id);
  }
}

/**
 * Точка восстановления одной таблицы: DDL + все строки в SQL-дампе.
 * Отличается от бэкапа по расписанию тем, что снимается по требованию и
 * автоматически перед разрушительным DDL, а не по таймеру.
 */
export async function createCheckpoint(
  metaPath: string,
  keyHex: string,
  input: { connId: string; db: string; table: string; reason: string; actor?: string | null; ddl?: string | null }
): Promise<Checkpoint> {
  ensureCheckpointTables(metaPath);
  const cc = loadDecrypted(metaPath, keyHex, input.connId);
  assertNotReadOnly(cc);
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
  // SQL-дамп поддерживают только реляционные; MongoDB — json. Redis не попадает
  // ни в один вариант: дамп из его псевдотаблицы восстановить нечем.
  assertDumpRestorable(cc.kind);
  const format: 'sql' | 'json' = cc.kind === 'mongodb' ? 'json' : 'sql';
  const id = randomUUID();
  const file = `${input.connId}_${input.db}_${input.table}_${new Date().toISOString().replace(/[:.]/g, '-')}_${id.slice(0, 8)}.${format}`;
  const full = join(checkpointDir(metaPath), file);
  const t0 = Date.now();
  let rows = 0;
  try {
    const source = renderTable(format, d, cc, input.db, input.table);
    const counting = (async function* () {
      for await (const chunk of source) {
        rows += (chunk.match(/INSERT INTO /g) ?? []).length;
        yield chunk;
      }
    })();
    await pipeline(toStream(counting), createWriteStream(full));
    const bytes = statSync(full).size;
    if (bytes > MAX_BYTES) throw Object.assign(new Error(`Table dump is too large to checkpoint (${Math.round(MAX_BYTES / 1024 / 1024)}MB): use scheduled backups`), { statusCode: 413 });
    // В SQL-дампе строки считаются по INSERT INTO, в JSON их нет — считаем
    // разобранный документ. renderTable для json кладёт ПЛОСКИЙ массив документов
    // (у renderDb — объект {"table":[...]}), поэтому принимаем обе формы.
    if (format === 'json') {
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
        if (Array.isArray(parsed)) {
          rows = parsed.length;
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[input.table])) {
          rows = ((parsed as Record<string, unknown>)[input.table] as unknown[]).length;
        } else {
          rows = 0;
        }
      } catch {
        rows = 0;
      }
    }
    const cp: Checkpoint = {
      id, connId: input.connId, dbName: input.db, tableName: input.table, reason: input.reason,
      file, format, bytes, rows, ddl: input.ddl ?? null, actor: input.actor ?? null, at: Date.now(),
    };
    openMeta(metaPath).prepare(
      `INSERT INTO table_checkpoints (id,connId,dbName,tableName,reason,file,format,bytes,rows,ddl,actor,at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(cp.id, cp.connId, cp.dbName, cp.tableName, cp.reason, cp.file, cp.format, cp.bytes, cp.rows, cp.ddl, cp.actor, cp.at);
    prune(metaPath, input.connId, input.db, input.table);
    audit(metaPath, input.connId, 'checkpoint', `${input.db}.${input.table}:${rows}r/${bytes}b`, true, Date.now() - t0, input.actor);
    return cp;
  } catch (e) {
    rmSync(full, { force: true });
    audit(metaPath, input.connId, 'checkpoint', `${input.db}.${input.table}:${String((e as Error).message).slice(0, 150)}`, false, Date.now() - t0, input.actor);
    throw e;
  }
}

export function getCheckpoint(metaPath: string, id: string): Checkpoint {
  ensureCheckpointTables(metaPath);
  const cp = openMeta(metaPath).prepare(`SELECT * FROM table_checkpoints WHERE id=?`).get(id) as Checkpoint | undefined;
  if (!cp) throw Object.assign(new Error('Checkpoint not found'), { statusCode: 404 });
  return cp;
}

export function deleteCheckpoint(metaPath: string, id: string): void {
  const cp = getCheckpoint(metaPath, id);
  rmSync(join(checkpointDir(metaPath), cp.file), { force: true });
  openMeta(metaPath).prepare(`DELETE FROM table_checkpoints WHERE id=?`).run(id);
}

/**
 * Восстановление таблицы из точки. Действующая таблица по умолчанию
 * пересоздаётся: данные после точки восстановить иначе нельзя, поэтому
 * операция требует явного подтверждения (dropExisting) и правки записи.
 */
export async function restoreCheckpoint(
  metaPath: string,
  keyHex: string,
  id: string,
  opts: { dropExisting: boolean; actor?: string | null }
): Promise<{ rows: number; recreated: boolean; skipped?: string[] }> {
  const cp = getCheckpoint(metaPath, id);
  const full = join(checkpointDir(metaPath), cp.file);
  if (!existsSync(full)) throw Object.assign(new Error('Checkpoint file is missing'), { statusCode: 410 });
  const meta = openMeta(metaPath);
  const cc = loadDecrypted(metaPath, keyHex, cp.connId);
  assertNotReadOnly(cc);
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
  const t0 = Date.now();
  const kind: DbKind = cc.kind;
  try {
    let recreated = false;
    const tables = await d.listTables(cc, cp.dbName);
    const existsNow = tables.includes(cp.tableName);
    if (existsNow) {
      if (!opts.dropExisting) {
        throw Object.assign(new Error('Table exists: pass dropExisting=1 to replace it with the checkpoint version'), { statusCode: 409 });
      }
      if (cp.format === 'json') {
        if (!d.clearTable) throw Object.assign(new Error(`Restore is not supported for ${kind}`), { statusCode: 400 });
        await d.clearTable(cc, cp.dbName, cp.tableName);
      } else {
        if (!d.dropTable) throw Object.assign(new Error(`Restore is not supported for ${kind}`), { statusCode: 400 });
        // Порядок важен: сначала таблица (внешние ключи могут ссылаться на неё),
        // поэтому ограничения внешних ключей отключаем на время восстановления.
        await d.dropTable(cc, cp.dbName, cp.tableName);
        recreated = true;
      }
    }
    if (cp.format === 'json') {
      if (!d.importRows) throw Object.assign(new Error(`Restore is not supported for ${kind}`), { statusCode: 400 });
      // Форма дампа таблицы — плоский массив документов; объект {"table":[...]}
      // использует только renderDb (dump всей БД). Принимаем обе.
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
      const rows: Record<string, unknown>[] = Array.isArray(parsed)
        ? (parsed as Record<string, unknown>[])
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[cp.tableName])
          ? ((parsed as Record<string, unknown>)[cp.tableName] as Record<string, unknown>[])
          : [];
      if (rows.length) await d.importRows(cc, cp.dbName, cp.tableName, rows, { keepIds: true });
      audit(metaPath, cp.connId, 'checkpoint.restore', `${cp.dbName}.${cp.tableName}:${rows.length}r`, true, Date.now() - t0, opts.actor);
      return { rows: rows.length, recreated };
    }
    if (!d.execScript) throw Object.assign(new Error(`Restore is not supported for ${kind}`), { statusCode: 400 });
    const text = readFileSync(full, 'utf8');
    if (text.length > MAX_BYTES) throw Object.assign(new Error('Checkpoint dump is too large to restore'), { statusCode: 413 });
    const r = await d.execScript(cc, cp.dbName, text);
    audit(metaPath, cp.connId, 'checkpoint.restore', `${cp.dbName}.${cp.tableName}:${r.statements}st`, true, Date.now() - t0, opts.actor);
    return { rows: cp.rows, recreated };
  } catch (e) {
    audit(metaPath, cp.connId, 'checkpoint.restore', `${cp.dbName}.${cp.tableName}:${String((e as Error).message).slice(0, 150)}`, false, Date.now() - t0, opts.actor);
    throw e;
  }
}

/** Удалить файлы точек, чьих записей больше нет (страховка от осиротевших дампов). */
export function sweepCheckpointFiles(metaPath: string): void {
  if (!existsSync(checkpointDir(metaPath))) return;
  ensureCheckpointTables(metaPath);
  // Без фильтра по подключению: иначе «чужие» файлы считались бы лишними.
  const known = new Set((openMeta(metaPath).prepare(`SELECT file FROM table_checkpoints`).all() as { file: string }[]).map((r) => r.file));
  for (const f of readdirSync(checkpointDir(metaPath))) {
    if (!known.has(f)) rmSync(join(checkpointDir(metaPath), f), { force: true });
  }
}
