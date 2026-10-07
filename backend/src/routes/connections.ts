import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import { getDriver } from '../plugins/registry.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AppConfig } from '../core/config.js';
import type { ConnectionConfig } from '../core/types.js';
import { audit, clearAudit, createConnection, deleteConnection, ensureSqliteFile, listConnections, loadDecrypted, normalizeSqlitePath } from '../core/context.js';
import type { PanelUser } from '../core/auth.js';
import { userFacingDbError } from '../core/dberror.js';
import { openMeta } from '../core/store.js';
import { encrypt } from '../core/crypto.js';
import { validateDatabaseName } from '../core/dbname.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

export function connectionsRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/connections', async () => listConnections(cfg.metaPath));

  app.post('/api/connections', async (req) => {
    const u = me(req);
    if (u && u.role === 'readonly') throw Object.assign(new Error('Readonly cannot create'), { statusCode: 403 });
    const raw = req.body as any;
    // Normalize production-final (type/username) vs legacy (kind/user) fields
    const body: any = {
      ...raw,
      kind: raw.kind ?? raw.type,
      user: raw.user ?? raw.username,
      database: raw.database ?? raw.databaseName,
      filePath: raw.filePath ?? raw.file,
    };
    if (body.kind === 'sqlite' && body.filePath) {
      body.filePath = normalizeSqlitePath(body.filePath);
      if (!isAbsolute(body.filePath)) body.filePath = resolve(dirname(cfg.metaPath), body.filePath);
    }
    if ((raw.createDatabase || body.createDatabase) && (body.database || body.kind === 'sqlite')) {
      const kind = String(body.kind);
      if (kind === 'sqlite') {
        if (!body.filePath) throw Object.assign(new Error('filePath required for sqlite'), { statusCode: 400 });
        ensureSqliteFile(body.filePath);
      } else if (kind === 'mongodb') {
        const { MongoClient } = await import('mongodb');
        const mUser = body.user || body.username;
        const mAuth = mUser ? `${encodeURIComponent(mUser)}:${encodeURIComponent(body.password ?? '')}@` : '';
        const c = new MongoClient(body.uri || `mongodb://${mAuth}${body.host || 'localhost'}:${body.port || 27017}`, { serverSelectionTimeoutMS: 5000 });
        try {
          await c.connect();
          const database = c.db(body.database);
          try {
            await database.createCollection('__dbpanel_init__');
          } catch (e: any) {
            if (e?.code !== 48) throw e;
          }
          await database.collection('__dbpanel_init__').deleteMany({});
          await database.collection('__dbpanel_init__').drop().catch(() => undefined);
        } finally {
          await c.close();
        }
      } else if (kind === 'postgres' || kind === 'postgresql') {
        const { Client } = await import('pg');
        const client = new Client({ host: body.host, port: body.port || 5432, user: body.user || body.username, password: body.password, database: 'postgres' });
        try {
          await client.connect();
          await client.query(`CREATE DATABASE "${String(body.database).replaceAll('"', '""')}"`);
        } catch (e: any) {
          if (e?.code !== '42P04') throw e;
        } finally {
          await client.end();
        }
      } else if (kind === 'mysql' || kind === 'mariadb') {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection({ host: body.host, port: body.port || 3306, user: body.user || body.username, password: body.password });
        try {
          await conn.query(`CREATE DATABASE \`${String(body.database).replaceAll('`', '``')}\` CHARACTER SET utf8mb4`);
        } catch (e: any) {
          if (e?.code !== 'ER_DB_CREATE_EXISTS') throw e;
        } finally {
          await conn.end();
        }
      } else if (kind === 'oracle') {
        // У Oracle нет CREATE DATABASE: «база» панели здесь — схема, а схема
        // создаётся как пользователь. Пароль обязателен, поэтому берём его
        // из формы подключения.
        if (!body.password) throw Object.assign(new Error('Password is required to create an Oracle schema (user)'), { statusCode: 400 });
        const { getOraclePool } = await import('../core/pool.js');
        const pool = await getOraclePool({
          ...(body as any),
          kind: 'oracle',
          password: body.password,
          database: ''
        } as ConnectionConfig);
        const conn = await pool.getConnection();
        try {
          const name = String(body.database).replaceAll('"', '""');
          await conn.execute(`CREATE USER "${name}" IDENTIFIED BY "${String(body.password).replaceAll('"', '""')}" QUOTA UNLIMITED ON USERS`, {}, { autoCommit: true });
        } catch (e: any) {
          // ORA-01950 — нет прав на CREATE USER. Это 400 с понятным текстом,
          // а не 502 от сервера.
          if (e?.errorNum === 1920 || e?.errorNum === 1918) throw Object.assign(new Error('Creating a schema requires CREATE USER rights on the Oracle server'), { statusCode: 400 });
          throw e;
        } finally {
          conn.close().catch(() => undefined);
        }
      } else {
        throw Object.assign(new Error(`Create database is not supported for ${kind}`), { statusCode: 400 });
      }
    }
    const created = createConnection(cfg.metaPath, cfg.encryptionKeyHex, body as Parameters<typeof createConnection>[2]);
    audit(cfg.metaPath, created.id, 'conn.create', created.name, true, 0, u?.username);
    return created;
  });

  app.patch('/api/connections/:id', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    const current = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ['name', 'host', 'database', 'user'] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key === 'name' ? 'name' : key === 'host' ? 'host' : key === 'database' ? 'databaseName' : 'userName'}=?`);
        values.push(String(body[key] ?? ''));
      }
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid port'), { statusCode: 400 });
      fields.push('port=?'); values.push(port);
    }
    if (body.readOnly !== undefined) { fields.push('readOnly=?'); values.push(body.readOnly ? 1 : 0); }
    if (body.filePath !== undefined && current.kind === 'sqlite') {
      const filePath = normalizeSqlitePath(body.filePath);
      fields.push('filePath=?'); values.push(isAbsolute(filePath) ? filePath : resolve(dirname(cfg.metaPath), filePath));
    }
    if (body.password !== undefined && body.password !== '') { fields.push('passwordCipher=?'); values.push(encrypt(String(body.password), cfg.encryptionKeyHex)); }
    if (fields.length) {
      values.push(id);
      openMeta(cfg.metaPath).prepare(`UPDATE connections SET ${fields.join(', ')} WHERE id=?`).run(...values);
      audit(cfg.metaPath, id, 'conn.update', current.name, true, 0, u.username);
    }
    return listConnections(cfg.metaPath).find(connection => connection.id === id);
  });

  app.delete('/api/connections/:id', async (req, reply) => {
    const u = me(req);
    if (u && u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    let cc;
    try {
      cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    } catch (e: any) {
      throw Object.assign(new Error(`Connection not found: ${e.message}`), { statusCode: 404 });
    }
    assertNotReadOnly(cc);
    const dropDatabase = (req.query as { dropDatabase?: string } | undefined)?.dropDatabase === '1';
    if (!dropDatabase) {
      try {
        await deleteConnection(cfg.metaPath, id);
      } catch (e: any) {
        audit(cfg.metaPath, id, 'conn.delete', null, false, 0, u?.username);
        return reply.status(500).send({ ok: false, partial: true, databaseDropped: false, connectionMetadataDeleted: false, error: e.message ?? 'Failed to delete connection metadata' });
      }
      audit(cfg.metaPath, id, 'conn.delete', null, true, 0, u?.username);
      return { ok: true, databaseDropped: false };
    }
    if (cc.kind !== 'sqlite' && !cc.database) throw Object.assign(new Error('Connection database is required for physical deletion'), { statusCode: 400 });

    const t0 = Date.now();
    try {
      if (cc.kind === 'sqlite') {
        if (!cc.filePath) throw Object.assign(new Error('SQLite filePath is required'), { statusCode: 400 });
        const fs = await import('node:fs');
        fs.rmSync(cc.filePath, { force: true });
        fs.rmSync(cc.filePath + '-wal', { force: true });
        fs.rmSync(cc.filePath + '-shm', { force: true });
      } else if (cc.kind === 'mongodb') {
        const { MongoClient } = await import('mongodb');
        const auth = cc.user ? `${encodeURIComponent(cc.user)}:${encodeURIComponent(cc.password ?? '')}@` : '';
        const client = new MongoClient(`mongodb://${auth}${cc.host || 'localhost'}:${cc.port || 27017}`, { serverSelectionTimeoutMS: 5000 });
        try {
          await client.connect();
          await client.db(cc.database!).dropDatabase();
        } finally {
          await client.close();
        }
      } else if (cc.kind === 'postgres') {
        const { Client } = await import('pg');
        const client = new Client({ host: cc.host, port: cc.port || 5432, user: cc.user, password: cc.password, database: 'postgres' });
        try {
          await client.connect();
          await client.query(`DROP DATABASE "${cc.database!.replaceAll('"', '""')}" WITH (FORCE)`);
        } finally {
          await client.end();
        }
      } else if (cc.kind === 'mysql' || cc.kind === 'mariadb') {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection({ host: cc.host, port: cc.port || 3306, user: cc.user, password: cc.password });
        try {
          await conn.query(`DROP DATABASE \`${cc.database!.replaceAll('`', '``')}\``);
        } finally {
          await conn.end();
        }
      } else if (cc.kind === 'oracle') {
        // Удаление «базы» = удаление схемы, то есть пользователя. Соединение
        // остаётся валидным: следующая «база» в списке — это уже другая схема,
        // а текущая (удаляемая) в списке как раз исчезнет.
        const { getOraclePool } = await import('../core/pool.js');
        const pool = await getOraclePool({ ...cc, database: '' });
        const conn = await pool.getConnection();
        try {
          await conn.execute(`DROP USER "${cc.database!.replaceAll('"', '""')}" CASCADE`, {}, { autoCommit: true });
        } finally {
          conn.close().catch(() => undefined);
        }
      } else {
        throw Object.assign(new Error(`Unsupported connection kind: ${cc.kind}`), { statusCode: 400 });
      }
    } catch (e) {
      audit(cfg.metaPath, id, 'conn.delete', null, false, Date.now() - t0, u?.username);
      throw e;
    }

    try {
      await deleteConnection(cfg.metaPath, id);
    } catch (e: any) {
      audit(cfg.metaPath, id, 'conn.delete', null, false, Date.now() - t0, u?.username);
      return reply.status(500).send({
        ok: false,
        partial: true,
        databaseDropped: true,
        connectionMetadataDeleted: false,
        error: e.message ?? 'Failed to delete connection metadata'
      });
    }
    audit(cfg.metaPath, id, 'conn.delete', null, true, Date.now() - t0, u?.username);
    return { ok: true };
  });

  app.delete('/api/connections/:id/databases/:dbName', async (req, reply) => {
    const u = me(req);
    // Удаление БД необратимо — только админ (readonly/editor запрещены)
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id, dbName } = req.params as { id: string; dbName: string };
    let cc;
    try {
      cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    } catch (e: any) {
      throw Object.assign(new Error(`Подключение не найдено или повреждено: ${(e as Error).message}`), { statusCode: 404 });
    }
    assertNotReadOnly(cc);
    const lower = dbName.toLowerCase();
    const sysProtected =
      ((cc.kind === 'mysql' || cc.kind === 'mariadb') && ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(lower)) ||
      (cc.kind === 'postgres' && ['postgres', 'template0', 'template1'].includes(lower)) ||
      (cc.kind === 'mongodb' && ['admin', 'config', 'local'].includes(lower));
    if (sysProtected) {
      throw Object.assign(new Error(`База данных «${dbName}» системная и не может быть удалена`), { statusCode: 400 });
    }
    // dryRun: показать последствия удаления, ничего не выполняя
    if (((req.query ?? {}) as { dryRun?: string }).dryRun === '1') {
      const drv = getDriver(cc.kind);
      const tables = await drv?.listTables?.(cc, dbName).catch(() => [] as string[]) ?? [];
      audit(cfg.metaPath, id, 'db.drop.dryrun', `${dbName}:${tables.length}t`, true, 0, u?.username);
      return {
        dryRun: true, db: dbName, kind: cc.kind, tablesApprox: tables.length,
        sample: tables.slice(0, 20), requiresConfirm: true,
        note: cc.kind === 'sqlite'
          ? 'При подтверждении удаляется файл базы (и подключение, если имя не оканчивается на «(Faraja)»); сама база в файле остаётся до удаления файла'
          : 'При подтверждении база удаляется вместе со всеми таблицами и данными'
      };
    }
    const t0 = Date.now();
    try {
      if (cc.kind === 'sqlite') {
        const fs = await import('node:fs');
        if (!cc.filePath) throw Object.assign(new Error('SQLite filePath is required'), { statusCode: 400 });
        fs.rmSync(cc.filePath, { force: true });
        fs.rmSync(cc.filePath + '-wal', { force: true });
        fs.rmSync(cc.filePath + '-shm', { force: true });
        if (cc.name.endsWith('(Faraja)')) {
          audit(cfg.metaPath, id, 'db.drop', dbName, true, Date.now() - t0, u?.username);
          return { ok: true };
        }
        try {
          await deleteConnection(cfg.metaPath, id);
        } catch (e: any) {
          audit(cfg.metaPath, id, 'db.drop', dbName, false, Date.now() - t0, u?.username);
          return reply.status(500).send({ ok: false, partial: true, databaseDropped: true, connectionMetadataDeleted: false, error: e.message ?? 'Failed to delete connection metadata' });
        }
        audit(cfg.metaPath, id, 'db.drop', dbName, true, Date.now() - t0, u?.username);
        return { ok: true, connectionDeleted: true };
      }
      if (cc.kind === 'mongodb') {
        const { MongoClient } = await import('mongodb');
        const auth = cc.user ? `${encodeURIComponent(cc.user)}:${encodeURIComponent(cc.password ?? '')}@` : '';
        const client = new MongoClient(`mongodb://${auth}${cc.host || 'localhost'}:${cc.port || 27017}`, { serverSelectionTimeoutMS: 5000 });
        try {
          await client.connect();
          await client.db(dbName).dropDatabase();
        } finally {
          await client.close();
        }
      } else if (cc.kind === 'postgres') {
        const { Client } = await import('pg');
        const client = new Client({ host: cc.host, port: cc.port || 5432, user: cc.user, password: cc.password, database: 'postgres' });
        try {
          await client.connect();
          await client.query(`DROP DATABASE "${dbName.replaceAll('"', '""')}" WITH (FORCE)`);
        } finally {
          await client.end();
        }
      } else if (cc.kind === 'mysql' || cc.kind === 'mariadb') {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection({ host: cc.host, port: cc.port || 3306, user: cc.user, password: cc.password });
        try {
          await conn.query(`DROP DATABASE \`${dbName.replaceAll('`', '``')}\``);
        } finally {
          await conn.end();
        }
      } else if (cc.kind === 'oracle') {
        // Схема = пользователь: DROP USER CASCADE уносит и все его объекты.
        const { getOraclePool } = await import('../core/pool.js');
        const pool = await getOraclePool({ ...cc, database: '' });
        const conn = await pool.getConnection();
        try {
          await conn.execute(`DROP USER "${dbName.replaceAll('"', '""')}" CASCADE`, {}, { autoCommit: true });
        } finally {
          conn.close().catch(() => undefined);
        }
      } else {
        // Redis: «базы» — это номера 0…15, отдельной сущности для удаления нет.
        // FLUSHDB — другая операция (стирает ключи), её нельзя делать под видом DROP.
        throw Object.assign(
          new Error(cc.kind === 'redis'
            ? 'У Redis нет отдельных баз данных: «база» — это номер 0…15, удалить её нельзя (стираются только ключи командой FLUSHDB)'
            : `Удаление базы не поддерживается для ${cc.kind}`),
          { statusCode: 400 }
        );
      }
    } catch (e) {
      audit(cfg.metaPath, id, 'db.drop', dbName, false, Date.now() - t0, u?.username);
      throw e;
    }
    audit(cfg.metaPath, id, 'db.drop', dbName, true, Date.now() - t0, u?.username);
    return { ok: true };
  });

  app.post('/api/connections/:id/test', async (req) => {
    const u = me(req);
    const { id } = req.params as { id: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    try {
      const r = await d.test(cc);
      audit(cfg.metaPath, id, 'conn.test', null, true, Date.now() - t0, u?.username);
      return r;
    } catch (e) {
      audit(cfg.metaPath, id, 'conn.test', String((e as Error).message).slice(0, 200), false, Date.now() - t0, u?.username);
      // Неверный пароль или недоступный сервер — это ответ пользователю, а не
      // падение панели: без перевода кнопка «Проверить» показывала 500 без
      // текста, и неизвестно было, что именно исправлять.
      throw userFacingDbError(e);
    }
  });

  app.post('/api/databases', async (req) => {
    const u = me(req);
    if (u && u.role === 'readonly') throw Object.assign(new Error('Readonly cannot create databases'), { statusCode: 403 });
    const { connectionId, name: rawName, charset, collate, encoding, template, owner } = (req.body ?? {}) as { connectionId?: string; name?: string; charset?: string; collate?: string; encoding?: string; template?: string; owner?: string };
    if (!connectionId || !rawName) throw Object.assign(new Error('connectionId and name required'), { statusCode: 400 });
    const name = rawName.trim();
    let cc;
    try {
      cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connectionId);
    } catch (e: any) {
      console.error('loadDecrypted failed for', connectionId, e.message);
      throw Object.assign(new Error(`Подключение не найдено или повреждено: ${e.message}`), { statusCode: 400 });
    }
    // Правила имени — по одному набору на СУБД (пределы 63/64, наборы символов).
    // Раньше проверка была одна на все СУБД: она отвергала валидные имена с дефисом
    // у MongoDB и пропускала 64-символьные, которые MongoDB/PostgreSQL не принимают —
    // пользователь получал 502 вместо понятного 400.
    const nameProblem = validateDatabaseName(cc.kind, name);
    if (nameProblem) throw Object.assign(new Error(nameProblem), { statusCode: 400 });

    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    assertNotReadOnly(cc);
    if (cc.kind === 'sqlite') {
      const { dirname, join } = await import('node:path');
      const { mkdirSync, existsSync } = await import('node:fs');
      const baseDir = cc.filePath ? dirname(cc.filePath) : join(process.cwd(), 'data');
      mkdirSync(baseDir, { recursive: true });
      const filePath = join(baseDir, `${name}.sqlite`);
      if (!existsSync(filePath)) {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(filePath);
        db.pragma('journal_mode = WAL');
        db.close();
      }
      const created = createConnection(cfg.metaPath, cfg.encryptionKeyHex, {
        name: `${name} (SQLite)`, kind: 'sqlite', filePath, readOnly: false
      } as any);
      audit(cfg.metaPath, created.id, 'conn.create', created.name, true, 0, u?.username);
      return { name, type: 'sqlite', connectionId: created.id };
    }
    if (cc.kind === 'mongodb') {
      // MongoDB создаёт БД лениво — материализуем её служебной коллекцией
      const { MongoClient } = await import('mongodb');
      const user = (cc as any).user ? `${encodeURIComponent((cc as any).user)}:${encodeURIComponent((cc as any).password ?? '')}@` : '';
      const c = new MongoClient(`mongodb://${user}${cc.host ?? 'localhost'}:${(cc as any).port ?? 27017}`, { serverSelectionTimeoutMS: 10000 } as any);
      try {
        await c.connect();
        // MongoDB не даёт создать базу, отличающуюся от существующей только регистром
        // («shop» и «Shop»): это 400 с понятным текстом, а не 502 от сервера.
        const existing = (await c.db().admin().listDatabases()).databases.map(d => d.name);
        const clash = existing.find(n => n !== name && n.toLowerCase() === name.toLowerCase());
        if (clash) throw Object.assign(new Error(`В MongoDB нельзя создать «${name}»: база «${clash}» отличается только регистром`), { statusCode: 400 });
        if (existing.includes(name)) throw Object.assign(new Error(`База «${name}» уже существует`), { statusCode: 400 });
        await c.db(name).createCollection('_init');
      } catch (e2: any) {
        // Наши собственные 400 (например, имя отличается только регистром) —
        // не заворачиваем их в 502 «не удалось создать».
        if (e2?.statusCode) throw e2;
        throw Object.assign(new Error(`Не удалось создать БД в MongoDB: ${(e2 as Error).message}`), { statusCode: 502 });
      } finally {
        await c.close().catch(() => {});
      }
      audit(cfg.metaPath, connectionId, 'db.create', name, true, 0, u?.username);
      return { name, type: cc.kind };
    }
    if (cc.kind === 'postgres') {
      // CREATE DATABASE нельзя выполнять будучи подключённым к создаваемой БД —
      // идём напрямую через maintenance-БД postgres
      const pg = await import('pg');
      const { Client } = pg;
      // ENCODING/TEMPLATE/OWNER — только из белого списка, иначе инъекция в DDL.
      const enc = encoding ? String(encoding).toUpperCase().replace(/[^A-Z0-9_]/g, '') : '';
      const tpl = template ? String(template).replaceAll('"', '""') : '';
      const own = owner ? String(owner).replaceAll('"', '""') : '';
      if (enc && !['UTF8', 'LATIN1', 'SQL_ASCII'].includes(enc)) throw Object.assign(new Error('Bad encoding (UTF8/LATIN1/SQL_ASCII)'), { statusCode: 400 });
      if (own && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(owner as string)) throw Object.assign(new Error('Bad owner name'), { statusCode: 400 });
      const opts = [enc ? ` ENCODING '${enc}'` : '', tpl ? ` TEMPLATE "${tpl}"` : '', own ? ` OWNER "${own}"` : ''].join('');
      const client = new Client({ host: cc.host, port: (cc as any).port || 5432, user: (cc as any).user, password: (cc as any).password, database: 'postgres' });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"${opts}`);
        await client.end();
      } catch (e2: any) {
        // Наши собственные 400 (например, имя отличается только регистром) —
        // не заворачиваем их в 502 «не удалось создать».
        if (e2?.statusCode) throw e2;
        throw Object.assign(new Error(`Не удалось создать БД в PostgreSQL: ${(e2 as Error).message}`), { statusCode: 502 });
      }
      audit(cfg.metaPath, connectionId, 'db.create', name, true, 0, u?.username);
      return { name, type: cc.kind };
    }
    if (cc.kind === 'mysql' || cc.kind === 'mariadb') {
      // Создаём через соединение БЕЗ выбора БД, чтобы не зависеть от default-БД
      // CHARSET/COLLATE — только из белого списка во избежание инъекции в DDL.
      const cs = charset ? String(charset).toLowerCase().replace(/[^a-z0-9_]/g, '') : 'utf8mb4';
      const cl = collate ? String(collate).toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
      if (!/^[a-z0-9_]{3,32}$/.test(cs)) throw Object.assign(new Error('Bad charset'), { statusCode: 400 });
      if (cl && !/^[a-z0-9_]{3,64}$/.test(cl)) throw Object.assign(new Error('Bad collate'), { statusCode: 400 });
      const mysql = await import('mysql2/promise');
      let conn: any = null;
      try {
        conn = await mysql.createConnection({ host: cc.host, port: (cc as any).port || 3306, user: (cc as any).user, password: (cc as any).password });
        await conn.query(`CREATE DATABASE \`${name.replaceAll('`', '``')}\` CHARACTER SET ${cs}${cl ? ` COLLATE ${cl}` : ''}`);
      } catch (e2: any) {
        // Наши собственные 400 (например, имя отличается только регистром) —
        // не заворачиваем их в 502 «не удалось создать».
        if (e2?.statusCode) throw e2;
        throw Object.assign(new Error(`Не удалось создать БД в ${cc.kind}: ${(e2 as Error).message}`), { statusCode: 502 });
      } finally {
        try { await conn?.end(); } catch {}
      }
      audit(cfg.metaPath, connectionId, 'db.create', name, true, 0, u?.username);
      return { name, type: cc.kind };
    }
    if ((cc as any).kind === 'redis') {
      throw Object.assign(new Error('В Redis нет баз данных — используйте номер БД 0..15'), { statusCode: 400 });
    }
    if (cc.kind === 'oracle') {
      // Схема панели = пользователь Oracle. Создаём пользователя с паролем
      // подключения: без пароля он был бы заблокирован (ORA-28003).
      // Сразу выдаём минимальные гранты, иначе схема не может даже войти
      // и создать таблицу (прошлый вариант оставлял её заблокированной).
      if (!cc.password) throw Object.assign(new Error('В подключении нужен пароль: пользователь Oracle создаётся с паролем'), { statusCode: 400 });
      const { getOraclePool } = await import('../core/pool.js');
      const pool = await getOraclePool({ ...cc, database: '' });
      const conn = await pool.getConnection();
      try {
        await conn.execute(
          `CREATE USER "${name.replaceAll('"', '""')}" IDENTIFIED BY "${cc.password.replaceAll('"', '""')}" QUOTA UNLIMITED ON USERS`,
          {},
          { autoCommit: true }
        );
        const grants = ['CREATE SESSION', 'CREATE TABLE', 'CREATE SEQUENCE', 'CREATE VIEW', 'CREATE TRIGGER'];
        for (const g of grants) {
          try { await conn.execute(`GRANT ${g} TO "${name.replaceAll('"', '""')}"`, {}, { autoCommit: true }); } catch { /* best-effort */ }
        }
      } catch (e2: any) {
        // Наши собственные 400 не заворачиваем в 502 «не удалось создать».
        if (e2?.statusCode) throw e2;
        if (e2?.errorNum === 1920 || e2?.errorNum === 1918) {
          throw Object.assign(new Error('Для создания схемы нужны права CREATE USER на сервере Oracle'), { statusCode: 400 });
        }
        throw Object.assign(new Error(`Не удалось создать схему в Oracle: ${(e2 as Error).message}`), { statusCode: 502 });
      } finally {
        conn.close().catch(() => undefined);
      }
      audit(cfg.metaPath, connectionId, 'db.create', name, true, 0, u?.username);
      return { name, type: cc.kind };
    }
    const q = `CREATE DATABASE \`${name.replaceAll('`', '``')}\` CHARACTER SET utf8mb4`;
    try {
      await d.query(cc, q, { maxRows: 0, timeoutMs: 10000 } as any);
    } catch (e) {
      throw e;
    }
    audit(cfg.metaPath, connectionId, 'db.create', name, true, 0, u?.username);
    return { name, type: cc.kind };
  });

  app.get('/api/audit', async (req) => {
    const u = me(req);
    if (u && u.role === 'readonly') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const { limit, connId } = (req.query ?? {}) as { limit?: string; connId?: string };
    const lim = Math.min(Math.max(Number(limit ?? 100) || 100, 1), 500);
    const rows = (connId
      ? openMeta(cfg.metaPath).prepare(`SELECT * FROM audit WHERE connId=? ORDER BY id DESC LIMIT ?`).all(connId, lim)
      : openMeta(cfg.metaPath).prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(lim)) as (Record<string, unknown> & { valuesJson?: string | null })[];
    // valuesJson — распаковываем в объект `values`, сырой столбец наружу не отдаём
    return rows.map(({ valuesJson, ...rest }) => {
      let values: unknown = null;
      if (valuesJson) {
        try { values = JSON.parse(valuesJson); } catch { values = null; }
      }
      return { ...rest, values };
    });
  });

  // Полная очистка журнала операций. Только администратор: журнал — след действий
  // всех пользователей, стирать его рядовому нельзя.
  app.delete('/api/audit', async (req) => {
    const u = me(req);
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { connId, all } = (req.query ?? {}) as { connId?: string; all?: string };
    // all=1 — весь журнал, иначе только журнал выбранного подключения
    const deleted = clearAudit(cfg.metaPath, all === '1' ? undefined : connId);
    // запись о самой очистке делаем ПОСЛЕ удаления, иначе исчезнет вместе с ним
    audit(cfg.metaPath, connId ?? null, 'audit.clear', `deleted=${deleted}`, true, 0, u.username);
    return { ok: true, deleted };
  });
}
