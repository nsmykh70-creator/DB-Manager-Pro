import mysql from 'mysql2/promise';
import { Pool as PgPool } from 'pg';
import oracledb from 'oracledb';
import type { ConnectionConfig } from './types.js';

const mysqlPools = new Map<string, mysql.Pool>();
const pgPools = new Map<string, PgPool>();
// node-oracledb 6+ создаёт пул асинхронно, поэтому кэшируем сам промис:
// два параллельных вызова не должны создавать два пула на одно подключение.
const oraclePools = new Map<string, Promise<oracledb.Pool>>();

/** Oracle отдаёт строки массивами; панели нужен объект по имени колонки. */
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

function mysqlKey(cfg: ConnectionConfig): string {
  // Пул привязан к конкретной БД: разные БД одного подключения — разные пулы
  return `${cfg.id ?? ''}@${cfg.host ?? 'localhost'}:${cfg.port ?? 3306}:${cfg.user ?? ''}:${cfg.database ?? ''}`;
}

function pgKey(cfg: ConnectionConfig): string {
  return `${cfg.id ?? ''}@${cfg.host ?? 'localhost'}:${cfg.port ?? 5432}:${cfg.user ?? ''}:${cfg.database ?? ''}`;
}

/**
 * Ключ пула Oracle включает serviceName: у Oracle «база» — это сервис в tnsnames,
 * и одно и то же подключение может ходить в разные PDB.
 */
function oracleKey(cfg: ConnectionConfig): string {
  return `${cfg.id ?? ''}@${cfg.host ?? 'localhost'}:${cfg.port ?? 1521}:${cfg.user ?? ''}:${cfg.serviceName || cfg.database || ''}`;
}

/**
 * Connect string для oracledb. Отдельный host:port не годится: Oracle
 * различает SERVICE_NAME (один инстанс) и SID (инстанс БД) — перебор вариантов
 * породил бы либо двойной таймаут, либо подключение не к тому инстансу.
 * Поэтому для Oracle host:port это EZ-подключение (смысл либо SERVICE_NAME,
 * либо SID — определяет сервер сам), а явное имя перекрывает его через
 * SERVICE_NAME, если поле заполнено, иначе через SID.
 */
function oracleConnectString(cfg: ConnectionConfig): string {
  // Именно serviceName, а не database: в database интерфейс кладёт выбранную
  // схему (для Oracle это схема пользователя, а не сервис), и подстановка её
  // в connect string давала NJS-518 на каждом запросе. У старых подключений,
  // созданных до разделения полей, serviceName нет — тогда берём database.
  const name = (cfg.serviceName ?? cfg.database)?.trim();
  if (name) return `${cfg.host ?? 'localhost'}:${cfg.port ?? 1521}/${name}`;
  return `${cfg.host ?? 'localhost'}:${cfg.port ?? 1521}`;
}

/**
 * Пул для подключения к Oracle.
 *
 * node-oracledb различает SERVICE_NAME (один инстанс, может быть несколько PDB)
 * и SID (инстанс БД) и само подключение не создаёт: нужен готовый connect string.
 * Панель хранит только host/port/database, поэтому собираем EZ-подключение —
 * «host:port», а заполненное поле «база» уходит как SERVICE_NAME (его панель
 * называет базой, но физически это имя сервиса или PDB).
 *
 * Промис, а не сам Pool, кэшируется: createPool() в oracledb 6+ асинхронный,
 * и без кэша промисов два параллельных запроса создали бы два пула на одно
 * подключение — и половина соединений осталась бы висеть в базе.
 */
export function getOraclePool(cfg: ConnectionConfig): Promise<oracledb.Pool> {
  const k = oracleKey(cfg);
  const cached = oraclePools.get(k);
  if (cached) return cached;
  const created = oracledb.createPool({
    user: cfg.user,
    password: cfg.password,
    connectString: oracleConnectString(cfg),
    poolMin: 0,
    poolMax: 10,
    poolTimeout: 60
  });
  oraclePools.set(k, created);
  // Упавший пул не должен остаться в кэше: иначе все последующие запросы
  // получали бы тот же отказ, хотя причину (сеть, рестарт инстанса) могли
  // уже устранить.
  created.catch(() => { oraclePools.delete(k); });
  return created;
}

export function getMysqlPool(cfg: ConnectionConfig): mysql.Pool {
  // Ключ ВСЕГДА включает БД: пулы с разными default-БД не должны смешиваться
  const k = mysqlKey(cfg);
  let p = mysqlPools.get(k);
  if (p) return p;
  p = mysql.createPool({
    host: cfg.host ?? 'localhost',
    port: cfg.port ?? 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
  // Сервер может оборвать соединение (KILL, рестарт, drop базы) — без
  // слушателя это необработанное событие и падение процесса.
  // Типы mysql2/promise не объявляют 'error' у пула, поэтому приводим явно.
  (p as unknown as { on(event: 'error', cb: (err: Error) => void): void }).on('error', (err: Error) => {
    console.warn(`[mysql pool] idle client error (${k}): ${err.message}`);
  });
  mysqlPools.set(k, p);
  return p;
}

export function getPgPool(cfg: ConnectionConfig): PgPool {
  // Ключ ВСЕГДА включает БД: пулы с разными default-БД не должны смешиваться
  const k = pgKey(cfg);
  let p = pgPools.get(k);
  if (p) return p;
  p = new PgPool({
    host: cfg.host ?? 'localhost',
    port: cfg.port ?? 5432,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database ?? 'postgres',
    max: 10,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000
  });
  // PostgreSQL вправе оборвать соединение сам: DROP DATABASE ... WITH (FORCE),
  // terminate_backend, рестарт сервера. На клиенте без слушателя это
  // превращается в необработанное событие error и УБИВАЕТ процесс backend
  // (наблюдалось: 57P01 → Exited(1) → 502 на весь API). Поэтому errors
  // глушим: конкретный запрос и так получит 502, а процесс останется жив.
  p.on('error', (err: Error) => {
    console.warn(`[pg pool] idle client error (${k}): ${err.message}`);
  });
  pgPools.set(k, p);
  return p;
}

export async function closePoolsFor(cfgId: string): Promise<void> {
  for (const [k, mp] of [...mysqlPools]) {
    if (k === cfgId || k.startsWith(cfgId + '@')) {
      try { await mp.end(); } catch {}
      mysqlPools.delete(k);
    }
  }
  for (const [k, pp] of [...pgPools]) {
    if (k === cfgId || k.startsWith(cfgId + '@')) {
      try { await pp.end(); } catch {}
      pgPools.delete(k);
    }
  }
  for (const [k, op] of [...oraclePools]) {
    if (k === cfgId || k.startsWith(cfgId + '@')) {
      oraclePools.delete(k);
      try { await (await op).close(0); } catch {}
    }
  }
}

export async function closeAllPools(): Promise<void> {
  for (const p of mysqlPools.values()) await p.end();
  for (const p of pgPools.values()) await p.end();
  const oracle = [...oraclePools.values()];
  oraclePools.clear();
  for (const p of oracle) { try { await (await p).close(0); } catch {} }
  mysqlPools.clear();
  pgPools.clear();
}
