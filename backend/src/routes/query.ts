import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { audit, loadDecrypted } from '../core/context.js';
import { assertRoleWritable, type PanelUser } from '../core/auth.js';
import { userFacingDbError } from '../core/dberror.js';
import { renderTable, renderDb } from '../core/dump.js';
import { dependencyOrder } from '../core/tableorder.js';
import { addHistory } from '../core/history.js';
import { translateTsSql } from '../drivers/helpers.js';
import { isMongoWriteQuery } from '../drivers/mongodb.js';
import { isRedisWriteQuery } from '../drivers/redis.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

export function queryRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/query', async (req) => {
    const u = me(req);
    const { id } = req.params as { id: string };
    const { sql, db } = (req.body ?? {}) as { sql?: string; db?: string };
    if (!sql || sql.length > 100_000) throw Object.assign(new Error('Bad sql'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const roleQuery = cc.kind === 'mongodb' && isMongoWriteQuery(sql)
      ? 'delete'
      : cc.kind === 'redis' && isRedisWriteQuery(sql) ? 'delete' : sql;
    assertRoleWritable(u?.role, roleQuery);
    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    // Контекст выбранной БД: запрос выполняется ТАМ, где пользователь смотрит
    // таблицы. Иначе CREATE уходит в default-БД, а панель показывает выбранную.
    const qcc = { ...cc, database: db || cc.database };
    const t0 = Date.now();
    try {
      // Совместимость с T-SQL из нейросетей (IDENTITY, GETDATE, [name])
      const r = await d.query(qcc, translateTsSql(sql, cc.kind), { maxRows: cfg.queryMaxRows, timeoutMs: cfg.queryTimeoutMs });
      audit(cfg.metaPath, id, 'query', sql.slice(0, 200), true, r.execMs, u?.username);
      if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: qcc.database ?? null, sql, ok: true, execMs: r.execMs });
      return r;
    } catch (e) {
      audit(cfg.metaPath, id, 'query', sql.slice(0, 200), false, Date.now() - t0, u?.username);
      if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: qcc.database ?? null, sql, ok: false, execMs: Date.now() - t0 });
      // Ошибка самого SQL — это ответ сервера базы («нет такой таблицы»,
      // «синтаксическая ошибка»), а не падение панели: без перевода пользователь
      // видел только «Internal server error» и не понимал, что исправлять.
      throw userFacingDbError(e, sql);
    }
  });

  // Экспорт всей таблицы потоком: память константна, объём любой.
  // Форматы: csv | json | sql. Mongo в sql недоступен (нет SQL-диалекта).
  app.get('/api/connections/:id/:db/:table/export', async (req, reply) => {
    const u = me(req);
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { format } = (req.query ?? {}) as { format?: string };
    if (!['csv', 'json', 'sql'].includes(format ?? '')) throw Object.assign(new Error('format must be csv|json|sql'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    if (cc.kind === 'mongodb' && format === 'sql') throw Object.assign(new Error('SQL dump not available for MongoDB'), { statusCode: 400 });
    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const tname = decodeURIComponent(table);
    const dbname = decodeURIComponent(db);
    const ct = format === 'csv' ? 'text/csv; charset=utf-8' : format === 'sql' ? 'application/sql; charset=utf-8' : 'application/json; charset=utf-8';
    reply.header('content-type', ct).header('content-disposition', `attachment; filename="${tname}.${format}"`);
    const stream = Readable.from(renderTable(format as string, d, cc, dbname, tname));
    stream.on('error', (e) => req.log.error(e));
    stream.on('end', () => audit(cfg.metaPath, id, 'export', `${format}:${dbname}.${tname}`, true, Date.now() - t0, u?.username));
    return reply.send(stream);
  });

  /**
   * Экспорт всей базы потоком: та же логика, что у таблицы, но таблиц много.
   *
   * Порядок берётся из списка таблиц сервера и переставляется по внешним
   * ключам (родители раньше детей): иначе дамп не восстанавливается, потому что
   * таблица с FK может попасть раньше той, на которую ссылается. Не выбранные
   * вручную таблицы можно исключить параметром tables=a,b.
   */
  app.get('/api/connections/:id/:db/export', async (req, reply) => {
    const u = me(req);
    const { id, db } = req.params as { id: string; db: string };
    const { format, tables: only } = (req.query ?? {}) as { format?: string; tables?: string };
    if (!['csv', 'json', 'sql'].includes(format ?? '')) throw Object.assign(new Error('format must be csv|json|sql'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    if (cc.kind === 'mongodb' && format === 'sql') throw Object.assign(new Error('SQL dump not available for MongoDB'), { statusCode: 400 });
    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const dbname = decodeURIComponent(db);
    const all = await d.listTables(cc, dbname).catch(() => [] as string[]);
    const wanted = only ? new Set(String(only).split(',').map((x) => decodeURIComponent(x.trim())).filter(Boolean)) : null;
    const picked = (wanted ? all.filter((t) => wanted.has(t)) : all);
    if (!picked.length) throw Object.assign(new Error(`No tables to export in ${dbname}`), { statusCode: 404 });
    if (wanted && picked.length !== wanted.size) {
      const missing = [...wanted].filter((t) => !picked.includes(t));
      throw Object.assign(new Error(`Unknown table(s): ${missing.join(', ')}`), { statusCode: 404 });
    }
    const ordered = await dependencyOrder(picked, async (t) => {
      const sc = await d.getSchema(cc, dbname, t);
      return [...new Set((sc?.foreignKeys ?? []).map((fk) => fk.refTable))];
    });
    const ct = format === 'csv' ? 'text/csv; charset=utf-8' : format === 'sql' ? 'application/sql; charset=utf-8' : 'application/json; charset=utf-8';
    reply.header('content-type', ct).header('content-disposition', `attachment; filename="${dbname}.${format}"`);
    const stream = Readable.from(renderDb(format as string, d, cc, dbname, ordered));
    stream.on('error', (e) => req.log.error(e));
    stream.on('end', () => audit(cfg.metaPath, id, 'export', `${format}:${dbname}:${ordered.length} tables`, true, Date.now() - t0, u?.username));
    return reply.send(stream);
  });
}
