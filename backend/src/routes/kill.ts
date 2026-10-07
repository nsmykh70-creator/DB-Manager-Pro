import type { FastifyInstance } from 'fastify';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { loadDecrypted, audit } from '../core/context.js';
import type { PanelUser } from '../core/auth.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

export function killRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/connections/:id/kill', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    const { pid } = (req.body ?? {}) as { pid?: string };
    if (!pid) throw Object.assign(new Error('pid required'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = getDriver(cc.kind);
    if (!d?.killQuery) throw Object.assign(new Error(`Kill not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.killQuery(cc, String(pid));
    audit(cfg.metaPath, id, 'kill', String(pid), true, Date.now() - t0, u.username);
    return r;
  });
}
