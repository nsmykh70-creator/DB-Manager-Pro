import { Redis } from 'ioredis';
import type { ConnectionConfig, DbDriver, QueryLimits, SchemaColumn, TablePage, TableSchema, TabularResult } from '../core/types.js';
import { assertWritable } from '../core/types.js';
import { withTimeout, validateDbPassword, validateDbUserName, validatePriv } from './helpers.js';

/** Номер БД Redis — целое неотрицательное. Мусор ('abc', '-1', '1.5') больше
 *  не молча превращается в 0: возвращаем 400, иначе запрос уйдёт не туда. */
function databaseIndex(value?: string | number | null, what = 'db'): number {
  if (value === undefined || value === null) return 0;
  const s = String(value).trim();
  if (s === '') return 0;
  if (!/^\d{1,4}$/.test(s)) throw Object.assign(new Error(`Redis ${what} must be a number 0..N (got "${s}")`), { statusCode: 400 });
  return Number(s);
}

function client(cfg: ConnectionConfig, db?: string): Redis {
  return new Redis({
    host: cfg.host ?? '127.0.0.1',
    port: cfg.port ?? 6379,
    password: cfg.password || undefined,
    db: databaseIndex(db !== undefined ? db : cfg.database),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true
  });
}

export function isRedisWriteQuery(sql: string): boolean {
  try {
    const parsed = JSON.parse(sql) as { cmd?: unknown };
    if (!parsed || typeof parsed !== 'object' || typeof parsed.cmd !== 'string') return false;
    return !['GET', 'HGETALL', 'KEYS'].includes(parsed.cmd.trim().toUpperCase());
  } catch {
    return false;
  }
}

export const redisDriver: DbDriver = {
  kind: 'redis' as any,
  async test(cfg) {
    const t0 = Date.now();
    const c = client(cfg);
    try {
      await c.connect();
      await c.ping();
      return { ok: true, latencyMs: Date.now() - t0 };
    } finally {
      c.disconnect();
    }
  },
  async listDatabases(cfg) {
    // У Redis нет схем: вместо них 16 пронумерованных логических баз
    // (`databases 16` в redis.conf), и SELECT выбирает одну из них. Показывать
    // все 16 — значит показать 16 одинаковых пустых строк, что выглядит как
    // «панель создала 16 подключений». Поэтому берём из INFO keyspace те базы,
    // где реально есть ключи, и всегда оставляем 0: SELECT без номера идёт
    // именно туда, и пустая база 0 всё равно нужна для первого ключа.
    //
    // Если INFO недоступен (старый или ограниченный Redis) — откатываемся к
    // прежнему списку 0..15: это тоже верно, просто без указания на пустоту.
    const c = client(cfg, '0');
    try {
      await c.connect();
      const info = await c.info('keyspace');
      const used = [...String(info).matchAll(/^db(\d+):keys=(\d+)/gim)]
        .filter((m) => Number(m[2]) > 0)
        .map((m) => Number(m[1]));
      return [...new Set([0, ...used])].sort((a, b) => a - b).map(String);
    } catch {
      return Array.from({ length: 16 }, (_, i) => String(i));
    } finally {
      c.disconnect();
    }
  },
  async listTables(cfg, db) {
    const c = client(cfg, db);
    try {
      await c.connect();
      // SCAN 0 MATCH * COUNT 500
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await c.scan(cursor, 'MATCH', '*', 'COUNT', '500');
        cursor = next;
        keys.push(...batch);
        if (keys.length >= 500) break;
      } while (cursor !== '0');
      return keys.slice(0, 500);
    } finally {
      c.disconnect();
    }
  },
  async getSchema(cfg, db, table): Promise<TableSchema> {
    const c = client(cfg, db);
    try {
      await c.connect();
      const t = await c.type(table);
      const ttl = await c.ttl(table);
      const len = t === 'string' ? await c.strlen(table) : t === 'hash' ? await c.hlen(table) : t === 'list' ? await c.llen(table) : 0;
      // У Redis нет таблиц: «схема» ключа — псевдо-таблица из его атрибутов.
      const columns: SchemaColumn[] = [
        { name: 'key', type: 'string', nullable: false, primary: true, autoInc: false, default: null, ordinal: 1, comment: null, extra: null },
        { name: 'type', type: 'string', nullable: true, primary: false, autoInc: false, default: null, ordinal: 2, comment: null, extra: null },
        { name: 'ttl', type: 'integer', nullable: true, primary: false, autoInc: false, default: null, ordinal: 3, comment: 'секунды; -1 = без срока, -2 = ключа нет', extra: null },
        { name: 'len', type: 'integer', nullable: true, primary: false, autoInc: false, default: null, ordinal: 4, comment: 'длина значения для string/hash/list', extra: null }
      ];
      return { table, kind: 'table', comment: `redis key (${t})`, extra: { type: t, ttl: String(ttl), len: String(len) }, columns, indexes: [], foreignKeys: [], triggers: [] };
    } finally {
      c.disconnect();
    }
  },
  async getPage(cfg, db, table, page, pageSize): Promise<TablePage> {
    // для Redis "таблица" = ключ, страница = поля хеша / элементы списка
    const c = client(cfg, db);
    try {
      await c.connect();
      const t = await c.type(table);
      const p = Math.max(1, page || 1);
      const ps = Math.min(500, Math.max(1, pageSize || 50));
      if (t === 'hash') {
        const all = await c.hgetall(table);
        const entries = Object.entries(all);
        const slice = entries.slice((p - 1) * ps, p * ps + 1);
        const truncated = slice.length > ps;
        const rows = slice.slice(0, ps).map(([k, v]) => ({ field: k, value: v }));
        return { columns: ['field', 'value'], rows, page: p, pageSize: ps, truncated };
      }
      if (t === 'string') {
        const v = await c.get(table);
        return { columns: ['value'], rows: v !== null ? [{ value: v }] : [], page: p, pageSize: ps, truncated: false };
      }
      if (t === 'list') {
        const vals = await c.lrange(table, (p - 1) * ps, p * ps);
        const truncated = vals.length > ps;
        const rows = vals.slice(0, ps).map((v: string, i: number) => ({ idx: (p - 1) * ps + i, value: v }));
        return { columns: ['idx', 'value'], rows, page: p, pageSize: ps, truncated };
      }
      // set/zset — члены
      if (t === 'set') {
        const vals = await c.smembers(table);
        const slice = vals.slice((p - 1) * ps, p * ps + 1);
        return { columns: ['member'], rows: slice.slice(0, ps).map((m: string) => ({ member: m })), page: p, pageSize: ps, truncated: slice.length > ps };
      }
      return { columns: ['value'], rows: [], page: p, pageSize: ps, truncated: false };
    } finally {
      c.disconnect();
    }
  },
  async query(cfg, sql, limits: QueryLimits): Promise<TabularResult> {
    const t0 = Date.now();
    // Redis query — JSON: {"cmd":"GET","key":"foo"} | {"cmd":"SET","key":"foo","value":"bar"} | {"cmd":"DEL","key":"foo"} | {"cmd":"KEYS","pattern":"*"}
    let cmd: { cmd?: string; key?: string; value?: string; pattern?: string; field?: string };
    try {
      cmd = JSON.parse(sql);
    } catch {
      throw Object.assign(new Error('Redis query must be JSON like {"cmd":"GET","key":"foo"}'), { statusCode: 400 });
    }
    const c = client(cfg, cfg.database);
    try {
      await c.connect();
      const op = (cmd.cmd ?? '').toUpperCase();
      if (!['GET', 'HGETALL', 'KEYS'].includes(op)) assertWritable(cfg, op.toLowerCase());
      let rows: Record<string, unknown>[] = [];
      let columns: string[] = [];
      if (op === 'GET' && cmd.key) {
        const v = await withTimeout(c.get(cmd.key), limits.timeoutMs);
        columns = ['value']; rows = v !== null ? [{ value: v }] : [];
      } else if (op === 'SET' && cmd.key) {
        await withTimeout(c.set(cmd.key, cmd.value ?? ''), limits.timeoutMs);
        columns = ['ok']; rows = [{ ok: 1 }];
      } else if (op === 'DEL' && cmd.key) {
        const n = await withTimeout(c.del(cmd.key), limits.timeoutMs);
        columns = ['deleted']; rows = [{ deleted: n }];
      } else if (op === 'HGETALL' && cmd.key) {
        const h = await withTimeout(c.hgetall(cmd.key) as Promise<Record<string,string>>, limits.timeoutMs) as unknown as Record<string,string>;
        columns = ['field', 'value']; rows = Object.entries(h).map(([k, v]: [string,string]) => ({ field: k, value: v }));
      } else if (op === 'KEYS') {
        const keys = await withTimeout(c.keys(cmd.pattern ?? '*') as Promise<string[]>, limits.timeoutMs) as unknown as string[];
        columns = ['key']; rows = keys.map((k: string) => ({ key: k }));
      } else {
        throw Object.assign(new Error('Redis cmd must be GET|SET|DEL|HGETALL|KEYS'), { statusCode: 400 });
      }
      const truncated = rows.length > limits.maxRows;
      const slice = rows.slice(0, limits.maxRows);
      return { columns, rows: slice, rowCount: slice.length, truncated, execMs: Date.now() - t0 };
    } finally {
      c.disconnect();
    }
  },
  async getRelations() { return []; },
  async getStatus(cfg) {
    const c = client(cfg);
    try {
      await c.connect();
      const info = await c.info();
      const ver = (info.match(/redis_version:([^\r\n]+)/)?.[1] ?? '?');
      const up = Number(info.match(/uptime_in_seconds:(\d+)/)?.[1] ?? 0);
      const conn = Number(info.match(/connected_clients:(\d+)/)?.[1] ?? 0);
      const used = Number(info.match(/used_memory:(\d+)/)?.[1] ?? info.match(/used_memory_dataset:(\d+)/)?.[1] ?? 0);
      const bytes = Number.isFinite(used) ? used : 0;
      return { version: `Redis ${ver}`, uptimeSec: Number.isFinite(up) ? up : 0, connections: Number.isFinite(conn) ? conn : 0, processlist: [], dbSizes: [{ db: String(databaseIndex(cfg.database)), bytes }], extra: {} };
    } finally { c.disconnect(); }
  },
  async clearTable(cfg, db, table) {
    assertWritable(cfg, 'delete');
    const c = client(cfg, db);
    try { await c.connect(); const n = await c.del(table); return { deleted: n }; } finally { c.disconnect(); }
  },
  async createTable(_cfg, _db, _def) {
    throw Object.assign(new Error('Redis has keys, not tables; create a key instead'), { statusCode: 400 });
  },
  async dropTable(cfg, db, table) {
    assertWritable(cfg, 'drop');
    const c = client(cfg, db);
    try { await c.connect(); await c.del(table); return { ok: true as const, statement: `DEL ${String(table)}` }; } finally { c.disconnect(); }
  },
  async listDbUsers(cfg) {
    const c = client(cfg);
    try {
      await c.connect();
      const rows = await c.call('ACL', 'LIST') as string[];
      return rows
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return { username: parts[1], roles: parts.slice(2).filter((rule) => rule.startsWith('+') || rule.startsWith('-')) };
        })
        .filter((user) => user.username && user.username !== 'default');
    } finally { c.disconnect(); }
  },
  async createDbUser(cfg, username, password) {
    assertWritable(cfg, 'create user');
    const user = validateDbUserName(username, 'redis');
    const pass = validateDbPassword(password);
    const c = client(cfg);
    try {
      await c.connect();
      await c.call('ACL', 'SETUSER', user, 'reset', 'on', `>${pass}`, '~*', '+@all');
      return { ok: true as const };
    } finally { c.disconnect(); }
  },
  async dropDbUser(cfg, username) {
    assertWritable(cfg, 'drop user');
    const user = validateDbUserName(username, 'redis');
    const c = client(cfg);
    try {
      await c.connect();
      await c.call('ACL', 'DELUSER', user);
      return { ok: true as const };
    } finally { c.disconnect(); }
  },
  async listGrants(cfg, username) {
    const user = validateDbUserName(username, 'redis');
    const c = client(cfg);
    try {
      await c.connect();
      const rules = await c.call('ACL', 'GETUSER', user) as string[];
      return rules.filter((rule) => rule.startsWith('+'));
    } finally { c.disconnect(); }
  },
  async grant(cfg, username, privilege) {
    assertWritable(cfg, 'grant');
    const user = validateDbUserName(username, 'redis');
    const rule = validatePriv(privilege) === 'ALL PRIVILEGES' ? '+@all' : `+${validatePriv(privilege).toLowerCase()}`;
    const c = client(cfg);
    try {
      await c.connect();
      await c.call('ACL', 'SETUSER', user, rule);
      return { ok: true as const };
    } finally { c.disconnect(); }
  },
  async revoke(cfg, username, privilege) {
    assertWritable(cfg, 'revoke');
    const user = validateDbUserName(username, 'redis');
    const rule = validatePriv(privilege) === 'ALL PRIVILEGES' ? '-@all' : `-${validatePriv(privilege).toLowerCase()}`;
    const c = client(cfg);
    try {
      await c.connect();
      await c.call('ACL', 'SETUSER', user, rule);
      return { ok: true as const };
    } finally { c.disconnect(); }
  },
  async insertRow(cfg, db, table, row) {
    assertWritable(cfg, 'insert');
    const c = client(cfg, db);
    try {
      await c.connect();
      if (row.value !== undefined) await c.set(table, String(row.value));
      else await c.hmset(table, row as Record<string, string>);
      return { insertedId: table };
    } finally { c.disconnect(); }
  },
  /**
   * Импорт строк в Redis: у ключей нет общей таблицы, поэтому правило такое —
   * строка с полем `key` пишет именно этот ключ (скаляр `value` → SET,
   * остальные поля → HSET), строка без `key` получает ключ `${table}:${i}`.
   * Раньше importRows не было вовсе, и JSON/CSV-импорт отвечал 400.
   */
  async importRows(cfg, db, table, rows) {
    assertWritable(cfg, 'insert');
    if (!rows.length) return { inserted: 0, execMs: 0 };
    if (rows.length > 50_000) throw Object.assign(new Error('Too many rows (50k)'), { statusCode: 413 });
    const t0 = Date.now();
    const t = String(table);
    if (!t) throw Object.assign(new Error('table (key prefix) required'), { statusCode: 400 });
    const c = client(cfg, db);
    try {
      await c.connect();
      let n = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown>;
        const key = typeof row.key === 'string' && row.key ? row.key : `${t}:${i}`;
        if (typeof row.value !== 'undefined' && Object.keys(row).every((k) => k === 'key' || k === 'value')) {
          await c.set(key, String(row.value));
        } else {
          const { key: _drop, ...fields } = row;
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(fields)) flat[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (!Object.keys(flat).length) throw Object.assign(new Error(`Row ${i} has no fields to store`), { statusCode: 400 });
          await c.hmset(key, flat);
        }
        n++;
      }
      return { inserted: n, execMs: Date.now() - t0 };
    } finally { c.disconnect(); }
  },
  /**
   * Стриминг ключа батчами для экспорта: hash — полями, string — одной строкой,
   * list/set — членами. Нужен экспорту/бэкапу, раньше его не было.
   */
  async *streamRows(cfg, db, table, batchSize = 1000) {
    const c = client(cfg, db);
    try {
      await c.connect();
      const t = await c.type(table);
      const bs = Math.min(Math.max(batchSize || 1000, 1), 5000);
      if (t === 'hash') {
        let cursor = '0';
        let batch: Record<string, unknown>[] = [];
        do {
          const [next, fields] = await c.hscan(table, cursor, 'COUNT', String(Math.min(bs, 1000)));
          cursor = next;
          for (let i = 0; i < fields.length; i += 2) {
            batch.push({ field: fields[i], value: fields[i + 1] });
            if (batch.length >= bs) { yield batch; batch = []; }
          }
        } while (cursor !== '0');
        if (batch.length) yield batch;
      } else if (t === 'string') {
        const v = await c.get(table);
        if (v !== null) yield [{ value: v }];
      } else if (t === 'list') {
        let start = 0;
        for (;;) {
          const vals = await c.lrange(table, start, start + bs - 1);
          if (!vals.length) break;
          yield vals.map((v: string, i: number) => ({ idx: start + i, value: v }));
          start += vals.length;
          if (vals.length < bs) break;
        }
      } else if (t === 'set') {
        let cursor = '0';
        let batch: Record<string, unknown>[] = [];
        do {
          const [next, members] = await c.sscan(table, cursor, 'COUNT', String(Math.min(bs, 1000)));
          cursor = next;
          for (const m of members) {
            batch.push({ member: m });
            if (batch.length >= bs) { yield batch; batch = []; }
          }
        } while (cursor !== '0');
        if (batch.length) yield batch;
      }
    } finally { c.disconnect(); }
  },
  async updateRow(cfg, db, table, filter, patch) {
    assertWritable(cfg, 'update');
    const c = client(cfg, db);
    try {
      await c.connect();
      const fields = Object.keys(filter);
      if (fields.length) {
        const values = await c.hmget(table, ...fields);
        const matches = fields.every((field, i) => values[i] === String(filter[field]));
        if (!matches) return { matched: 0 };
      }
      await c.hmset(table, patch as Record<string, string>);
      return { matched: 1 };
    } finally { c.disconnect(); }
  },
  async deleteRow(cfg, db, table, filter) {
    assertWritable(cfg, 'delete');
    const c = client(cfg, db);
    try {
      await c.connect();
      const fields = Object.keys(filter);
      if (fields.length) {
        const current = await c.hgetall(table);
        const matches = fields.every((field) => current[field] === String(filter[field]));
        if (!matches) return { deleted: 0 };
        if (fields.length === Object.keys(current).length) return { deleted: await c.del(table) };
        return { deleted: await c.hdel(table, ...fields) };
      }
      const n = await c.del(table);
      return { deleted: n };
    } finally { c.disconnect(); }
  },
  async killQuery() { throw Object.assign(new Error('Kill not supported for Redis'), { statusCode: 400 }); }
};
