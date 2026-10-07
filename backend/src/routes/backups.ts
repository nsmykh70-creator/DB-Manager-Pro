import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';
import {
  listSchedules, createSchedule, patchSchedule, deleteSchedule,
  listRuns, runBackup, runFile, restoreRun
} from '../core/backups.js';
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from '../core/checkpoints.js';

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function guard(req: unknown): PanelUser | undefined {
  const u = me(req);
  if (u?.role === 'readonly') throw Object.assign(new Error('Readonly cannot manage backups'), { statusCode: 403 });
  return u;
}

export function backupRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/backups/schedules', async (req) => {
    guard(req);
    const { connId } = (req.query ?? {}) as { connId?: string };
    return listSchedules(cfg.metaPath, connId);
  });

  app.post('/api/backups/schedules', async (req) => {
    const u = guard(req);
    const { connId, db, format, intervalMin, keepLast } = (req.body ?? {}) as {
      connId?: string; db?: string; format?: string; intervalMin?: number; keepLast?: number;
    };
    if (!connId) throw Object.assign(new Error('connId required'), { statusCode: 400 });
    const s = createSchedule(cfg.metaPath, connId, cfg.encryptionKeyHex, { db: db ?? '', format: format ?? 'sql', intervalMin: intervalMin ?? 1440, keepLast: keepLast ?? 7 });
    return { ...s, actor: u?.username };
  });

  app.patch('/api/backups/schedules/:id', async (req) => {
    guard(req);
    const { id } = req.params as { id: string };
    const { enabled, intervalMin, keepLast } = (req.body ?? {}) as { enabled?: boolean; intervalMin?: number; keepLast?: number };
    return patchSchedule(cfg.metaPath, id, { enabled, intervalMin, keepLast });
  });

  app.delete('/api/backups/schedules/:id', async (req) => {
    const u = guard(req);
    if (u && u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    deleteSchedule(cfg.metaPath, id);
    return { ok: true };
  });

  app.post('/api/backups/schedules/:id/run', async (req) => {
    const u = guard(req);
    const { id } = req.params as { id: string };
    return runBackup(cfg.metaPath, cfg.encryptionKeyHex, id, u?.username);
  });

  app.get('/api/backups/runs', async (req) => {
    guard(req);
    const { scheduleId, limit } = (req.query ?? {}) as { scheduleId?: string; limit?: string };
    return listRuns(cfg.metaPath, scheduleId, limit ? Number(limit) : 50);
  });

  app.get('/api/backups/runs/:id/download', async (req, reply) => {
    guard(req);
    const { id } = req.params as { id: string };
    const { full, run } = runFile(cfg.metaPath, id);
    reply.header('content-type', run.file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/sql; charset=utf-8')
      .header('content-disposition', `attachment; filename="${run.file}"`);
    return reply.send(createReadStream(full));
  });

  app.post('/api/backups/runs/:id/restore', async (req) => {
    const u = guard(req);
    const { id } = req.params as { id: string };
    return restoreRun(cfg.metaPath, cfg.encryptionKeyHex, id, u?.username);
  });

  // --- Точки восстановления отдельной таблицы (checkpoint) ---
  // Отличие от бэкапа по расписанию: снимается по требованию и автоматически
  // перед разрушительным DDL, поэтому не зависит от таймера.

  app.get('/api/checkpoints', async (req) => {
    guard(req);
    const { connId, db, table, limit } = (req.query ?? {}) as { connId?: string; db?: string; table?: string; limit?: string };
    if (!connId) throw Object.assign(new Error('connId required'), { statusCode: 400 });
    return listCheckpoints(cfg.metaPath, connId, db, table, limit ? Number(limit) : 50);
  });

  app.post('/api/checkpoints', async (req) => {
    const u = guard(req);
    const { connId, db, table, reason } = (req.body ?? {}) as { connId?: string; db?: string; table?: string; reason?: string };
    if (!connId || !db || !table) throw Object.assign(new Error('connId, db and table required'), { statusCode: 400 });
    return createCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, {
      connId, db, table, reason: reason || 'manual', actor: u?.username,
    });
  });

  app.delete('/api/checkpoints/:id', async (req) => {
    const u = guard(req);
    if (u && u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { id } = req.params as { id: string };
    deleteCheckpoint(cfg.metaPath, id);
    return { ok: true };
  });

  app.post('/api/checkpoints/:id/restore', async (req) => {
    const u = guard(req);
    const { id } = req.params as { id: string };
    const { dropExisting } = (req.body ?? {}) as { dropExisting?: boolean };
    return restoreCheckpoint(cfg.metaPath, cfg.encryptionKeyHex, id, { dropExisting: dropExisting === true, actor: u?.username });
  });
}
