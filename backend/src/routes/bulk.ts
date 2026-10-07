import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import { assertRoleWritable } from '../core/auth.js';
import { getDriver } from '../plugins/registry.js';
import { loadDecrypted, audit } from '../core/context.js';
import { addHistory } from '../core/history.js';
import { createCheckpoint } from '../core/checkpoints.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function bad(message: string, code = 400): never {
  throw Object.assign(new Error(message), { statusCode: code });
}

/** Больше этой выборки массовая операция не выполняется: точка восстановления
 *  хранит дамп, а лишние строки лучше трогать по частям. */
export const BULK_CAP = 1000;

interface Target {
  cc: NonNullable<ReturnType<typeof loadDecrypted>>;
  db: string;
  table: string;
  pk: string[];
}

/**
 * Массовые операции над строками по фильтру из строки фильтра панели
 * (`col=value AND col2~'text'`). Устроено так: сначала выборка строк по
 * фильтру (как при чтении), затем операция по первичному ключу каждой строки
 * через обычные insert/update/delete драйвера. Это медленнее, чем один
 * UPDATE, зато даёт образы «до» для отката и работает одинаково на всех СУБД.
 *
 * Безопасность:
 *  - по умолчанию только предпросмотр (`dryRun: true` в UI всегда первый шаг);
 *  - без `confirm: true` ничего не применяется;
 *  - пустой фильтр запрещён, иначе операция ударила бы по всей таблице;
 *  - перед применением снимается точка восстановления таблицы, и если это не
 *    удалось — операция отклоняется (выход только через allowWithoutCheckpoint);
 *  - больше BULK_CAP строк — отказ с указанием количества.
 */
export function bulkRowsRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/:db/:table/rows/bulk', async (req) => {
    const u = me(req);
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const body = (req.body ?? {}) as {
      where?: string; patch?: Record<string, unknown>; delete?: boolean;
      dryRun?: boolean; confirm?: boolean; allowAll?: boolean; allowWithoutCheckpoint?: boolean;
    };
    if (!u) bad('Unauthorized', 401);
    const where = String(body.where ?? '').trim();
    if (!where && body.allowAll !== true) bad('Empty filter is not allowed: pass allowAll=true to change every row');
    const wantsDelete = body.delete === true;
    if (!wantsDelete && (!body.patch || !Object.keys(body.patch).length)) {
      bad('Nothing to do: pass patch (bulk update) or delete=true (bulk delete)');
    }
    if (wantsDelete) assertRoleWritable(u.role, 'delete');
    else assertRoleWritable(u.role, 'update');

    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d) bad(`No driver for ${cc.kind}`);
    const dbName = decodeURIComponent(db);
    const tableName = decodeURIComponent(table);
    const schema = await d.getSchema(cc, dbName, tableName);
    const pk = schema.columns.filter((c) => c.primary).map((c) => c.name);
    // У коллекций MongoDB нет PRIMARY KEY, но есть неизменяемый _id — он и есть ключ
    if (!pk.length && cc.kind === 'mongodb') pk.push('_id');
    const t: Target = { cc, db: dbName, table: tableName, pk };
    if (!pk.length) bad('Bulk operations need a primary key (MongoDB: _id)');
    if (wantsDelete && !d.deleteRow) bad(`Bulk delete is not supported for ${cc.kind}`);
    if (!wantsDelete && !d.updateRow) bad(`Bulk update is not supported for ${cc.kind}`);

    // 1) выборка строк по фильтру (как при чтении, но с запасом на проверку лимита).
    // Страница запрашивается по частям НЕ потому, что так красивее, а потому что
    // драйверы клампают pageSize до 500 (mysql.ts/ps = Math.min(500, …)): один
    // запрос на BULK_CAP+1 строк вернул бы 500, и проверка «больше лимита» никогда
    // не сработала бы — фильтр на 5000 строк молча правил бы первые 500. Обходим
    // страницы, пока не наберём лимит или страницы не кончатся (truncated).
    if (!d.getPage) bad('Bulk operations are not supported for this database');
    const PAGE_SIZE = 500;
    const matched: Record<string, unknown>[] = [];
    let pageNo = 1;
    let overflow = false;
    for (;;) {
      const page = await d.getPage(cc, dbName, tableName, pageNo, PAGE_SIZE, undefined, where || undefined);
      const rows = page.rows ?? [];
      matched.push(...rows);
      if (matched.length > BULK_CAP) { overflow = true; break; }
      if (!page.truncated || rows.length === 0) break;
      pageNo++;
    }
    if (overflow) {
      bad(`Filter matches more than ${BULK_CAP} rows (found at least ${matched.length}). Narrow the filter or work in parts`);
    }

    // Намерение должно быть явным: применяем только при dryRun:false И confirm:true.
    // Одного флага недостаточно — это защита от «случайно сняли предпросмотр».
    if (body.confirm === true && body.dryRun !== false) {
      bad('To apply a bulk change pass dryRun:false together with confirm:true (dryRun:false alone does nothing)');
    }
    // 2) предпросмотр: сколько строк затронуто и что именно изменится
    const sample = matched.slice(0, 5);
    if (body.dryRun !== false || body.confirm !== true) {
      return {
        dryRun: true,
        matched: matched.length,
        sample,
        preview: wantsDelete
          ? `DELETE FROM ${tableName} WHERE ${where || '(все строки)'} — затронуто строк: ${matched.length}`
          // Значения обязаны быть видны: подтверждать правку, которой не видно,
          // нельзя. JSON.stringify даёт кавычки и экранирование — такой preview
          // можно копировать обратно в SQL.
          : `UPDATE ${tableName} SET ${Object.entries(body.patch ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v) ?? 'NULL'}`).join(', ')} WHERE ${where || '(все строки)'} — затронуто строк: ${matched.length}`,
        requiresConfirm: true
      };
    }

    // 3) применение: сначала точка восстановления.
    // В отличие от ALTER TABLE (design.ts), здесь снимок — условие операции: за один
    // вызов меняются сотни строк, и «точка не создалась, но мы всё равно правим»
    // означало бы необратимую потерю данных. Поэтому по умолчанию отказ, а
    // allowWithoutCheckpoint — осознанный выход, который должен подтвердить клиент.
    const t0 = Date.now();
    let checkpointId: string | null = null;
    let checkpointError: string | null = null;
    try {
      checkpointId = (await createCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, {
        connId: id, db: dbName, table: tableName,
        reason: wantsDelete ? 'before bulk delete' : 'before bulk update',
        actor: u.username
      })).id;
    } catch (e) {
      checkpointError = String((e as Error).message).slice(0, 150);
      audit(cfg.metaPath, id, 'checkpoint', `${dbName}.${tableName}:skipped (${checkpointError})`, false, 0, u.username);
      if (body.allowWithoutCheckpoint !== true) {
        bad(`Cannot create a restore point before a bulk change, so nothing was changed: ${checkpointError}. `
          + 'Fix the cause (dump size limit, permissions) or repeat the request with allowWithoutCheckpoint:true', 409);
      }
    }

    let affected = 0;
    const failed: { key: Record<string, unknown>; error: string }[] = [];
    // Основной путь — одно выражение на всё множество строк (UPDATE/DELETE ... WHERE
    // или updateMany/deleteMany): один поход в СУБД вместо тысячи. Он же запирает
    // предпросмотр и применение на одном условии, потому что и то и другое собирает
    // его через buildWhere() внутри драйвера.
    const setBased = wantsDelete ? d.deleteRowsBulk : d.updateRowsBulk;
    // PANEL_BULK_MODE=rows принудительно выбирает построчный путь. Нужен для
    // диагностики, когда set-based-операция на конкретной СУБД ведёт себя иначе,
    // и для проверки, что запасной путь по-прежнему даёт тот же результат.
    const forceRowMode = process.env.PANEL_BULK_MODE === 'rows';
    let mode: 'set' | 'rows' = 'rows';
    if (setBased && !forceRowMode) {
      try {
        affected = wantsDelete
          ? (await d.deleteRowsBulk!(cc, dbName, tableName, where || undefined)).affected
          : (await d.updateRowsBulk!(cc, dbName, tableName, where || undefined, body.patch!)).affected;
        mode = 'set';
      } catch (e) {
        // Сет-операция не прошла (неизвестный фильтр, диалектная особенность) —
        // откатываемся на построчный путь, он работает везде
        const reason = String((e as Error).message).slice(0, 120);
        if (process.env.PANEL_BULK_DEBUG) console.warn('bulk set-based failed, falling back to row loop:', reason);
      }
    }
    if (mode === 'rows') {
      for (const row of matched) {
        const f = Object.fromEntries(pk.map((c) => [c, row[c]]));
        // Если ключ не попал в выборку, фильтр был бы {id: undefined} — такой ушёл бы
        // в СУБД и мог затронуть не те строки. Лучше пропустить и сказать об этом.
        if (pk.some((c) => f[c] === undefined)) {
          failed.push({ key: f, error: `row has no ${pk.join('/')} value, skipped` });
          continue;
        }
        try {
          if (wantsDelete) affected += (await d.deleteRow!(cc, dbName, tableName, f)).deleted;
          else affected += (await d.updateRow!(cc, dbName, tableName, f, body.patch!)).matched;
        } catch (e) {
          failed.push({ key: f, error: String((e as Error).message).slice(0, 120) });
        }
      }
    }
    const ms = Date.now() - t0;
    const action = wantsDelete ? 'row.bulk_delete' : 'row.bulk_update';
    const summary = `${dbName}.${tableName}:${affected}/${matched.length}${where ? ` [${where.slice(0, 120)}]` : ''}`;
    audit(cfg.metaPath, id, action, summary, failed.length === 0, ms, u.username);
    {
      addHistory(cfg.metaPath, {
        connId: id, userId: u.id, username: u.username, db: dbName,
        sql: wantsDelete
          ? `DELETE FROM ${tableName} WHERE ${where || 'TRUE'} -- bulk, ${affected} rows`
          : `UPDATE ${tableName} SET ${Object.entries(body.patch ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')} WHERE ${where || 'TRUE'} -- bulk, ${affected} rows`,
        ok: failed.length === 0, execMs: ms, name: 'bulk', saved: false
      });
    }
    return { ok: failed.length === 0, dryRun: false, matched: matched.length, affected, failed, mode, checkpointId, checkpointError, execMs: ms, where: where || null };
  });
}
