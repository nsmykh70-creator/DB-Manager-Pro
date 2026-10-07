import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { assertNotReadOnly } from './types.js';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDriver } from '../plugins/registry.js';
import { openMeta } from './store.js';
import { loadDecrypted, audit } from './context.js';
import { renderDb, toStream, assertDumpRestorable } from './dump.js';

export interface Schedule {
  id: string; connId: string; db: string; format: 'sql' | 'json';
  intervalMin: number; keepLast: number; enabled: number;
  lastRunAt: number | null; nextRunAt: number; createdAt: number;
}

export interface Run {
  id: string; scheduleId: string; connId: string; file: string;
  bytes: number; tables: number; ok: number; error: string | null; at: number;
}

export function backupDir(metaPath: string): string {
  const dir = join(dirname(metaPath), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureBackupTables(metaPath: string): void {
  openMeta(metaPath).exec(`
    CREATE TABLE IF NOT EXISTS backup_schedules (
      id TEXT PRIMARY KEY, connId TEXT NOT NULL, db TEXT NOT NULL, format TEXT NOT NULL,
      intervalMin INTEGER NOT NULL, keepLast INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      lastRunAt INTEGER, nextRunAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_runs (
      id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL, connId TEXT NOT NULL, file TEXT NOT NULL,
      bytes INTEGER NOT NULL, tables INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL
    );
  `);
}

export function listSchedules(metaPath: string, connId?: string): Schedule[] {
  ensureBackupTables(metaPath);
  const db = openMeta(metaPath);
  const rows = connId
    ? db.prepare(`SELECT * FROM backup_schedules WHERE connId=? ORDER BY createdAt DESC`).all(connId)
    : db.prepare(`SELECT * FROM backup_schedules ORDER BY createdAt DESC`).all();
  return rows as Schedule[];
}

export function createSchedule(metaPath: string, connId: string, keyHex: string, input: { db: string; format: string; intervalMin: number; keepLast: number }): Schedule {
  ensureBackupTables(metaPath);
  const cc = loadDecrypted(metaPath, keyHex, connId); // 404 если нет
  const format = input.format === 'json' ? 'json' : 'sql';
  if (cc.kind === 'mongodb' && format === 'sql') throw Object.assign(new Error('MongoDB supports json backups only'), { statusCode: 400 });
  // Redis: дамп собрать можно, восстановить — нет. Отказываем сразу, чтобы
  // не плодить копии, которые нельзя вернуть в базу.
  assertDumpRestorable(cc.kind);
  const intervalMin = Math.min(43200, Math.max(5, Math.floor(Number(input.intervalMin) || 1440)));
  const keepLast = Math.min(50, Math.max(1, Math.floor(Number(input.keepLast) || 7)));
  const now = Date.now();
  const s: Schedule = {
    id: randomUUID(), connId, db: input.db || cc.database || 'main', format,
    intervalMin, keepLast, enabled: 1, lastRunAt: null, nextRunAt: now + intervalMin * 60000, createdAt: now
  };
  openMeta(metaPath).prepare(
    `INSERT INTO backup_schedules (id,connId,db,format,intervalMin,keepLast,enabled,lastRunAt,nextRunAt,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(s.id, s.connId, s.db, s.format, s.intervalMin, s.keepLast, s.enabled, s.lastRunAt, s.nextRunAt, s.createdAt);
  return s;
}

export function patchSchedule(metaPath: string, id: string, p: { enabled?: boolean; intervalMin?: number; keepLast?: number }): Schedule {
  ensureBackupTables(metaPath);
  const db = openMeta(metaPath);
  const cur = db.prepare(`SELECT * FROM backup_schedules WHERE id=?`).get(id) as Schedule | undefined;
  if (!cur) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
  const enabled = p.enabled === undefined ? cur.enabled : p.enabled ? 1 : 0;
  const intervalMin = p.intervalMin === undefined ? cur.intervalMin : Math.min(43200, Math.max(5, Math.floor(p.intervalMin)));
  const keepLast = p.keepLast === undefined ? cur.keepLast : Math.min(50, Math.max(1, Math.floor(p.keepLast)));
  const nextRunAt = intervalMin !== cur.intervalMin ? Date.now() + intervalMin * 60000 : cur.nextRunAt;
  db.prepare(`UPDATE backup_schedules SET enabled=?, intervalMin=?, keepLast=?, nextRunAt=? WHERE id=?`).run(enabled, intervalMin, keepLast, nextRunAt, id);
  return { ...cur, enabled, intervalMin, keepLast, nextRunAt };
}

export function deleteSchedule(metaPath: string, id: string): void {
  ensureBackupTables(metaPath);
  openMeta(metaPath).prepare(`DELETE FROM backup_schedules WHERE id=?`).run(id);
  // файлы запусков чистим тоже
  const dir = backupDir(metaPath);
  for (const f of readdirSync(dir)) {
    if (f.startsWith(id + '_')) rmSync(join(dir, f), { force: true });
  }
  openMeta(metaPath).prepare(`DELETE FROM backup_runs WHERE scheduleId=?`).run(id);
}

export function listRuns(metaPath: string, scheduleId?: string, limit = 50): Run[] {
  ensureBackupTables(metaPath);
  const db = openMeta(metaPath);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  if (scheduleId) return db.prepare(`SELECT * FROM backup_runs WHERE scheduleId=? ORDER BY at DESC LIMIT ?`).all(scheduleId, lim) as Run[];
  return db.prepare(`SELECT * FROM backup_runs ORDER BY at DESC LIMIT ?`).all(lim) as Run[];
}

/** Выполнить бэкап расписания в файл. Возвращает запись запуска. */
export async function runBackup(metaPath: string, keyHex: string, scheduleId: string, actor?: string | null): Promise<Run> {
  ensureBackupTables(metaPath);
  const meta = openMeta(metaPath);
  const s = meta.prepare(`SELECT * FROM backup_schedules WHERE id=?`).get(scheduleId) as Schedule | undefined;
  if (!s) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
  const cc = loadDecrypted(metaPath, keyHex, s.connId);
  if (cc.kind === 'mongodb' && s.format === 'sql') throw Object.assign(new Error('MongoDB supports json backups only'), { statusCode: 400 });
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });

  const runId = randomUUID();
  const ext = s.format === 'json' ? 'json' : 'sql';
  const file = `${s.id}_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  const full = join(backupDir(metaPath), file);
  const t0 = Date.now();
  const fail = (msg: string): Run => {
    const r: Run = { id: runId, scheduleId: s.id, connId: s.connId, file, bytes: 0, tables: 0, ok: 0, error: msg.slice(0, 500), at: Date.now() };
    meta.prepare(`INSERT INTO backup_runs (id,scheduleId,connId,file,bytes,tables,ok,error,at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.scheduleId, r.connId, r.file, r.bytes, r.tables, r.ok, r.error, r.at);
    meta.prepare(`UPDATE backup_schedules SET lastRunAt=? WHERE id=?`).run(Date.now(), s.id);
    audit(metaPath, s.connId, 'backup', `${s.db}:${r.error}`, false, Date.now() - t0, actor);
    return r;
  };

  try {
    const tables = await d.listTables(cc, s.db);
    await pipeline(toStream(renderDb(s.format, d, cc, s.db, tables)), createWriteStream(full));
    const bytes = statSync(full).size;
    const now = Date.now();
    meta.prepare(`UPDATE backup_schedules SET lastRunAt=?, nextRunAt=? WHERE id=?`).run(now, now + s.intervalMin * 60000, s.id);
    const r: Run = { id: runId, scheduleId: s.id, connId: s.connId, file, bytes, tables: tables.length, ok: 1, error: null, at: now };
    meta.prepare(`INSERT INTO backup_runs (id,scheduleId,connId,file,bytes,tables,ok,error,at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.scheduleId, r.connId, r.file, r.bytes, r.tables, r.ok, r.error, r.at);
    // retention
    const olds = meta.prepare(`SELECT * FROM backup_runs WHERE scheduleId=? AND ok=1 ORDER BY at DESC`).all(s.id) as Run[];
    for (const o of olds.slice(s.keepLast)) {
      rmSync(join(backupDir(metaPath), o.file), { force: true });
      meta.prepare(`DELETE FROM backup_runs WHERE id=?`).run(o.id);
    }
    audit(metaPath, s.connId, 'backup', `${s.db}:${tables.length}t/${bytes}b`, true, Date.now() - t0, actor);
    return r;
  } catch (e) {
    rmSync(full, { force: true });
    return fail(String((e as Error).message));
  }
}

export function runFile(metaPath: string, runId: string): { full: string; run: Run } {
  ensureBackupTables(metaPath);
  const r = openMeta(metaPath).prepare(`SELECT * FROM backup_runs WHERE id=?`).get(runId) as Run | undefined;
  if (!r) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
  const full = join(backupDir(metaPath), r.file);
  if (!existsSync(full)) throw Object.assign(new Error('Backup file missing'), { statusCode: 410 });
  return { full, run: r };
}

/** Восстановить запуск: сначала CLEAR таблиц (идемпотентно, без PK-дубликатов), затем данные.
 *  sql — таблицы извлекаем из INSERT INTO (дамп наш, формат известен); json — ключи объекта. */
export async function restoreRun(metaPath: string, keyHex: string, runId: string, actor?: string | null): Promise<{ tables: number }> {
  const { full, run } = runFile(metaPath, runId);
  const meta = openMeta(metaPath);
  const s = meta.prepare(`SELECT * FROM backup_schedules WHERE id=?`).get(run.scheduleId) as Schedule | undefined;
  const cc = loadDecrypted(metaPath, keyHex, run.connId);
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
  if (!d.clearTable) throw Object.assign(new Error(`Restore not supported for ${cc.kind}`), { statusCode: 400 });
  assertNotReadOnly(cc);
  const dbname = s?.db ?? cc.database ?? 'main';
  const t0 = Date.now();
  try {
    if (run.file.endsWith('.json')) {
      if (!d.importRows) throw Object.assign(new Error(`Restore not supported for ${cc.kind}`), { statusCode: 400 });
      const { readFileSync } = await import('node:fs');
      const data = JSON.parse(readFileSync(full, 'utf8')) as Record<string, Record<string, unknown>[]>;
      let n = 0;
      for (const [t, rows] of Object.entries(data)) {
        if (Array.isArray(rows) && rows.length) {
          await d.clearTable(cc, dbname, t);
          await d.importRows(cc, dbname, t, rows);
          n++;
        }
      }
      audit(metaPath, run.connId, 'restore', `${run.file}:${n}t`, true, Date.now() - t0, actor);
      return { tables: n };
    }
    if (!d.execScript) throw Object.assign(new Error(`Restore not supported for ${cc.kind}`), { statusCode: 400 });
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(full, 'utf8');
    if (text.length > 100_000_000) throw Object.assign(new Error('Dump too large to restore (100MB)'), { statusCode: 413 });
    const tables = [...new Set([...text.matchAll(/INSERT INTO\s*[`["']?([A-Za-z0-9_]+)[`\]"']?/gi)].map((m) => m[1]))];
    for (const t of tables) await d.clearTable(cc, dbname, t);
    await d.execScript(cc, dbname, text);
    audit(metaPath, run.connId, 'restore', `${run.file}:${tables.length}t`, true, Date.now() - t0, actor);
    return { tables: tables.length };
  } catch (e) {
    audit(metaPath, run.connId, 'restore', `${run.file}:${String((e as Error).message).slice(0, 150)}`, false, Date.now() - t0, actor);
    throw e;
  }
}

/** Планировщик: каждые 30с запускает просроченные enabled-расписания. */
export function startScheduler(metaPath: string, keyHex: string, log: { error(e: unknown): void }): () => void {
  ensureBackupTables(metaPath);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      try {
        const due = openMeta(metaPath).prepare(`SELECT * FROM backup_schedules WHERE enabled=1 AND nextRunAt<=?`).all(Date.now()) as Schedule[];
        for (const s of due) {
          try {
            await runBackup(metaPath, keyHex, s.id, 'scheduler');
          } catch (e) {
            log.error(e);
          }
        }
      } catch (e) {
        log.error(e);
      } finally {
        busy = false;
      }
    })();
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
