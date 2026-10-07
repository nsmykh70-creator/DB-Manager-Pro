import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectionConfig } from './types.js';

let db: Database.Database | null = null;

export function openMeta(metaPath: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(metaPath), { recursive: true });
  db = new Database(metaPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      host TEXT, port INTEGER, databaseName TEXT, userName TEXT,
      passwordCipher TEXT, filePath TEXT, readOnly INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connId TEXT, action TEXT NOT NULL,
      target TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      passHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor',
      createdAt INTEGER NOT NULL, mustChange INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS design_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connId TEXT NOT NULL,
      dbName TEXT NOT NULL, tableName TEXT NOT NULL,
      opsJson TEXT NOT NULL, statementsJson TEXT NOT NULL,
      linesBefore TEXT NOT NULL, ddlBefore TEXT,
      actor TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_snapshots ON design_snapshots(connId, dbName, tableName, at DESC);
  `);
  // Миграции для существующих meta.db: CREATE TABLE IF NOT EXISTS не добавляет
  // колонки в уже созданную таблицу.
  const cols = db.prepare(`PRAGMA table_info(connections)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'databaseName')) db.exec(`ALTER TABLE connections ADD COLUMN databaseName TEXT`);
  const auditCols = db.prepare(`PRAGMA table_info(audit)`).all() as { name: string }[];
  if (!auditCols.some((c) => c.name === 'actor')) db.exec(`ALTER TABLE audit ADD COLUMN actor TEXT`);
  // Значения правок строк в аудите (before/after)
  if (!auditCols.some((c) => c.name === 'valuesJson')) db.exec(`ALTER TABLE audit ADD COLUMN valuesJson TEXT`);
  // Флаг обязательной смены пароля (дефолтные admin/admin при первом входе)
  const userCols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'mustChange')) db.exec(`ALTER TABLE users ADD COLUMN mustChange INTEGER NOT NULL DEFAULT 0`);
  return db;
}

export function rowToCfg(r: Record<string, unknown>): ConnectionConfig {
  return {
    id: String(r.id), name: String(r.name), kind: r.kind as ConnectionConfig['kind'],
    host: (r.host as string) ?? undefined, port: (r.port as number) ?? undefined,
    database: (r.databaseName as string) ?? undefined, user: (r.userName as string) ?? undefined,
    passwordCipher: (r.passwordCipher as string) ?? undefined,
    filePath: (r.filePath as string) ?? undefined, readOnly: Boolean(r.readOnly)
  };
}
