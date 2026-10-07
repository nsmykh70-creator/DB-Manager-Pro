import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { audit, latestDesignSnapshot, loadDecrypted, saveDesignSnapshot } from '../core/context.js';
import { addHistory } from '../core/history.js';
import { renderTableDdl } from '../core/dump.js';
import { createCheckpoint } from '../core/checkpoints.js';
import { assertRoleWritable, type PanelUser } from '../core/auth.js';
import { userFacingDbError } from '../core/dberror.js';
import { withCode } from '../core/errcodes.js';
import type { AlterOp, CreateTableDef, TriggerDef, ViewDef } from '../core/types.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

/** Возвращает id созданной точки восстановления или null. */
async function autoCheckpointBeforeDataLoss(
  cfg: AppConfig,
  cc: ReturnType<typeof loadDecrypted>,
  connId: string,
  dbName: string,
  tableName: string,
  ops: AlterOp[],
  actor?: string
): Promise<string | null> {
  const dropsData = ops.some((o: any) => o.op === 'dropColumn');
  if (!dropsData) return null;
  try {
    const cp = await createCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, {
      connId, db: dbName, table: tableName, reason: 'before dropColumn', actor,
    });
    return cp.id;
  } catch (e) {
    // Точка восстановления — страховка, а не условие операции: если таблица
    // слишком велика или дамп не удался, операция всё равно выполняется.
    audit(cfg.metaPath, connId, 'checkpoint', `${dbName}.${tableName}:skipped (${String((e as Error).message).slice(0, 100)})`, false, 0, actor);
    return null;
  }
}

/**
 * Коды ошибок драйверов про уже существующий/отсутствующий объект — это 409/404,
 * а не 500: без перевода «триггер уже есть» выглядел бы как внутренняя ошибка.
 */const DRIVER_CONFLICT_CODES = new Set(['ER_TRG_ALREADY_EXISTS', 'ER_FK_DUP_NAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR', '42710', '42P07', '23505', '42P06', '2BP01']);
const DRIVER_MISSING_CODES = new Set(['ER_TRG_DOES_NOT_EXIST', 'ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR', '42P01', '42704', '3F000']);

function translateDriverError(e: any): Error {
  const code = String(e?.code ?? '');
  if (DRIVER_CONFLICT_CODES.has(code)) return Object.assign(new Error(`Already exists: ${String(e?.sqlMessage ?? e?.message ?? code)}`), { statusCode: 409 });
  if (DRIVER_MISSING_CODES.has(code)) return Object.assign(new Error(`Not found: ${String(e?.sqlMessage ?? e?.message ?? code)}`), { statusCode: 404 });
  // MariaDB вешает на отсутствие VIEW чужой код (ER_INNODB_MAX_ROW_VERSION при
  // sqlState 42S02): опознаём по тексту «Unknown VIEW/TABLE», как MySQL 8.4
  // опознаётся по ER_BAD_TABLE_ERROR.
  const text = String(e?.sqlMessage ?? e?.message ?? '');
  if (/unknown (table|view)\b/i.test(text)) return Object.assign(new Error(`Not found: ${text.slice(0, 200)}`), { statusCode: 404 });
  // Oracle отдаёт номер ошибки, а не SQLSTATE: 955 — имя уже занято
  // (дубль таблицы/представления/триггера), 942 — объекта нет.
  if (e?.errorNum === 955) return Object.assign(new Error(`Already exists: ${String(e?.message ?? 'ORA-00955').slice(0, 200)}`), { statusCode: 409 });
  if (e?.errorNum === 942) return Object.assign(new Error(`Not found: ${String(e?.message ?? 'ORA-00942').slice(0, 200)}`), { statusCode: 404 });
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Плоский список значимых строк схемы: колонки, индексы, FK, триггеры.
 * Используется для снапшота (undo) и для diff «до → после» в предпросмотре.
 */
export function schemaLines(schema: {
  columns?: { name: string; type: string; nullable?: boolean; primary?: boolean; default?: string | null }[];
  indexes?: { name: string; unique?: boolean; primary?: boolean; columns?: string[] }[];
  foreignKeys?: { name: string; columns?: string[]; refTable: string; refColumns?: string[]; onDelete?: string | null; onUpdate?: string | null }[];
  triggers?: { name: string; timing?: string | null; event?: string | null; statement?: string }[];
} | null | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  for (const col of schema.columns ?? []) {
    out.push(`column ${col.name} ${col.type} ${col.primary ? 'PK' : col.nullable === false ? 'NOT NULL' : 'NULL'}${col.default ? ` DEFAULT ${col.default}` : ''}`);
  }
  for (const ix of schema.indexes ?? []) {
    out.push(`index ${ix.name} ${ix.primary ? 'PRIMARY' : ix.unique ? 'UNIQUE' : 'INDEX'} (${(ix.columns ?? []).join(',')})`);
  }
  for (const fk of schema.foreignKeys ?? []) {
    const rules = [fk.onDelete ? `ON DELETE ${fk.onDelete}` : '', fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : ''].filter(Boolean).join(' ');
    out.push(`fk ${fk.name} (${(fk.columns ?? []).join(',')}) -> ${fk.refTable}(${(fk.refColumns ?? []).join(',')})${rules ? ' ' + rules : ''}`);
  }
  for (const trg of schema.triggers ?? []) {
    // Тело триггера тоже попадает в описание: без него откат не сможет его
    // восстановить, а пересоздать триггер можно только из полного текста.
    out.push(`trigger ${trg.name} ${trg.timing ?? ''} ${trg.event ?? ''} :: ${trg.statement ?? ''}`.replace(/\s+/g, ' ').trim());
  }
  return out;
}

export function designRoutes(app: FastifyInstance, cfg: AppConfig): void {
  // Создать таблицу/коллекцию
  app.post('/api/connections/:id/:db/tables', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'create table');
    const { id, db } = req.params as { id: string; db: string };
    const def = (req.body ?? {}) as CreateTableDef;
    if (!def.name || !Array.isArray(def.columns)) throw Object.assign(new Error('Need {name, columns[]}'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d?.createTable) throw Object.assign(new Error(`Create not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    // Ошибка DDL от сервера — это ответ пользователю (ORA-03076 «unexpected item
    // DEFAULT», «duplicate column name»), а не падение панели: без перевода он
    // видел только «Internal server error» и не понимал, что поправить.
    const r = await d.createTable(cc, decodeURIComponent(db), def).catch((e: unknown) => {
      throw userFacingDbError(e);
    });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.create', `${db}.${def.name}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db), sql: r.statement.slice(0, 4000), ok: true, execMs });
    return r;
  });

  // Изменить таблицу: колонки, индексы, внешние ключи, PK, переименование.
  app.patch('/api/connections/:id/:db/:table', async (req, reply) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'alter table');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { ops } = (req.body ?? {}) as { ops?: AlterOp[] };
    if (!Array.isArray(ops)) throw Object.assign(new Error('Need {ops[]}'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.alterTable) throw Object.assign(new Error(`Alter not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const dbName = decodeURIComponent(db);
    const tableName = decodeURIComponent(table);
    try {
      // Снапшот ДО применения: без него undo был бы фикцией. Схему и DDL читаем
      // до изменения, best-effort — если не получилось, alter всё равно идёт,
      // просто откат потом будет недоступен (undoAvailable: false).
      let snapLines: string[] | null = null;
      let snapDdl: string | null = null;
      try {
        snapLines = schemaLines(await drv.getSchema(cc, dbName, tableName));
        snapDdl = await renderTableDdl(drv, cc, dbName, tableName);
      } catch {
        snapLines = null;
      }
      if (snapLines) {
        saveDesignSnapshot(cfg.metaPath, {
          connId: id, dbName, tableName, ops, statements: [],
          linesBefore: snapLines, ddlBefore: snapDdl, actor: u?.username,
        });
      }
      // Данные теряет только удаление колонки: снимаем точку восстановления,
      // чтобы «откатить DDL» не оставил таблицу без данных. Остальные операции
      // (индексы, FK, переименование, alter типа) строки не трогают.
      const checkpointed = await autoCheckpointBeforeDataLoss(cfg, cc, id, dbName, tableName, ops, u?.username);
      const r = await drv.alterTable(cc, dbName, tableName, ops);
      const execMs = Date.now() - t0;
      audit(cfg.metaPath, id, 'design.alter', `${db}.${table}:${r.applied}/${ops.length}ops`, true, execMs, u?.username);
      if (u) {
        for (const sql of r.statements) {
          addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: dbName, sql, ok: true, execMs });
        }
      }
      return { ...r, undoAvailable: Boolean(snapLines), checkpointId: checkpointed };
    } catch (e: any) {
      const execMs = Date.now() - t0;
      // MySQL/MariaDB коммитят DDL неявно: пакет мог примениться частично.
      // Молчаливый 500 здесь выглядел бы как «ничего не произошло».
      const partial = e?.partial === true;
      audit(cfg.metaPath, id, 'design.alter', `${db}.${table}:failed`, false, execMs, u?.username);
      if (u) {
        addHistory(cfg.metaPath, {
          connId: id, userId: u.id, username: u.username, db: dbName,
          sql: `ALTER ${dbName}.${tableName} (${ops.length} ops): ${String(e?.message ?? e).slice(0, 200)}`,
          ok: false, execMs
        });
      }
      const statusCode = partial ? 409 : (e?.statusCode ?? 500);
      return reply.status(statusCode).send({
        error: partial
          ? `Applied partially (${e.applied} of ${ops.length} ops). MySQL/MariaDB commit DDL implicitly and cannot roll back: fix it manually or re-apply.`
          : String(e?.message ?? 'Alter failed'),
        partial,
        applied: e?.applied ?? 0,
        transactional: false,
        undoAvailable: partial
      });
    }
  });

  /**
   * Снапшот последнего DDL-пакета и откат. Автоматически восстанавливаются
   * индексы, внешние ключи и триггеры (создание снова не требует пересоздания
   * таблицы). Изменения колонок и переименование откатить нельзя: сервер не
   * помнит прежние данные, поэтому возвращаем 409 с DDL «до» для ручной
   * сверки, а не делаем вид, что откат состоялся.
   */
  app.post('/api/connections/:id/:db/:table/undo', async (req, reply) => {
    const u = me(req);
    // Именно 'ALTER TABLE', а не 'undo ddl': классификатор записи сверяется по
    // токенам, и неизвестная строка пропустила бы readonly к откату DDL.
    assertRoleWritable(u?.role, 'ALTER TABLE');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.alterTable || !drv.getSchema) throw Object.assign(new Error(`Undo is not supported for ${cc.kind}`), { statusCode: 400 });
    const dbName = decodeURIComponent(db);
    const tableName = decodeURIComponent(table);
    const snap = latestDesignSnapshot(cfg.metaPath, id, dbName, tableName);
    // Отказ откатывания — тоже пользовательский текст, а не падение сервера:
    // без кода интерфейс показал бы английскую фразу из тела ответа.
    if (!snap) throw withCode(Object.assign(new Error('No DDL snapshot to undo for this table'), { statusCode: 404 }), 'undo_nothing');
    let current: Awaited<ReturnType<typeof drv.getSchema>>;
    try {
      current = await drv.getSchema(cc, dbName, tableName);
    } catch (e: any) {
      throw withCode(Object.assign(new Error(`Table ${dbName}.${tableName} is gone: nothing to undo`), { statusCode: 404 }), 'undo_nothing');
    }
    const before = schemaLines(current);
    const beforeSet = new Set(before);
    const missing = (kind: string) => snap.linesBefore.filter((line) => line.startsWith(`${kind} `) && !beforeSet.has(line));
    const structural = snap.ops.filter((op: any) => ['addColumn', 'dropColumn', 'renameColumn', 'alterColumn', 'renameTable', 'setPrimaryKey', 'dropPrimaryKey'].includes(op?.op));
    if (structural.length) {
      return reply.status(409).send({
        error: 'The last package changed columns (or renamed something) and cannot be rolled back automatically: the server does not keep the previous data. The DDL before the change is in ddlBefore.',
        // Код обязателен: без него интерфейс не может перевести отказ и
        // показывал пользователю английский текст сервера.
        code: 'undo_structural',
        partial: true,
        structuralOps: structural,
        ddlBefore: snap.ddlBefore,
        statements: [],
      });
    }
    const ops: AlterOp[] = [];
    const skipped: string[] = [];
    for (const line of missing('index')) {
      const [, name, kindWord, cols] = line.split(' ');
      ops.push({ op: 'addIndex', index: { name, columns: cols.replace(/[()]/g, '').split(',').filter(Boolean), unique: kindWord === 'UNIQUE' } });
    }
    for (const line of missing('fk')) {
      // SQLite не умеет ALTER TABLE ADD CONSTRAINT — восстановить FK нельзя.
      if (cc.kind === 'sqlite') { skipped.push(`fk ${line.split(' ')[1]}: SQLite requires recreating the table`); continue; }
      const match = /^fk (\S+) \(([^)]*)\) -> (\S+)\(([^)]*)\)(.*)$/.exec(line);
      if (!match) continue;
      const rules = match[5].trim();
      // «NO ACTION» — два слова, поэтому действие вытаскиваем целиком, а не
      // по одному слову (иначе в откате получалось «ON DELETE NO»).
      const deleteRule = /\bON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)\b/i.exec(rules)?.[1];
      const updateRule = /\bON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)\b/i.exec(rules)?.[1];
      ops.push({
        op: 'addForeignKey',
        fk: {
          name: match[1],
          columns: match[2].split(',').filter(Boolean),
          refTable: match[3],
          refColumns: match[4].split(',').filter(Boolean),
          ...(deleteRule ? { onDelete: deleteRule.toUpperCase() } : {}),
          ...(updateRule ? { onUpdate: updateRule.toUpperCase() } : {}),
        },
      });
    }
    for (const line of missing('trigger')) {
      const match = /^trigger (\S+) (BEFORE|AFTER|INSTEAD OF) (INSERT|UPDATE|DELETE) :: ([\s\S]*)$/.exec(line);
      if (!match) { skipped.push(`trigger ${line.split(' ')[1]}: body not in snapshot`); continue; }
      if (!drv.createTrigger) { skipped.push(`trigger ${match[1]}: driver has no createTrigger`); continue; }
      await drv.createTrigger(cc, dbName, tableName, { name: match[1], timing: match[2], event: match[3], statement: match[4] });
    }
    if (!ops.length) {
      return reply.status(skipped.length ? 409 : 404).send({
        error: skipped.length
          ? `Nothing could be restored automatically. ${skipped.join('; ')}`
          : 'Nothing to restore: the current schema already contains all objects from the snapshot.',
        code: 'undo_nothing',
        partial: skipped.length > 0,
        skipped,
        ddlBefore: snap.ddlBefore,
        statements: [],
      });
    }
    const t0 = Date.now();
    const r = await drv.alterTable(cc, dbName, tableName, ops);
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.undo', `${dbName}.${tableName}:${r.applied}ops`, true, execMs, u?.username);
    return { ...r, restored: r.applied, skipped };
  });

  // Предпросмотр alter-пакета: те же стейтменты, что применит alterTable,
  // плюс diff «схема сейчас → схема после». Ничего не выполняется.
  app.post('/api/connections/:id/:db/:table/preview', async (req) => {
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { ops } = (req.body ?? {}) as { ops?: AlterOp[] };
    if (!Array.isArray(ops)) throw Object.assign(new Error('Need {ops[]}'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const drv = getDriver(cc.kind);
    if (!drv?.planAlter) throw Object.assign(new Error(`DDL preview is not supported for ${cc.kind}`), { statusCode: 400 });
    const dbName = decodeURIComponent(db);
    const tableName = decodeURIComponent(table);
    const plan = await drv.planAlter(cc, dbName, tableName, ops);
    const before = await drv.getSchema(cc, dbName, tableName).then(schemaLines).catch(() => [] as string[]);
    // Схема «после» без применения получить нельзя: диффаем по предпросмотру,
    // а фактическое состояние показываем отдельным вызовом после apply.
    return {
      ok: true,
      statements: plan.statements,
      transactional: plan.transactional,
      ops: ops.length,
      before,
      applyHint: plan.transactional
        ? 'Пакет выполняется в одной транзакции: при ошибке откатывается целиком.'
        : 'Внимание: DDL этой СУБД коммитится неявно и не откатывается. Проверьте скрипт перед применением.',
    };
  });

  // Удалить таблицу/коллекцию
  app.delete('/api/connections/:id/:db/:table', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'drop table');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.dropTable) throw Object.assign(new Error(`Drop not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const dbName = decodeURIComponent(db);
    const tableName = decodeURIComponent(table);
    // dryRun: показать, что произойдёт, ничего не удаляя. Полезно перед
    // разрушительным DDL — сколько данных исчезнет и какая операция выполнится.
    if (((req.query ?? {}) as { dryRun?: string }).dryRun === '1') {
      const existing = await drv.listTables(cc, dbName);
      if (!existing.includes(tableName)) {
        throw Object.assign(new Error(`Table ${tableName} not found in ${dbName}`), { statusCode: 404 });
      }
      let rowsApprox = 0;
      try {
        const page = await drv.getPage?.(cc, dbName, tableName, 1, 500);
        rowsApprox = page?.truncated ? 500 : page?.rows?.length ?? 0;
      } catch { /* счётчик строк не критичен для предпросмотра */ }
      audit(cfg.metaPath, id, 'design.drop.dryrun', `${dbName}.${tableName}:~${rowsApprox}r`, true, Date.now() - t0, u?.username);
      // Настоящий текст команды знает только драйвер (и он формируется в момент
      // выполнения), поэтому предпросмотр показывает операцию, а не выдуманный SQL.
      return {
        dryRun: true,
        exists: true,
        table: tableName,
        db: dbName,
        kind: cc.kind,
        operation: cc.kind === 'mongodb' ? 'drop collection' : 'drop table',
        rowsApprox,
        rowsApproxCapped: rowsApprox >= 500,
        requiresConfirm: true,
        note: 'При подтверждении сначала снимается точка восстановления, затем выполняется удаление'
      };
    }
    // DROP TABLE уничтожает данные таблицы: снимаем точку восстановления заранее,
    // иначе восстановить их уже нечем.
    let checkpointId: string | null = null;
    try {
      checkpointId = (await createCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, {
        connId: id, db: dbName, table: tableName, reason: 'before drop table', actor: u?.username,
      })).id;
    } catch (e) {
      audit(cfg.metaPath, id, 'checkpoint', `${dbName}.${tableName}:skipped (${String((e as Error).message).slice(0, 100)})`, false, 0, u?.username);
    }
    const r = await drv.dropTable(cc, dbName, tableName);
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.drop', `${db}.${table}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: dbName, sql: r.statement, ok: true, execMs });
    return { ...r, checkpointId };
  });

  // Создать представление (только SELECT; MongoDB/Redis → 400)
  app.post('/api/connections/:id/:db/views', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'create view');
    const { id, db } = req.params as { id: string; db: string };
    const def = (req.body ?? {}) as ViewDef;
    if (!def?.name || !def?.sql) throw Object.assign(new Error('Need {name, sql}'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.createView) throw Object.assign(new Error(`Views are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const dbName = decodeURIComponent(db);
    const r = await drv.createView(cc, dbName, def).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.view.create', `${dbName}.${def.name}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: dbName, sql: r.statement.slice(0, 4000), ok: true, execMs });
    return r;
  });

  // Удалить представление
  app.delete('/api/connections/:id/:db/views/:name', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'drop view');
    const { id, db, name } = req.params as { id: string; db: string; name: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.dropView) throw Object.assign(new Error(`Views are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await drv.dropView(cc, decodeURIComponent(db), decodeURIComponent(name)).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.view.drop', `${db}.${name}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db), sql: r.statement, ok: true, execMs });
    return r;
  });

  // Корзина Oracle: удалить все объекты из recycle bin разом.
  // Восстановить их после этого уже нельзя (в отличие от обычного DROP,
  // который в корзину и складывает), поэтому только через confirm в UI.
  app.post('/api/connections/:id/purge', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'purge recyclebin');
    const { id } = req.params as { id: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.purgeRecycleBin) throw Object.assign(new Error(`Recycle bin is not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await drv.purgeRecycleBin(cc);
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.purge', cc.kind, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: cc.database ?? null, sql: r.statement, ok: true, execMs });
    return r;
  });

  // Создать схему (только PostgreSQL; у остальных — 400)
  app.post('/api/connections/:id/:db/schemas', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'create schema');
    const { id, db } = req.params as { id: string; db: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || !String(name).trim()) throw Object.assign(new Error('Need {name}'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.createSchema) throw Object.assign(new Error(`Schemas are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await drv.createSchema(cc, decodeURIComponent(db), String(name).trim()).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.schema.create', `${db}.${name}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db), sql: r.statement.slice(0, 4000), ok: true, execMs });
    return r;
  });

  // Удалить схему. Непустая без cascade отвергается самим сервером (PG не даёт
  // уронить схему с объектами молча) — ошибка уходит через translateDriverError.
  app.delete('/api/connections/:id/:db/schemas/:name', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'drop schema');
    const { id, db, name } = req.params as { id: string; db: string; name: string };
    const cascade = ((req.query ?? {}) as { cascade?: string }).cascade === '1';
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.dropSchema) throw Object.assign(new Error(`Schemas are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await drv.dropSchema(cc, decodeURIComponent(db), decodeURIComponent(name), cascade).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.schema.drop', `${db}.${name}`, true, execMs, u?.username);
    if (u) addHistory(cfg.metaPath, { connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db), sql: r.statement, ok: true, execMs });
    return { ...r, cascade };
  });

  // Создать триггер
  app.post('/api/connections/:id/:db/:table/triggers', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'create trigger');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const def = (req.body ?? {}) as TriggerDef;
    if (!def?.name || !def.timing || !def.event || !def.statement) {
      throw Object.assign(new Error('Need {name, timing, event, statement}'), { statusCode: 400 });
    }
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.createTrigger) throw Object.assign(new Error(`Triggers are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await drv.createTrigger(cc, decodeURIComponent(db), decodeURIComponent(table), def).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.trigger.create', `${db}.${def.name}`, true, execMs, u?.username);
    if (u) {
      addHistory(cfg.metaPath, {
        connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db),
        sql: r.statement.slice(0, 4000), ok: true, execMs,
      });
    }
    return r;
  });

  // Удалить триггер
  app.delete('/api/connections/:id/:db/:table/triggers/:name', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'drop trigger');
    const { id, db, table, name } = req.params as { id: string; db: string; table: string; name: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const drv = getDriver(cc.kind);
    if (!drv?.dropTrigger) throw Object.assign(new Error(`Triggers are not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const triggerName = decodeURIComponent(name);
    const r = await drv.dropTrigger(cc, decodeURIComponent(db), decodeURIComponent(table), triggerName).catch((e: any) => { throw translateDriverError(e); });
    const execMs = Date.now() - t0;
    audit(cfg.metaPath, id, 'design.trigger.drop', `${db}.${triggerName}`, true, execMs, u?.username);
    if (u) {
      addHistory(cfg.metaPath, {
        connId: id, userId: u.id, username: u.username, db: decodeURIComponent(db),
        sql: r.statement, ok: true, execMs,
      });
    }
    return r;
  });
}
