import { randomUUID } from 'node:crypto';
import { openMeta } from './store.js';

export interface HistoryEntry {
  id: string;
  connId: string | null;
  userId: string | null;
  username: string | null;
  db: string | null;
  sql: string;
  name: string | null;
  saved: number;
  /** В БД хранится 0/1, наружу (API/UI) отдаётся как boolean. */
  ok: boolean;
  execMs: number;
  at: number;
}

interface HistoryRow {
  id: string;
  connId: string | null;
  userId: string | null;
  username: string | null;
  db: string | null;
  sql: string;
  name: string | null;
  saved: number;
  ok: number;
  execMs: number;
  at: number;
}

function toEntry(row: HistoryRow): HistoryEntry {
  return { ...row, ok: Boolean(row.ok) };
}

export function ensureHistoryTable(metaPath: string): void {
  openMeta(metaPath).exec(`
    CREATE TABLE IF NOT EXISTS query_history (
      id TEXT PRIMARY KEY,
      connId TEXT,
      userId TEXT,
      username TEXT,
      db TEXT,
      sql TEXT NOT NULL,
      name TEXT,
      saved INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL,
      execMs INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qh_conn ON query_history(connId, at DESC);
    CREATE INDEX IF NOT EXISTS idx_qh_user ON query_history(userId, saved, at DESC);
  `);
}

export function addHistory(
  metaPath: string,
  entry: { connId: string | null; userId: string | null; username: string | null; db: string | null; sql: string; ok: boolean; execMs: number; name?: string | null; saved?: boolean }
): HistoryEntry {
  ensureHistoryTable(metaPath);
  const id = randomUUID();
  const now = Date.now();
  // авто-чистка: держать 500 последних на conn, и 200 несaved на user
  const meta = openMeta(metaPath);
  meta.prepare(
    `INSERT INTO query_history (id,connId,userId,username,db,sql,name,saved,ok,execMs,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, entry.connId, entry.userId, entry.username, entry.db, entry.sql.slice(0, 10000), entry.name ?? null, entry.saved ? 1 : 0, entry.ok ? 1 : 0, entry.execMs, now);
  // retention: если несaved — держать 200 на юзера
  if (!entry.saved && entry.userId) {
    const olds = meta.prepare(`SELECT id FROM query_history WHERE userId=? AND saved=0 ORDER BY at DESC LIMIT -1 OFFSET 200`).all(entry.userId) as { id: string }[];
    for (const o of olds) meta.prepare(`DELETE FROM query_history WHERE id=?`).run(o.id);
  }
  return { id, connId: entry.connId, userId: entry.userId, username: entry.username, db: entry.db, sql: entry.sql.slice(0, 10000), name: entry.name ?? null, saved: entry.saved ? 1 : 0, ok: entry.ok, execMs: entry.execMs, at: now };
}

export function listHistory(
  metaPath: string,
  filter: { connId?: string; userId?: string; savedOnly?: boolean; limit?: number; q?: string }
): HistoryEntry[] {
  ensureHistoryTable(metaPath);
  const lim = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 200);
  let sql = `SELECT * FROM query_history WHERE 1=1`;
  const params: unknown[] = [];
  if (filter.connId) { sql += ` AND connId=?`; params.push(filter.connId); }
  if (filter.userId) { sql += ` AND userId=?`; params.push(filter.userId); }
  if (filter.savedOnly) sql += ` AND saved=1`;
  if (filter.q) { sql += ` AND (sql LIKE ? OR name LIKE ?)`; const pat = `%${filter.q}%`; params.push(pat, pat); }
  sql += ` ORDER BY at DESC LIMIT ?`;
  params.push(lim);
  return (openMeta(metaPath).prepare(sql).all(...params) as HistoryRow[]).map(toEntry);
}

export function patchHistory(metaPath: string, id: string, userId: string, patch: { saved?: boolean; name?: string | null }): HistoryEntry | null {
  ensureHistoryTable(metaPath);
  const cur = openMeta(metaPath).prepare(`SELECT * FROM query_history WHERE id=?`).get(id) as HistoryRow | undefined;
  if (!cur) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  if (cur.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  const saved = patch.saved === undefined ? cur.saved : patch.saved ? 1 : 0;
  const name = patch.name === undefined ? cur.name : patch.name;
  if (name !== null && name !== undefined && String(name).length > 100) throw Object.assign(new Error('Name too long'), { statusCode: 400 });
  openMeta(metaPath).prepare(`UPDATE query_history SET saved=?, name=? WHERE id=?`).run(saved, name, id);
  return toEntry(openMeta(metaPath).prepare(`SELECT * FROM query_history WHERE id=?`).get(id) as HistoryRow);
}

export function deleteHistory(metaPath: string, id: string, userId: string): void {
  ensureHistoryTable(metaPath);
  const cur = openMeta(metaPath).prepare(`SELECT * FROM query_history WHERE id=?`).get(id) as HistoryRow | undefined;
  if (!cur) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  if (cur.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  openMeta(metaPath).prepare(`DELETE FROM query_history WHERE id=?`).run(id);
}

/**
 * Массовая очистка журнала запросов.
 * scope=mine — только свои записи (любая роль), scope=all — весь журнал (admin).
 * scope=saved — только сохранённые запросы (admin): их стирают отдельно, чтобы
 * не потерять «мои запросы» вместе с черновиками.
 */
export function clearHistory(metaPath: string, filter: { scope: 'all' | 'mine' | 'saved'; userId: string; connId?: string }): number {
  ensureHistoryTable(metaPath);
  const meta = openMeta(metaPath);
  if (filter.scope === 'saved') {
    const r = meta.prepare(`DELETE FROM query_history WHERE saved=1${filter.connId ? ' AND connId=?' : ''}`).run(...(filter.connId ? [filter.connId] : []));
    return r.changes;
  }
  if (filter.scope === 'mine') {
    const r = meta.prepare(`DELETE FROM query_history WHERE userId=?${filter.connId ? ' AND connId=?' : ''}`).run(...(filter.connId ? [filter.userId, filter.connId] : [filter.userId]));
    return r.changes;
  }
  const r = meta.prepare(`DELETE FROM query_history${filter.connId ? ' WHERE connId=?' : ''}`).run(...(filter.connId ? [filter.connId] : []));
  return r.changes;
}
