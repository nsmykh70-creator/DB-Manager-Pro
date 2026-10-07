import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { audit, loadDecrypted } from '../core/context.js';
import { assertRoleWritable, type PanelUser } from '../core/auth.js';
import { parseCsv, translateTsSql } from '../drivers/helpers.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

export function importRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/import', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const u = me(req);
    const { id } = req.params as { id: string };
    const { format, db, table, data } = (req.body ?? {}) as { format?: string; db?: string; table?: string; data?: string };
    if (!data || data.length > 10_000_000) throw Object.assign(new Error('Bad data (10MB max)'), { statusCode: 413 });
    if (!['sql', 'csv', 'json'].includes(format ?? '')) throw Object.assign(new Error('format must be sql|csv|json'), { statusCode: 400 });

    // readonly-роль: импорт всегда пишущий
    assertRoleWritable(u?.role, 'insert import');

    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d) throw Object.assign(new Error(`No driver for ${cc.kind}`), { statusCode: 400 });
    const targetDb = db ?? cc.database ?? (cc.kind === 'sqlite' ? 'main' : '');
    const t0 = Date.now();

    try {
      if (format === 'sql') {
        if (!d.execScript) throw Object.assign(new Error(`Import SQL not supported for ${cc.kind}`), { statusCode: 400 });
        const r = await d.execScript(cc, decodeURIComponent(targetDb), translateTsSql(data, cc.kind));
        audit(cfg.metaPath, id, 'import', `sql:${r.statements}`, true, r.execMs, u?.username);
        return { ...r, format };
      }
      if (!table) throw Object.assign(new Error('table required for csv/json'), { statusCode: 400 });
      if (!d.importRows) throw Object.assign(new Error(`Import not supported for ${cc.kind}`), { statusCode: 400 });
      const rows = format === 'csv'
        ? parseCsv(data).rows
        : (() => {
            const j = JSON.parse(data) as unknown;
            if (!Array.isArray(j)) throw Object.assign(new Error('JSON import needs an array of objects'), { statusCode: 400 });
            return j as Record<string, unknown>[];
          })();
      const r = await d.importRows(cc, decodeURIComponent(targetDb), table, rows);
      audit(cfg.metaPath, id, 'import', `${format}:${table}:${r.inserted}`, true, r.execMs, u?.username);
      return { ...r, format };
    } catch (e) {
      audit(cfg.metaPath, id, 'import', `${format}:${table ?? ''}`, false, Date.now() - t0, u?.username);
      throw e;
    }
  });
}
