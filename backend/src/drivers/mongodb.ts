import { MongoClient, ObjectId, Binary, Decimal128 } from 'mongodb';
import type { Document, Filter, Sort } from 'mongodb';
import type { ConnectionConfig, DbDriver, QueryLimits, SchemaColumn, TablePage, TableSchema, TabularResult } from '../core/types.js';
import { assertWritable } from '../core/types.js';
import { filterValue, ident, parseFilter, validateDbPassword, validateDbUserName, validateMongoRole, validateRow, withTimeout } from './helpers.js';
import { userFacingDbError } from '../core/dberror.js';

// Для Mongo query-текст — это JSON: {"collection":"users","filter":{"age":{"$gt":18}},"limit":50}
// Так проще и безопаснее, чем парсить "db.users.find()".
function parseMongoQuery(sql: string): { db?: string; collection: string; filter?: Record<string, unknown>; limit?: number; clear?: boolean } {
  const t = sql.trim();
  if (!t.startsWith('{')) {
    throw Object.assign(new Error('Mongo query must be JSON like {"db":"demo","collection":"users","filter":{},"limit":50}'), { statusCode: 400 });
  }
  let j: { db?: unknown; collection?: unknown; filter?: unknown; limit?: unknown; clear?: unknown };
  try {
    j = JSON.parse(t);
  } catch {
    throw Object.assign(new Error('Mongo query must be valid JSON'), { statusCode: 400 });
  }
  if (j.db !== undefined && (typeof j.db !== 'string' || !j.db.trim())) {
    throw Object.assign(new Error('Mongo JSON "db" must be a non-empty string'), { statusCode: 400 });
  }
  if (typeof j.collection !== 'string' || !j.collection) throw Object.assign(new Error('Mongo JSON needs "collection"'), { statusCode: 400 });
  if (j.filter !== undefined && (!j.filter || typeof j.filter !== 'object' || Array.isArray(j.filter))) {
    throw Object.assign(new Error('Mongo JSON "filter" must be an object'), { statusCode: 400 });
  }
  const limit = j.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    throw Object.assign(new Error('Mongo JSON "limit" must be a positive integer'), { statusCode: 400 });
  }
  return { db: typeof j.db === 'string' ? j.db.trim() : undefined, collection: j.collection, filter: (j.filter ?? {}) as Record<string, unknown>, limit: typeof limit === 'number' ? limit : undefined, clear: j.clear === true };
}

export function isMongoWriteQuery(sql: string): boolean {
  try {
    return parseMongoQuery(sql).clear === true;
  } catch {
    return false;
  }
}

function url(cfg: ConnectionConfig): string {
  if (cfg.host?.startsWith('mongodb')) return cfg.host;
  const auth = cfg.user ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password ?? '')}@` : '';
  return `mongodb://${auth}${cfg.host ?? 'localhost'}:${cfg.port ?? 27017}`;
}

/** Имя БД для операции. Раньше здесь стоял хардкод 'demo' — из-за него
 *  usersInfo/GRANT уезжали в несуществующую БД при пустом default. */
function requireDb(cfg: ConnectionConfig, db?: string, what = 'Mongo database'): string {
  const name = (db ?? '').trim() || (cfg.database ?? '').trim();
  if (!name) throw Object.assign(new Error(`${what} is required (set the connection database or pass "db")`), { statusCode: 400 });
  if (!/^[^./\\$*"<>:|?\0\s]{1,63}$/.test(name)) throw Object.assign(new Error(`Bad Mongo database name: ${name}`), { statusCode: 400 });
  return name;
}

/**
 * Значения из панели приходят строками (в том числе `_id` из выгрузки JSON),
 * а в MongoDB `_id` — это ObjectId. Без преобразования фильтр `{_id: "6ab7..."}`
 * не совпадает ни с одним документом: правка и удаление молча ничего не делают.
 * Поэтому 24-символьный hex в поле `_id` трактуем как ObjectId.
 */
function idFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const raw = filter['_id'];
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{24}$/.test(raw)) return filter;
  return { ...filter, _id: new ObjectId(raw) };
}

/** БД для управления пользователями: явно заданная > БД подключения > admin.
 *  Хардкод 'demo' из прежней версии убран. */
function usersDb(cfg: ConnectionConfig, db?: string): string {
  const explicit = (db ?? '').trim();
  if (explicit) return requireDb(cfg, explicit, 'Mongo users database');
  return (cfg.database ?? '').trim() || 'admin';
}

/**
 * Расширенный JSON MongoDB ($oid/$date/$number*) в нативные значения.
 * Экспорт панели отдаёт `_id` строкой, а mongoexport — `{"$oid":"..."}`
 * и `{"$date":"..."} guess`: без нормализации импорт кладёт их словарями
 * вместо ObjectId/Date, и обратный round-trip ломается. Неизвестные `$`-ключи
 * не трогаем — это могут быть операторы фильтра, а не значения.
 */
export function fromExtendedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromExtendedJson);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0].startsWith('$')) {
      const k = keys[0];
      const v = o[k];
      try {
        if (k === '$oid' && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) return new ObjectId(v);
        if (k === '$date') {
          if (typeof v === 'string' || typeof v === 'number') {
            const d = new Date(v);
            if (!Number.isNaN(d.getTime())) return d;
          } else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).$numberLong === 'string') {
            return new Date(Number((v as Record<string, unknown>).$numberLong));
          }
          return value;
        }
        if (k === '$numberInt' && typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
        if (k === '$numberLong' && typeof v === 'string' && /^-?\d+$/.test(v)) {
          const n = Number(v);
          return Number.isSafeInteger(n) ? n : v;
        }
        if ((k === '$numberDouble' || k === '$numberDecimal') && typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
          return k === '$numberDecimal' ? new Decimal128(v) : Number(v);
        }
        if (k === '$binary' && v && typeof v === 'object') {
          const b = v as Record<string, unknown>;
          if (typeof b.base64 === 'string') return new Binary(Buffer.from(b.base64, 'base64'), typeof b.subType === 'string' ? Number.parseInt(b.subType, 16) : 0);
        }
      } catch {
        return value;
      }
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [kk, vv] of Object.entries(o)) out[kk] = fromExtendedJson(vv);
    return out;
  }
  return value;
}

function toRows(docs: Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } {
  const cols = new Set<string>();
  const rows = docs.map((d) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      o[k] = k === '_id' ? String(v) : v;
      cols.add(k);
    }
    return o;
  });
  return { columns: [...cols], rows };
}

const MONGO_OPS: Record<string, string> = { '=': '$eq', '!=': '$ne', '>': '$gt', '>=': '$gte', '<': '$lt', '<=': '$lte' };

function parsePageFilter(filter?: string): Filter<Document> {
  const conds = parseFilter(filter);
  if (!conds?.length) return {};
  const clauses: Filter<Document>[] = [];
  for (const c of conds) {
    const value = filterValue(c.op, c.value);
    if (c.op === '~' || c.op === '^' || c.op === '$') {
      const escaped = c.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = c.op === '~' ? new RegExp(escaped, 'i') : c.op === '^' ? new RegExp(`^${escaped}`, 'i') : new RegExp(`${escaped}$`, 'i');
      clauses.push({ [c.column]: re } as Filter<Document>);
      continue;
    }
    clauses.push({ [c.column]: { [MONGO_OPS[c.op]]: value } } as Filter<Document>);
  }
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function parsePageSort(sort?: string): Sort | undefined {
  if (!sort) return undefined;
  const [column, direction] = sort.split(':');
  return { [ident(column, 'column')]: direction?.toLowerCase() === 'desc' ? -1 : 1 };
}

export const mongoDriver: DbDriver = {
  kind: 'mongodb',
  async test(cfg) {
    const t0 = Date.now();
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      await c.db().command({ ping: 1 });
      return { ok: true, latencyMs: Date.now() - t0 };
    } finally {
      await c.close();
    }
  },
  async listDatabases(cfg) {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db('admin').admin().listDatabases();
      return r.databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    } finally {
      await c.close();
    }
  },
  async listTables(cfg, db) {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const cols = await c.db(db || cfg.database).listCollections().toArray();
      return cols.map((x) => x.name);
    } finally {
      await c.close();
    }
  },
  async getSchema(cfg, db, table): Promise<TableSchema> {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const doc = await c.db(db || cfg.database).collection(table).findOne({});
      // Коллекции schema-less: «колонки» выводятся из первого документа.
      // Это эвристика для просмотра, а не описание структуры (см. alterTable → 400).
      const columns: SchemaColumn[] = Object.entries(doc ?? {}).map(([k, v], i) => ({
        name: k,
        type: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v,
        nullable: true,
        primary: false,
        autoInc: false,
        default: null,
        ordinal: i + 1,
        comment: null,
        extra: null
      }));
      return { table, kind: 'table', comment: null, extra: {}, columns, indexes: [], foreignKeys: [], triggers: [] };
    } finally {
      await c.close();
    }
  },
  async getPage(cfg, db, table, page, pageSize, sort, filter): Promise<TablePage> {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const p = Math.max(1, page || 1);
      const ps = Math.min(500, Math.max(1, pageSize || 50));
      const mongoFilter = parsePageFilter(filter);
      const mongoSort = parsePageSort(sort);
      let cursor = c.db(db || cfg.database).collection(table).find(mongoFilter);
      if (mongoSort) cursor = cursor.sort(mongoSort);
      const docs = await cursor.skip((p - 1) * ps).limit(ps + 1).toArray() as unknown as Record<string, unknown>[];
      const truncated = docs.length > ps;
      const { columns, rows } = toRows(docs.slice(0, ps));
      return { columns, rows, page: p, pageSize: ps, truncated };
    } finally {
      await c.close();
    }
  },
  async query(cfg, sql, limits: QueryLimits): Promise<TabularResult> {
    const t0 = Date.now();
    const q = parseMongoQuery(sql);
    const database = q.db || cfg.database;
    if (!database) throw Object.assign(new Error('Mongo database is required'), { statusCode: 400 });
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const db = c.db(database);
      if (q.clear) {
        assertWritable(cfg, 'delete');
        const result = await db.collection(q.collection).deleteMany(q.filter ?? {});
        return { columns: ['deleted'], rows: [{ deleted: result.deletedCount }], rowCount: 1, truncated: false, execMs: Date.now() - t0 };
      }
      const docs = await withTimeout(
        db.collection(q.collection).find(q.filter ?? {}).limit(Math.min(q.limit ?? limits.maxRows, limits.maxRows)).toArray(),
        limits.timeoutMs
      ) as unknown as Record<string, unknown>[];
      const { columns, rows } = toRows(docs);
      return { columns, rows, rowCount: rows.length, truncated: rows.length >= limits.maxRows, execMs: Date.now() - t0 };
    } finally {
      await c.close();
    }
  },
  async execScript() {
    throw Object.assign(new Error('Mongo: use JSON import instead of SQL script'), { statusCode: 400 });
  },
  async importRows(cfg, db, table, rows, opts) {
   assertWritable(cfg, 'insert');
   if (!rows.length) return { inserted: 0, execMs: 0 };
   if (rows.length > 50_000) throw Object.assign(new Error('Too many rows (50k)'), { statusCode: 413 });
   const t0 = Date.now();
   const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
   try {
    await c.connect();
    const clean = rows.map((r) => {
     const o = { ...(fromExtendedJson(r) as Record<string, unknown>) };
     // при откате checkpoint _id сохраняем — иначе документы получат новые
     // ObjectId и ссылки на них из других коллекций станут битыми
     if (!opts?.keepIds) delete o._id;
     return o;
    });
    const r = await c.db(db || cfg.database).collection(table).insertMany(clean);
    return { inserted: r.insertedCount, execMs: Date.now() - t0 };
   } finally {
    await c.close();
   }
  },
  async *streamRows(cfg, db, table, batchSize = 1000) {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const cursor = c.db(db || cfg.database).collection(table).find({}).batchSize(Math.min(batchSize, 5000));
      let batch: Record<string, unknown>[] = [];
      for await (const doc of cursor) {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(doc as Record<string, unknown>)) o[k] = k === '_id' ? String(v) : v;
        batch.push(o);
        if (batch.length >= batchSize) { yield batch; batch = []; }
      }
      if (batch.length) yield batch;
    } finally {
      await c.close();
    }
  },
  async getRelations() {
    return []; // у документов нет внешних ключей
  },
  async getStatus(cfg) {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const ss = await c.db('admin').command({ serverStatus: 1 });
      const dbs = await c.db('admin').admin().listDatabases();
      const sizes: { db: string; bytes: number }[] = [];
      for (const d of dbs.databases.slice(0, 50)) {
        if (['admin', 'local', 'config'].includes(d.name)) continue;
        try {
          const s = await c.db(d.name).stats();
          sizes.push({ db: d.name, bytes: Math.round(s.storageSize ?? s.dataSize ?? 0) });
        } catch { /* нет прав на stats */ }
      }
      return {
        version: `MongoDB ${ss.version ?? '?'}`,
        uptimeSec: Math.round(ss.uptime ?? 0),
        connections: ss.connections?.current,
        processlist: [],
        dbSizes: sizes.sort((a, b) => b.bytes - a.bytes),
        extra: { host: ss.host }
      };
    } finally {
      await c.close();
    }
  },
  async clearTable(cfg, db, table) {
    assertWritable(cfg, 'delete');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(db || cfg.database).collection(table).deleteMany({});
      return { deleted: r.deletedCount };
    } finally {
      await c.close();
    }
  },
  async createTable(cfg, db, def) {
    assertWritable(cfg, 'create');
    const t = ident(def.name, 'table');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      await c.db(db || cfg.database).createCollection(t);
      return { ok: true as const, statement: `db.createCollection(${JSON.stringify(t)})` };
    } finally {
      await c.close();
    }
  },
  async alterTable() {
    throw Object.assign(new Error('MongoDB collections are schema-less: add/drop columns N/A'), { statusCode: 400 });
  },
  async dropTable(cfg, db, table) {
    assertWritable(cfg, 'drop');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      await c.db(db || cfg.database).collection(table).drop();
      return { ok: true as const, statement: `db.${ident(table, 'table')}.drop()` };
    } finally {
      await c.close();
    }
  },
  async listDbUsers(cfg) {
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(usersDb(cfg)).command({ usersInfo: 1 }) as { users: { user: string; db: string; roles: { role: string; db: string }[] }[] };
      return r.users.map((u) => ({ username: u.user, db: u.db, roles: u.roles.map((x) => `${x.role}@${x.db}`) }));
    } finally {
      await c.close();
    }
  },
  async createDbUser(cfg, username, password, db) {
    assertWritable(cfg, 'create');
    const u = validateDbUserName(username, 'mongodb');
    const p = validateDbPassword(password);
    const target = usersDb(cfg, db);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      await c.db(target).command({ createUser: u, pwd: p, roles: [{ role: 'readWrite', db: target }] });
      return { ok: true as const };
    } finally {
      await c.close();
    }
  },
  async dropDbUser(cfg, username, db) {
    assertWritable(cfg, 'drop');
    const u = validateDbUserName(username, 'mongodb');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      await c.db(usersDb(cfg, db)).command({ dropUser: u });
      return { ok: true as const };
    } finally {
      await c.close();
    }
  },
  async listGrants(cfg, username, db) {
    const u = validateDbUserName(username, 'mongodb');
    const target = usersDb(cfg, db);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(target).command({ usersInfo: { user: u, db: target } }) as { users: { roles: {role:string,db:string}[] }[] };
      if (!r.users.length) throw Object.assign(new Error('User not found'), { statusCode: 404 });
      return r.users[0].roles.map((x)=>`${x.role}@${x.db}`);
    } finally { await c.close(); }
  },
  async grant(cfg, username, privilege, db) {
    assertWritable(cfg, 'grant');
    const u = validateDbUserName(username, 'mongodb');
    const role = validateMongoRole(privilege);
    const target = usersDb(cfg, db);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      try {
        await c.db(target).command({ grantRolesToUser: u, roles: [{ role, db: target }] });
      } catch (e) {
        // Нет такой роли / нет прав — это ошибка пользователя, а не падение
        // панели: без перевода был бы маскированный 500 «Internal server error».
        throw userFacingDbError(e);
      }
      return { ok: true as const };
    } finally { await c.close(); }
  },
  async revoke(cfg, username, privilege, db) {
    assertWritable(cfg, 'revoke');
    const u = validateDbUserName(username, 'mongodb');
    const role = validateMongoRole(privilege);
    const target = usersDb(cfg, db);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      try {
        await c.db(target).command({ revokeRolesFromUser: u, roles: [{ role, db: target }] });
      } catch (e) {
        throw userFacingDbError(e);
      }
      return { ok: true as const };
    } finally { await c.close(); }
  },
  async insertRow(cfg, db, table, row) {
    assertWritable(cfg, 'insert');
    validateRow(row);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(requireDb(cfg, db)).collection(table).insertOne({ ...row });
      return { insertedId: String(r.insertedId) };
    } finally { await c.close(); }
  },
  async updateRowsBulk(cfg, db, table, filter, patch) {
    assertWritable(cfg, 'update bulk');
    validateRow(patch, 'patch');
    if (!Object.keys(patch).length) throw Object.assign(new Error('Bulk update needs at least one column'), { statusCode: 400 });
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      // Тот же parsePageFilter(), что и в getPage: предпросмотр и правка
      // должны отбирать одни и те же документы
      const r = await c.db(requireDb(cfg, db)).collection(table).updateMany(parsePageFilter(filter) as any, { $set: patch });
      return { affected: r.modifiedCount };
    } finally { await c.close(); }
  },
  async deleteRowsBulk(cfg, db, table, filter) {
    assertWritable(cfg, 'delete bulk');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(requireDb(cfg, db)).collection(table).deleteMany(parsePageFilter(filter) as any);
      return { affected: r.deletedCount };
    } finally { await c.close(); }
  },
  async updateRow(cfg, db, table, filter, patch) {
    assertWritable(cfg, 'update');
    validateRow(filter,'filter'); validateRow(patch,'patch');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
      await c.connect();
      const r = await c.db(requireDb(cfg, db)).collection(table).updateOne(idFilter(filter) as any, { $set: patch });
      return { matched: r.matchedCount };
    } finally { await c.close(); }
  },
  async deleteRow(cfg, db, table, filter) {
    assertWritable(cfg, 'delete');
    validateRow(filter,'filter');
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
     await c.connect();
     const r = await c.db(requireDb(cfg, db)).collection(table).deleteOne(idFilter(filter) as any);
     return { deleted: r.deletedCount };
    } finally { await c.close(); }
  },
  // Точное чтение по фильтру-объекту: нужно для отката изменений данных.
  async findRows(cfg, db, table, filter, limit = 50) {
    validateRow(filter, 'filter');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 501);
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 5000 });
    try {
     await c.connect();
     return await c.db(requireDb(cfg, db)).collection(table).find(idFilter(filter) as Filter<Document>).limit(lim).toArray() as Record<string, unknown>[];
    } finally { await c.close(); }
  },
  async killQuery() {
    throw Object.assign(new Error('Kill not supported for MongoDB'), { statusCode: 400 });
  }
};