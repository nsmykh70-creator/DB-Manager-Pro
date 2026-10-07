import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import type { ConnectionConfig, DbKind } from './types.js';
import { decrypt, encrypt } from './crypto.js';
import { openMeta, rowToCfg } from './store.js';

export interface ConnectionInput {
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filePath?: string;
  readOnly?: boolean;
}

/**
 * Валидирует и нормализует путь к файлу SQLite.
 *
 * На POSIX обратный слэш — не разделитель, а часть имени файла. Путь вида
 * `C:\data\db.sqlite` раньше сохранялся как есть, resolve() склеивал его с
 * dirname(META_PATH), и драйвер создавал мусорный файл `/data/C:\data\db.sqlite`,
 * а запросы падали с «no such table». Поэтому на POSIX это понятный 400,
 * на Windows — тихая нормализация в прямые слэши (Windows их принимает).
 */
export function normalizeSqlitePath(input: unknown): string {
  const filePath = String(input ?? '').trim();
  if (!filePath) throw Object.assign(new Error('filePath required for sqlite'), { statusCode: 400 });
  if (filePath.includes('\0')) throw Object.assign(new Error('filePath contains a NUL byte'), { statusCode: 400 });
  if (!filePath.includes('\\')) return filePath;
  if (sep === '/') {
    throw Object.assign(new Error('filePath must use forward slashes on this platform: backslashes would become part of the file name'), { statusCode: 400 });
  }
  return filePath.replaceAll('\\', '/');
}

export function listConnections(metaPath: string): ConnectionConfig[] {
  const db = openMeta(metaPath);
  const rows = db.prepare(`SELECT * FROM connections ORDER BY createdAt DESC`).all() as Record<string, unknown>[];
  return rows.map((r) => ({ ...rowToCfg(r), passwordCipher: undefined }));
}

export function ensureSqliteFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, 'a');
  closeSync(fd);
}

export function createConnection(metaPath: string, keyHex: string, input: ConnectionInput): ConnectionConfig {
  if (!['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'].includes(input.kind)) {
    throw Object.assign(new Error('Unknown kind'), { statusCode: 400 });
  }
  // Валидация в одном месте (defence in depth): маршруты тоже проверяют, но
  // запись в meta.db не должна зависеть от того, откуда пришёл вызов.
  const filePath = input.kind === 'sqlite' ? normalizeSqlitePath(input.filePath) : input.filePath;
  const db = openMeta(metaPath);
  const id = randomUUID();
  db.prepare(`INSERT INTO connections (id,name,kind,host,port,databaseName,userName,passwordCipher,filePath,readOnly,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.kind, input.host ?? null, input.port ?? null, input.database ?? null,
    input.user ?? null, input.password ? encrypt(input.password, keyHex) : null,
    filePath ?? null, input.readOnly ? 1 : 0, Date.now()
  );
  return { id, name: input.name, kind: input.kind, host: input.host, port: input.port, database: input.database, user: input.user, filePath, readOnly: input.readOnly };
}

export interface DesignSnapshot {
  id: number;
  connId: string;
  dbName: string;
  tableName: string;
  ops: unknown[];
  statements: string[];
  /** Плоское описание схемы «до»: колонки, индексы, FK, триггеры. */
  linesBefore: string[];
  /** CREATE TABLE со всем DDL «до» — для ручного восстановления. */
  ddlBefore: string | null;
  actor: string | null;
  at: number;
}

/**
 * Снапшот структуры перед DDL-пакетом. Основа отката: индексы, внешние ключи
 * и триггеры восстанавливаются автоматически, а для изменений колонок
 * остаётся DDL «до» — данные такой откат не вернёт.
 */
export function saveDesignSnapshot(
  metaPath: string,
  snap: { connId: string; dbName: string; tableName: string; ops: unknown[]; statements: string[]; linesBefore: string[]; ddlBefore: string | null; actor?: string }
): void {
  const db = openMeta(metaPath);
  db.prepare(`INSERT INTO design_snapshots (connId, dbName, tableName, opsJson, statementsJson, linesBefore, ddlBefore, actor, at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    snap.connId, snap.dbName, snap.tableName,
    JSON.stringify(snap.ops), JSON.stringify(snap.statements),
    JSON.stringify(snap.linesBefore), snap.ddlBefore, snap.actor ?? null, Date.now()
  );
  // Храним только последний снапшот на таблицу: иначе история растёт без
  // пользы, а откат всё равно делается от последнего пакета.
  db.prepare(`DELETE FROM design_snapshots WHERE connId=? AND dbName=? AND tableName=? AND id NOT IN (
    SELECT id FROM design_snapshots WHERE connId=? AND dbName=? AND tableName=? ORDER BY at DESC, id DESC LIMIT 1
  )`).run(snap.connId, snap.dbName, snap.tableName, snap.connId, snap.dbName, snap.tableName);
}

export function latestDesignSnapshot(metaPath: string, connId: string, dbName: string, tableName: string): DesignSnapshot | null {
  const row = openMeta(metaPath)
    .prepare(`SELECT * FROM design_snapshots WHERE connId=? AND dbName=? AND tableName=? ORDER BY at DESC, id DESC LIMIT 1`)
    .get(connId, dbName, tableName) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parse = (v: unknown): string[] => {
    try { return JSON.parse(String(v ?? '[]')) as string[]; } catch { return []; }
  };
  return {
    id: Number(row.id),
    connId: String(row.connId),
    dbName: String(row.dbName),
    tableName: String(row.tableName),
    ops: JSON.parse(String(row.opsJson ?? '[]')) as unknown[],
    statements: parse(row.statementsJson),
    linesBefore: parse(row.linesBefore),
    ddlBefore: row.ddlBefore === null || row.ddlBefore === undefined ? null : String(row.ddlBefore),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
    at: Number(row.at),
  };
}

export async function deleteConnection(metaPath: string, id: string): Promise<void> {  openMeta(metaPath).prepare(`DELETE FROM connections WHERE id=?`).run(id);
  const { closePoolsFor } = await import('./pool.js');
  await closePoolsFor(id);
}

/** Загрузить конфиг + расшифровать пароль в память (нигде не логировать). */
export function loadDecrypted(metaPath: string, keyHex: string, id: string): ConnectionConfig {
  const db = openMeta(metaPath);
  const r = db.prepare(`SELECT * FROM connections WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!r) throw Object.assign(new Error('Connection not found'), { statusCode: 404 });
  const cfg = rowToCfg(r);
  if (r.passwordCipher) cfg.password = decrypt(String(r.passwordCipher), keyHex);
  // Oracle: поле «база» в подключении — это имя сервиса, и выбранная в
  // интерфейсе схема его затирает. Запоминаем сервис один раз при загрузке,
  // чтобы connect string не зависел от того, какую схему открыл пользователь.
  if (cfg.kind === 'oracle' && !cfg.serviceName && cfg.database) cfg.serviceName = cfg.database;
  return cfg;
}

/**
 * Аудит действий. `values` — что именно изменилось (before/after для строк):
 * без этого в журнале видно только «кто и какую таблицу трогал», но не «что
 * поменялось». Обрезаем по размеру, чтобы запись не раздувала meta.db.
 */
const AUDIT_MAX_KEYS = 30;
const AUDIT_MAX_VALUE = 200;
const AUDIT_MAX_JSON = 8 * 1024;

export interface AuditValues {
  before?: unknown;
  after?: unknown;
  [key: string]: unknown;
}

function clipAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === 'string') return String(value).slice(0, AUDIT_MAX_VALUE);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (depth >= 2) return '…';
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => clipAuditValue(v, depth + 1));
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, AUDIT_MAX_KEYS)) {
      out[k.slice(0, AUDIT_MAX_VALUE)] = clipAuditValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, AUDIT_MAX_VALUE);
}

export function serializeAuditValues(values: unknown): string | null {
  if (values === undefined || values === null) return null;
  try {
    const json = JSON.stringify(clipAuditValue(values));
    if (!json) return null;
    return json.length > AUDIT_MAX_JSON ? JSON.stringify({ truncated: true, preview: json.slice(0, AUDIT_MAX_JSON - 40) }) : json;
  } catch {
    return null;
  }
}

export function audit(
  metaPath: string,
  connId: string | null,
  action: string,
  target: string | null,
  ok: boolean,
  ms: number,
  actor?: string | null,
  values?: unknown
): void {
  openMeta(metaPath)
    .prepare(`INSERT INTO audit (connId,action,target,ok,ms,at,actor,valuesJson) VALUES (?,?,?,?,?,?,?,?)`)
    .run(connId, action, target, ok ? 1 : 0, ms, Date.now(), actor ?? null, values === undefined ? null : serializeAuditValues(values));
}

/**
 * Полная очистка журнала операций (audit). Возвращает число удалённых записей.
 * Вызывающий сам пишет запись о факте очистки — иначе стирается и она.
 */
export function clearAudit(metaPath: string, connId?: string): number {
  const meta = openMeta(metaPath);
  return connId
    ? meta.prepare(`DELETE FROM audit WHERE connId=?`).run(connId).changes
    : meta.prepare(`DELETE FROM audit`).run().changes;
}
