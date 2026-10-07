import type { FastifyInstance } from 'fastify';
import { assertNotReadOnly } from '../core/types.js';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { loadDecrypted, audit } from '../core/context.js';
import type { PanelUser } from '../core/auth.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

export function dbUserRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/connections/:id/dbusers', async (req) => {
    const { id } = req.params as { id: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = getDriver(cc.kind);
    if (!d?.listDbUsers) throw Object.assign(new Error(`DB users not supported for ${cc.kind}`), { statusCode: 400 });
    // Недостижимый сервер — это не дефект панели: сообщаем 502, как /status,
    // иначе в консоли браузера и в логах выглядит как внутренняя ошибка 500.
    try {
      return await d.listDbUsers(cc);
    } catch (e: any) {
      throw Object.assign(e, { statusCode: e?.statusCode ?? 502 });
    }
  });

  app.post('/api/connections/:id/dbusers', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    const { username, password, db, host } = (req.body ?? {}) as { username?: string; password?: string; db?: string; host?: string };
    if (!username || !password) throw Object.assign(new Error('username+password required'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d?.createDbUser) throw Object.assign(new Error(`Create DB user not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.createDbUser(cc, username, password, db, host);
    audit(cfg.metaPath, id, 'dbuser.create', `${username}@${host ?? cc.kind}`, true, Date.now() - t0, u.username);
    return r;
  });

  app.delete('/api/connections/:id/dbusers/:username', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id, username } = req.params as { id: string; username: string };
    const { db, host } = (req.query ?? {}) as { db?: string; host?: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d?.dropDbUser) throw Object.assign(new Error(`Drop DB user not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.dropDbUser(cc, decodeURIComponent(username), db, host);
    audit(cfg.metaPath, id, 'dbuser.drop', `${username}@${cc.kind}`, true, Date.now() - t0, u.username);
    return r;
  });

  app.get('/api/connections/:id/dbusers/:username/grants', async (req) => {
    const { id, username } = req.params as { id: string; username: string };
    const { db, host } = (req.query ?? {}) as { db?: string; host?: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = getDriver(cc.kind);
    if (!d?.listGrants) throw Object.assign(new Error(`Grants not supported for ${cc.kind}`), { statusCode: 400 });
    return d.listGrants(cc, decodeURIComponent(username), db, host);
  });

  app.post('/api/connections/:id/dbusers/:username/grant', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id, username } = req.params as { id: string; username: string };
    const { privilege, db, table, host } = (req.body ?? {}) as { privilege?: string; db?: string; table?: string; host?: string };
    if (!privilege) throw Object.assign(new Error('privilege required'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d?.grant) throw Object.assign(new Error(`Grant not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.grant(cc, decodeURIComponent(username), privilege, db, table, host);
    audit(cfg.metaPath, id, 'dbuser.grant', `${username}:${privilege}`, true, Date.now() - t0, u.username);
    return r;
  });

  app.post('/api/connections/:id/dbusers/:username/revoke', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id, username } = req.params as { id: string; username: string };
    const { privilege, db, table, host } = (req.body ?? {}) as { privilege?: string; db?: string; table?: string; host?: string };
    if (!privilege) throw Object.assign(new Error('privilege required'), { statusCode: 400 });
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    assertNotReadOnly(cc);
    const d = getDriver(cc.kind);
    if (!d?.revoke) throw Object.assign(new Error(`Revoke not supported for ${cc.kind}`), { statusCode: 400 });
    const t0 = Date.now();
    const r = await d.revoke(cc, decodeURIComponent(username), privilege, db, table, host);
    audit(cfg.metaPath, id, 'dbuser.revoke', `${username}:${privilege}`, true, Date.now() - t0, u.username);
    return r;
  });
}
