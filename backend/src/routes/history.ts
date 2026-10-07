import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import { addHistory, clearHistory, deleteHistory, listHistory, patchHistory } from '../core/history.js';
import { audit } from '../core/context.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function requireUser(req: unknown): PanelUser {
  const u = me(req);
  if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  return u;
}

export function historyRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/history', async (req) => {
    const u = requireUser(req);
    const { connId, savedOnly, limit, q } = (req.query ?? {}) as { connId?: string; savedOnly?: string; limit?: string; q?: string };
    return listHistory(cfg.metaPath, { connId, userId: u.id, savedOnly: savedOnly === '1' || savedOnly === 'true', limit: limit ? Number(limit) : 50, q });
  });

  app.post('/api/history', async (req) => {
    const u = requireUser(req);
    const { connId, db, sql, name } = (req.body ?? {}) as { connId?: string; db?: string; sql?: string; name?: string };
    if (!sql || !String(sql).trim()) throw Object.assign(new Error('sql required'), { statusCode: 400 });
    if (String(sql).length > 10000) throw Object.assign(new Error('sql too long'), { statusCode: 400 });
    const entry = addHistory(cfg.metaPath, {
      connId: connId ?? null,
      userId: u.id,
      username: u.username,
      db: db ?? null,
      sql: String(sql),
      name: name ?? null,
      saved: true,
      ok: true,
      execMs: 0
    });
    return entry;
  });

  app.patch('/api/history/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const { saved, name } = (req.body ?? {}) as { saved?: boolean; name?: string | null };
    return patchHistory(cfg.metaPath, id, u.id, { saved, name });
  });

  app.delete('/api/history/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    deleteHistory(cfg.metaPath, id, u.id);
    return { ok: true };
  });

  // Очистка журнала запросов: scope=mine (свои) | saved (сохранённые) | all (все, admin)
  app.delete('/api/history', async (req) => {
    const u = requireUser(req);
    const { scope, connId } = (req.query ?? {}) as { scope?: string; connId?: string };
    const kind = scope === 'all' || scope === 'saved' ? scope : 'mine';
    if (kind !== 'mine' && u.role !== 'admin') {
      throw Object.assign(new Error('Only admin can clear all or saved queries'), { statusCode: 403 });
    }
    const deleted = clearHistory(cfg.metaPath, { scope: kind, userId: u.id, connId });
    audit(cfg.metaPath, connId ?? null, 'history.clear', `${kind}:${deleted}`, true, 0, u.username);
    return { ok: true, scope: kind, deleted };
  });
}
