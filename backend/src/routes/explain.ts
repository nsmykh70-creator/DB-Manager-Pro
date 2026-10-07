import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import { getDriver } from '../plugins/registry.js';
import { loadDecrypted, audit } from '../core/context.js';
import { codeForDriverError, withCode } from '../core/errcodes.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function bad(message: string, code = 400): never {
  throw Object.assign(new Error(message), { statusCode: code });
}

/**
 * EXPLAIN безопасен для чтения, но `ANALYZE` в PostgreSQL ВЫПОЛНЯЕТ запрос.
 * Поэтому пропускаем только операции чтения, а для остальных отвечаем 400:
 * «объяснить можно только чтение» — так панель не станет источником
 * неожиданных записей при нажатии «объяснить».
 */
const READ_ONLY_STARTS = /^(select|with|values|table|show|explain|pragma|describe|desc|explain\s)/i;
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|create|alter|rename|grant|revoke|replace|call|do|copy|vacuum|analyze|reindex|cluster|lock|commit|rollback|set|use|attach|detach)\b/i;

function assertExplainable(sql: string): void {
  const statements = sql.replace(/--[^\n]*\n/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!statements) bad('Empty query');
  if (!READ_ONLY_STARTS.test(statements)) {
    // Код нужен интерфейсу: по-английски это звучало бы в русском окне,
    // и пользователь не понимал, что кнопка просто не для его запроса.
    throw withCode(Object.assign(new Error('Explain works for read-only queries only (SELECT / WITH / SHOW / PRAGMA)'), { statusCode: 400 }), 'explain_readonly');
  }
  if (FORBIDDEN.test(statements)) {
    throw withCode(Object.assign(new Error('Explain works for read-only queries only: the statement changes data'), { statusCode: 400 }), 'explain_readonly');
  }
}

export function explainRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/explain', async (req) => {
    const u = me(req);
    const { id } = req.params as { id: string };
    const { sql, db, analyze } = (req.body ?? {}) as { sql?: string; db?: string; analyze?: boolean };
    if (!sql || !String(sql).trim()) bad('sql required');
    if (String(sql).length > 100_000) bad('sql too long (100 KB)');
    assertExplainable(String(sql));
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    if (cc.readOnly === undefined) bad('Connection not found', 404);
    const d = getDriver(cc.kind);
    if (!d) bad(`No driver for ${cc.kind}`);
    if (!d.explain) {
      throw withCode(Object.assign(new Error(cc.kind === 'mongodb'
        ? 'Explain is not available for MongoDB in the panel'
        : cc.kind === 'redis'
          ? 'Redis has no query planner'
          : `Explain is not supported for ${cc.kind}`), { statusCode: 400 }), 'unsupported_operation');
    }
    const t0 = Date.now();
    try {
      const plan = await d.explain(cc, db ?? '', String(sql).trim(), { analyze: analyze === true });
      audit(cfg.metaPath, id, 'query.explain', `${db ?? ''}:${plan.rowCount} steps`, true, Date.now() - t0, u?.username);
      return { kind: cc.kind, analyze: analyze === true, plan };
    } catch (e: any) {
      audit(cfg.metaPath, id, 'query.explain', String((e as Error).message).slice(0, 150), false, Date.now() - t0, u?.username);
      const panelCode = codeForDriverError(e);
      const out = Object.assign(e, { statusCode: e?.statusCode ?? 400 });
      return panelCode ? withCode(out, panelCode) : out;
    }
  });
}
