import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import { getDriver } from '../plugins/registry.js';
import { loadDecrypted, audit } from '../core/context.js';
import {
  createModel, deleteModel, getModel, getVersion, listModels, listVersions,
  restoreVersion, saveModel, updateModelMeta, type ModelTable
} from '../core/models.js';
import { createCheckpoint } from '../core/checkpoints.js';
import { diffModelTables, schemaToModelTable } from '../core/drift.js';
import { mapColumnType, mapDefault } from '../core/typemap.js';
import type { AlterOp, ColumnDef, CreateTableDef, DbKind } from '../core/types.js';
import type { DesignDialect } from '../drivers/helpers.js';

/**
 * Диалект генераторов DDL по типу подключения.
 *
 * Тот же список, что у драйверов, но в одном месте для маршрута: модель
 * применяется драйвером целевого подключения, и переводить типы колонок надо
 * ровно в его диалект. Раньше типы уезжали как есть и работали только потому,
 * что словари MySQL и PostgreSQL совпадали на большинстве имён.
 */
const DIALECT_BY_KIND: Record<DbKind, DesignDialect> = {
  mysql: 'mysql',
  mariadb: 'mysql',
  postgres: 'pg',
  sqlite: 'sqlite',
  oracle: 'oracle',
  // MongoDB и Redis не имеют диалектных типов строк: конструктор для них и так
  // недоступен, и переводить нечего.
  mongodb: 'mysql',
  redis: 'mysql'
};

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function bad(message: string, code = 400): never {
  throw Object.assign(new Error(message), { statusCode: code });
}

/**
 * Модели проекта: сохранённые схемы целиком. Отличаются от точки восстановления
 * (дамп одной таблицы) и от отката DDL (один пакет): модель версионируется и
 * применяется к другой базе.
 *
 * Права: читать может любой авторизованный (включая readonly), сохранять —
 * editor и admin, удалять — только admin.
 */
export function modelRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/models', async (req) => {
    if (!me(req)) bad('Unauthorized', 401);
    const { q, dbKind, limit } = (req.query ?? {}) as Record<string, string>;
    return listModels(cfg.metaPath, { q, dbKind, limit: limit ? Number(limit) : 100 });
  });

  app.post('/api/models', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot create models', 403);
    const { name, dbKind, dbName, comment, tables } = (req.body ?? {}) as {
      name?: string; dbKind?: string; dbName?: string; comment?: string; tables?: unknown;
    };
    if (!tables) bad('tables required');
    return createModel(cfg.metaPath, { name, dbKind, dbName, comment, tables, actor: u?.username });
  });

  /** Забирает схему существующей базы в модель — основной сценарий «сохранить». */
  app.post('/api/models/import', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot import models', 403);
    const { connId, db, name, comment, includeData } = (req.body ?? {}) as {
      connId?: string; db?: string; name?: string; comment?: string; includeData?: boolean;
    };
    if (!connId || !db || !name) bad('connId, db and name required');
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connId);
    const d = getDriver(cc.kind);
    if (!d) bad(`No driver for ${cc.kind}`);
    const names = await d.listTables(cc, db);
    if (!names.length) bad(`Database ${db} has no tables`);
    const tables: ModelTable[] = [];
    for (const t of names.slice(0, 200)) {
      const s = await d.getSchema(cc, db, t);
      tables.push(schemaToModelTable(s));
    }
    const model = createModel(cfg.metaPath, {
      name, dbKind: cc.kind, dbName: db, comment, tables, actor: u?.username
    });
    audit(cfg.metaPath, connId, 'model.import', `${db}:${tables.length}t`, true, 0, u?.username);
    return model;
  });

  app.get('/api/models/:id', async (req) => {
    if (!me(req)) bad('Unauthorized', 401);
    const { id } = req.params as { id: string };
    return getModel(cfg.metaPath, id);
  });

  app.put('/api/models/:id', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot save models', 403);
    const { id } = req.params as { id: string };
    const { tables, comment, expectedVersion, note } = (req.body ?? {}) as {
      tables?: unknown; comment?: string | null; expectedVersion?: number; note?: string | null;
    };
    if (!tables) bad('tables required');
    return saveModel(cfg.metaPath, id, { tables, comment, expectedVersion, note, actor: u?.username });
  });

  app.patch('/api/models/:id', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot edit models', 403);
    const { id } = req.params as { id: string };
    const { name, comment, dbKind, dbName } = (req.body ?? {}) as Record<string, unknown>;
    return updateModelMeta(cfg.metaPath, id, { name, comment: comment as string | null, dbKind: dbKind as string | null, dbName: dbName as string | null, actor: u?.username });
  });

  app.delete('/api/models/:id', async (req) => {
    const u = me(req);
    if (!u) bad('Unauthorized', 401);
    if (u.role !== 'admin') bad('Admin only', 403);
    const { id } = req.params as { id: string };
    deleteModel(cfg.metaPath, id, u.username);
    return { ok: true };
  });

  app.get('/api/models/:id/versions', async (req) => {
    if (!me(req)) bad('Unauthorized', 401);
    const { id } = req.params as { id: string };
    const { limit } = (req.query ?? {}) as Record<string, string>;
    return listVersions(cfg.metaPath, id, limit ? Number(limit) : 20);
  });

  app.get('/api/models/:id/versions/:versionId', async (req) => {
    if (!me(req)) bad('Unauthorized', 401);
    const { id, versionId } = req.params as { id: string; versionId: string };
    return { tables: getVersion(cfg.metaPath, id, versionId) };
  });

  app.post('/api/models/:id/versions/:versionId/restore', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot restore models', 403);
    const { id, versionId } = req.params as { id: string; versionId: string };
    return restoreVersion(cfg.metaPath, id, versionId, u?.username);
  });

  /**
   * Сравнение модели с базой: чего не хватает, что лишнее и что разошлось.
   * Ничего не меняет — только отчёт. `includeExtra` отключает «лишние» объекты
   * (база может быть богаче модели намеренно, например, служебные таблицы).
   */
  app.post('/api/models/:id/diff', async (req) => {
    if (!me(req)) bad('Unauthorized', 401);
    const { id } = req.params as { id: string };
    const { connId, db, includeExtra } = (req.body ?? {}) as { connId?: string; db?: string; includeExtra?: boolean };
    if (!connId || !db) bad('connId and db required');
    const model = getModel(cfg.metaPath, id);
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connId);
    const d = getDriver(cc.kind);
    if (!d) bad(`No driver for ${cc.kind}`);
    const t0 = Date.now();
    const names = await d.listTables(cc, db);
    const actual: ModelTable[] = [];
    for (const t of names) {
      // Одна сломанная таблица (нет прав) не должна ронять весь отчёт
      try { actual.push(schemaToModelTable(await d.getSchema(cc, db, t))); } catch { /* пропускаем */ }
    }
    const report = diffModelTables(model.tables, actual);
    if (includeExtra === false) {
      report.extraTables = [];
      for (const t of report.changedTables) { t.extraColumns = []; t.extraIndexes = []; t.extraForeignKeys = []; t.extraTriggers = []; }
    }
    audit(cfg.metaPath, connId, 'model.diff', `${model.name}:${db}:m${report.summary.missing}/e${report.summary.extra}/c${report.summary.changed}`, true, Date.now() - t0, me(req)?.username);
    return { model: { id: model.id, name: model.name, version: model.version, dbKind: model.dbKind }, db, connKind: cc.kind, ...report, execMs: Date.now() - t0 };
  });

  /**
   * Применение модели к базе. Существующие таблицы по умолчанию не трогаются
   * (в отчёт попадают как skipped), а `dropExisting: true` пересоздаёт их.
   * Перед заменой каждой таблицы снимается точка восстановления.
   */
  app.post('/api/models/:id/apply', async (req) => {
    const u = me(req);
    if (u?.role === 'readonly') bad('Readonly cannot apply models', 403);
    const { id } = req.params as { id: string };
    const { connId, db, dropExisting } = (req.body ?? {}) as { connId?: string; db?: string; dropExisting?: boolean };
    if (!connId || !db) bad('connId and db required');
    const model = getModel(cfg.metaPath, id);
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connId);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d) bad(`No driver for ${cc.kind}`);
    const t0 = Date.now();
    const existing = new Set(await d.listTables(cc, db));
    const statements: string[] = [];
    const created: string[] = [];
    const replaced: string[] = [];
    const skipped: string[] = [];
    const errors: { table: string; error: string }[] = [];

    // FK добавляем после всех таблиц — иначе порядок создания не имеет значения
    const pendingFks: { table: string; ops: AlterOp[] }[] = [];
    // Таблицы, которые в этом прогоне реально созданы. FK и триггеры к не
    // созданным не применяем: ALTER против отсутствующей таблицы даёт от
    // сервера ORA-00942 / 42P01 про чужую таблицу, и в отчёте это выглядело
    // как «модель не применилась», хотя дело в пропущенной таблице.
    const createdTables = new Set<string>();
    // Удалять надо в обратном порядке зависимостей: на родительскую таблицу
    // ссылается FK, поэтому её нельзя удалить, пока дети живы (PG/MySQL).
    const referenced = new Set<string>();
    for (const t of model.tables) for (const f of t.foreignKeys ?? []) if (f.refTable) referenced.add(f.refTable.toLowerCase());
    const ordered = [...model.tables].sort((a, b) => Number(referenced.has(a.name.toLowerCase())) - Number(referenced.has(b.name.toLowerCase())));

    for (const t of ordered) {
      try {
        if (t.kind === 'view') { skipped.push(`${t.name} (view, не создаётся)`); continue; }
        const has = existing.has(t.name);
        if (has && !dropExisting) { skipped.push(`${t.name} (уже есть)`); continue; }
        if (has) {
          if (!d.dropTable) { errors.push({ table: t.name, error: 'dropTable not supported' }); continue; }
          // Точка восстановления до пересоздания — данные таблицы могут быть неверными
          try {
            const cp = await createCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, {
              connId, db, table: t.name, reason: 'before model apply', actor: u?.username ?? null
            });
            statements.push(`-- checkpoint ${cp.id} (${cp.rows} rows)`);
          } catch (e: any) {
            errors.push({ table: t.name, error: `checkpoint failed: ${String(e?.message).slice(0, 120)}` });
            continue;
          }
          const dropped = await d.dropTable(cc, db, t.name);
          statements.push(dropped.statement);
          replaced.push(t.name);
        }
        // Типы модели хранятся в лексиконе исходной СУБД (у MySQL — VARCHAR и
        // TEXT, у PostgreSQL — text/jsonb), а создаёт таблицу драйвер целевого
        // подключения со своим allowlist. Поэтому типы переводятся в диалект
        // цели ДО createTable: иначе перенос модели в Oracle падал с
        // «Bad column type for oracle: VARCHAR(100)».
        const target = DIALECT_BY_KIND[cc.kind];
        const modelFks = (t.foreignKeys ?? []).map((f) => ({
          name: f.name ?? undefined,
          columns: f.columns,
          refTable: f.refTable,
          refColumns: f.refColumns,
          onDelete: f.onDelete ?? undefined,
          onUpdate: f.onUpdate ?? undefined,
        }));
        const def: CreateTableDef = {
          name: t.name,
          columns: t.columns.map((c): ColumnDef => ({
            name: c.name,
            type: mapColumnType(c.type, target),
            nullable: c.nullable,
            primary: c.primary,
            autoInc: c.autoInc,
            default: mapDefault(c.default, target) as string | null
          }))
        };
        // SQLite не умеет ALTER TABLE ADD CONSTRAINT, поэтому ключ к новой
        // таблице можно только объявить в CREATE. Без этого модель, применённая
        // к SQLite, теряла все внешние ключи.
        if (cc.kind === 'sqlite' && modelFks.length) def.foreignKeys = modelFks;
        if (!d.createTable) { errors.push({ table: t.name, error: `createTable not supported for ${cc.kind}` }); continue; }
        const r = await d.createTable(cc, db, def);
        statements.push(r.statement);
        created.push(t.name);
        createdTables.add(t.name.toLowerCase());
        const ops: AlterOp[] = [];
        for (const i of t.indexes ?? []) ops.push({ op: 'addIndex', index: { name: i.name, columns: i.columns, unique: i.unique, type: i.type ?? undefined, where: i.where ?? undefined } });
        for (const f of modelFks) {
          if (cc.kind === 'sqlite') continue; // уже объявлен в CREATE TABLE
          ops.push({ op: 'addForeignKey', fk: f });
        }
        if (ops.length) pendingFks.push({ table: t.name, ops });
      } catch (e: any) {
        // Одна таблица не должна ронять весь apply: остальные применяем, отчёт — в errors
        errors.push({ table: t.name, error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    for (const { table, ops } of pendingFks) {
      // Таблица могла не создаться (например, тип не переводится в целевой
      // диалект). Молчаливый ALTER против несуществующей таблицы дал бы от
      // сервера ошибку про посторонний объект — сообщаем о своей причине.
      if (!createdTables.has(table.toLowerCase())) {
        errors.push({ table, error: 'not created in this run: indexes and foreign keys are skipped' });
        continue;
      }
      if (!d.alterTable) { errors.push({ table, error: 'alterTable not supported' }); continue; }
      try {
        const r = await d.alterTable(cc, db, table, ops);
        statements.push(...r.statements);
      } catch (e: any) {
        errors.push({ table, error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    for (const t of model.tables) {
      if (!createdTables.has(t.name.toLowerCase())) {
        if ((t.triggers ?? []).length) errors.push({ table: t.name, error: 'not created in this run: triggers are skipped' });
        continue;
      }
      for (const g of t.triggers ?? []) {
        if (!d.createTrigger) { errors.push({ table: t.name, error: 'triggers not supported' }); continue; }
        try {
          const r = await d.createTrigger(cc, db, t.name, { name: g.name, timing: g.timing, event: g.event, statement: g.statement });
          statements.push(r.statement);
        } catch (e: any) {
          errors.push({ table: t.name, error: String(e?.message ?? e).slice(0, 200) });
        }
      }
    }
    const ms = Date.now() - t0;
    audit(cfg.metaPath, connId, 'model.apply', `${model.name}:${db}:+${created.length}/~${replaced.length}`, errors.length === 0, ms, u?.username);
    return { ok: errors.length === 0, model: model.name, db, created, replaced, skipped, errors, statements, execMs: ms };
  });
}
