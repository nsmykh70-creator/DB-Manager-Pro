import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { loadDecrypted, audit } from '../core/context.js';
import { assertRoleWritable, type PanelUser } from '../core/auth.js';
import { MAX_ROWS, assertUndoable, recordDataUndo, type DataUndoOp } from '../core/dataundo.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

interface Target {
  cc: NonNullable<ReturnType<typeof loadDecrypted>>;
  db: string;
  table: string;
  pk: { name: string; autoInc: boolean; identity: boolean }[];
}

async function target(cfg: AppConfig, id: string, rawDb: string, rawTable: string): Promise<Target> {
  const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
  assertNotReadOnly(cc);
  const d = getDriver(cc.kind);
  if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
  const db = decodeURIComponent(rawDb);
  const table = decodeURIComponent(rawTable);
  const schema = await d.getSchema(cc, db, table);
  const pk = schema.columns.filter((c) => c.primary).map((c) => ({
    name: c.name,
    autoInc: c.autoInc,
    // В PostgreSQL драйвер кладёт вид identity-колонки (ALWAYS/BY DEFAULT) в extra;
    // у serial колонки extra пуст, и явный ключ вставить можно.
    identity: cc.kind === 'postgres' && !!c.extra
  }));
  // У MongoDB в схеме коллекции нет PRIMARY KEY, но у каждого документа есть
  // неизменяемый _id — для отката он и есть ключ.
  if (!pk.length && cc.kind === 'mongodb') pk.push({ name: '_id', autoInc: true, identity: false });
  return { cc, db, table, pk };
}

/**
 * Читает строки, которые вот-таки будут изменены. Вызывается ДО правки —
 * после неё читать уже нечего, а образ до изменения и есть основа отката.
 * Ошибка не должна отменять правку: возвращаем пустой образ и помечаем запись
 * неоткатываемой.
 */
async function readBefore(t: Target, filter: Record<string, unknown> | null): Promise<{ rows: Record<string, unknown>[]; reason: string | undefined }> {
  try {
    const d = getDriver(t.cc.kind);
    if (!filter) return { rows: [], reason: undefined };
    // Драйвер без findRows (Redis) не умеет отдать образ «до». Раньше здесь
    // возвращались пустые строки без всякой пометки, и запись об откате
    // сохранялась как «ничего не изменилось»: откат молча ничего не делал.
    if (!d?.findRows) return { rows: [], reason: noImageReason(t.cc.kind) };
    const rows = await d.findRows(t.cc, t.db, t.table, filter, MAX_ROWS + 1);
    const truncated = rows.length > MAX_ROWS;
    return { rows: rows.slice(0, MAX_ROWS), reason: tooManyRows(truncated) };
  } catch {
    return { rows: [], reason: `не удалось прочитать образ до изменения — откат недоступен` };
  }
}

async function findOne(t: Target, filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const d = getDriver(t.cc.kind);
  if (!d?.findRows) return [];
  return (await d.findRows(t.cc, t.db, t.table, filter, 1)) ?? [];
}

/** Сохраняет образы для отката. Ошибки проглатываются: откат — дополнительная возможность. */
function record(
  cfg: AppConfig,
  t: Target,
  op: DataUndoOp,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  blockedReason: string | undefined,
  actor: string | undefined
): void {
  try {
    const reason = assertUndoable(t.cc.kind, op, t.pk) ?? blockedReason;
    recordDataUndo(cfg.metaPath, {
      connId: t.cc.id, db: t.db, table: t.table, op, before, after,
      pk: t.pk.map((c) => c.name), blockedReason: reason, actor
    });
  } catch {
    /* запись не удалась — основная операция уже выполнена, ронять её нельзя */
  }
}

const tooManyRows = (truncated: boolean): string | undefined =>
  truncated ? `затронуто больше ${MAX_ROWS} строк — используйте точку восстановления` : undefined;

/** Отдельное объяснение для движков, которые в принципе не умеют отдать образ. */
const noImageReason = (kind: string): string =>
  `${kind} не умеет читать образ строки до изменения — откат недоступен, используйте резервную копию`;

function applyPatch(rows: Record<string, unknown>[], patch: Record<string, unknown>): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const [k, v] of Object.entries(patch)) copy[k] = v;
    return copy;
  });
}

/**
 * Оптимистичная блокировка: клиент присылает `expected` — значения строки, на
 * основе которых он правил. Если их уже изменили, UPDATE/DELETE не найдёт строку,
 * и мы отвечаем 409 с актуальным состоянием, вместо того чтобы молча затереть
 * чужое изменение.
 *
 * NULL: в SQL `WHERE col = NULL` не находит строку никогда, поэтому там
 * null-значения в проверку не входят. В MongoDB `{col: null}` совпадает и с
 * отсутствующим полем, поэтому для него null проверять можно и нужно.
 */
function conflictFilter(
  filter: Record<string, unknown>,
  expected: Record<string, unknown> | undefined,
  allowNull: boolean
): { where: Record<string, unknown>; checked: string[] } {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return { where: filter, checked: [] };
  const where = { ...filter };
  const checked: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) continue;
    if (!allowNull && v === null) continue;
    if (k in where) continue; // первичный ключ уже в фильтре
    where[k] = v;
    checked.push(k);
  }
  return { where, checked };
}

async function currentRow(t: Target, filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const d = getDriver(t.cc.kind);
  if (!d?.findRows) return null;
  try {
    const rows = await d.findRows(t.cc, t.db, t.table, filter, 1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export function rowRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/:db/:table/rows', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'insert');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { row } = (req.body ?? {}) as { row?: Record<string, unknown> };
    if (!row) throw Object.assign(new Error('row required'), { statusCode: 400 });
    const t = await target(cfg, id, db, table);
    const d = getDriver(t.cc.kind);
    if (!d?.insertRow) throw Object.assign(new Error(`Insert not supported for ${t.cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.insertRow(t.cc, t.db, t.table, row);
    // Какая именно строка появилась: по сгенерированному ключу, иначе — по значениям.
    const pk = t.pk[0]?.name;
    const filter = pk && row[pk] == null && r.insertedId != null ? { [pk]: r.insertedId } : row;
    const after = await findOne(t, filter);
    record(cfg, t, 'insert', [], after, after.length ? undefined : 'не удалось определить созданную строку — откат вставки недоступен', u?.username);
    // В аудит кладём саму строку: без значений журнал отвечал бы только
    // «кто тронул таблицу», но не «что именно изменилось»
    audit(cfg.metaPath, id, 'row.insert', `${db}.${table}`, true, Date.now() - t0, u?.username,
      { after: after[0] ?? row });
    return r;
  });

  app.patch('/api/connections/:id/:db/:table/rows', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'update');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { filter, patch, expected } = (req.body ?? {}) as {
      filter?: Record<string, unknown>; patch?: Record<string, unknown>; expected?: Record<string, unknown>;
    };
    if (!filter || !patch) throw Object.assign(new Error('filter+patch required'), { statusCode: 400 });
    const t = await target(cfg, id, db, table);
    const d = getDriver(t.cc.kind);
    if (!d?.updateRow) throw Object.assign(new Error(`Update not supported for ${t.cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const before = await readBefore(t, filter);
    const { where, checked } = conflictFilter(filter, expected, t.cc.kind === 'mongodb');
    const r = await d.updateRow(t.cc, t.db, t.table, where, patch);
    if (checked.length && r.matched === 0) {
      // Строку изменили между чтением и правкой — не затираем чужое изменение
      throw Object.assign(
        new Error(`Row was changed by someone else (checked: ${checked.join(', ')}). Reload the row and try again`),
        { statusCode: 409, current: await currentRow(t, filter), checked }
      );
    }
    record(cfg, t, 'update', before.rows, applyPatch(before.rows, patch), before.reason, u?.username);
    audit(cfg.metaPath, id, 'row.update', `${db}.${table}`, true, Date.now() - t0, u?.username,
      { before: before.rows[0] ?? null, after: applyPatch(before.rows, patch)[0] ?? null, patch });
    return r;
  });

  app.delete('/api/connections/:id/:db/:table/rows', async (req) => {
    const u = me(req);
    assertRoleWritable(u?.role, 'delete');
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { filter, expected } = (req.body ?? {}) as {
      filter?: Record<string, unknown>; expected?: Record<string, unknown>;
    };
    // allow filter via query for simple deletes as well
    const qFilter = (req.query as Record<string, string> | undefined)?.filter;
    let f = filter;
    if (!f && qFilter) {
      try { f = JSON.parse(qFilter) as Record<string, unknown>; } catch { /* ignore */ }
    }
    if (!f) throw Object.assign(new Error('filter required'), { statusCode: 400 });
    const t = await target(cfg, id, db, table);
    const d = getDriver(t.cc.kind);
    if (!d?.deleteRow) throw Object.assign(new Error(`Delete not supported for ${t.cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const before = await readBefore(t, f);
    const { where, checked } = conflictFilter(f, expected, t.cc.kind === 'mongodb');
    const r = await d.deleteRow(t.cc, t.db, t.table, where);
    if (checked.length && r.deleted === 0) {
      throw Object.assign(
        new Error(`Row was changed by someone else (checked: ${checked.join(', ')}). Reload the row and try again`),
        { statusCode: 409, current: await currentRow(t, f), checked }
      );
    }
    record(cfg, t, 'delete', before.rows, [], before.reason, u?.username);
    audit(cfg.metaPath, id, 'row.delete', `${db}.${table}`, true, Date.now() - t0, u?.username,
      { before: before.rows[0] ?? null });
    return r;
  });
}
