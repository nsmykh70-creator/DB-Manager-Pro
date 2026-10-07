import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import { loadDecrypted } from '../core/context.js';
import { applyDataUndo, deleteDataUndo, listDataUndo } from '../core/dataundo.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

/** Как и у бэкапов: роль readonly не управляет точками отката. */
function guard(req: unknown): PanelUser | undefined {
  const u = me(req);
  if (u?.role === 'readonly') throw Object.assign(new Error('Readonly cannot use data undo'), { statusCode: 403 });
  return u;
}

/**
 * Откат изменений данных: список последних операций над строками и обратное
 * применение. Отличается от «Откатить DDL» (структура) и от точки восстановления
 * (дамп всей таблицы) — здесь откатывается конкретная правка конкретных строк.
 */
export function dataUndoRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/data-undo', async (req) => {
    guard(req);
    const { connId, db, table, limit } = (req.query ?? {}) as Record<string, string>;
    if (!connId) throw Object.assign(new Error('connId required'), { statusCode: 400 });
    return listDataUndo(cfg.metaPath, { connId, db, table, limit: limit ? Number(limit) : 20 });
  });

  app.post('/api/data-undo/:id/undo', async (req) => {
    const u = guard(req);
    const { id } = req.params as { id: string };
    return applyDataUndo(cfg.metaPath, cfg.encryptionKeyHex, id, 'undo',
      (connId) => loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connId), u?.username);
  });

  app.post('/api/data-undo/:id/redo', async (req) => {
    const u = guard(req);
    const { id } = req.params as { id: string };
    return applyDataUndo(cfg.metaPath, cfg.encryptionKeyHex, id, 'redo',
      (connId) => loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, connId), u?.username);
  });

  app.delete('/api/data-undo/:id', async (req) => {
    const u = guard(req);
    if (u?.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    deleteDataUndo(cfg.metaPath, id);
    return { ok: true };
  });
}
