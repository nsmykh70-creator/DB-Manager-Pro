import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import { hashPass, signToken, verifyPass, type PanelUser, type Role } from '../core/auth.js';
import { openMeta } from '../core/store.js';

function actor(req: unknown): string | null {
  return ((req as { user?: PanelUser }).user?.username) ?? null;
}

function needAdmin(req: unknown): PanelUser {
  const u = (req as { user?: PanelUser }).user;
  if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  if (u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
  return u;
}

export function authRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.post('/api/auth/login', async (req) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) throw Object.assign(new Error('username+password required'), { statusCode: 400 });
    const db = openMeta(cfg.metaPath);
    const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as { id: string; username: string; passHash: string; role: Role } | undefined;
    if (!r || !(await verifyPass(password, r.passHash))) {
      await new Promise((res) => setTimeout(res, 300)); // anti-bruteforce задержка
      throw Object.assign(new Error('Bad credentials'), { statusCode: 401 });
    }
    const user: PanelUser = { id: r.id, username: r.username, role: r.role };
    return { token: signToken(user, cfg.jwtSecret), user };
  });

  app.get('/api/auth/me', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    return { user: u };
  });

  app.get('/api/auth/users', async (req) => {
    needAdmin(req);
    const rows = openMeta(cfg.metaPath).prepare(`SELECT id,username,role,createdAt FROM users ORDER BY createdAt`).all();
    return rows;
  });

  app.post('/api/auth/users', async (req) => {
    needAdmin(req);
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: Role };
    if (!username || !password) throw Object.assign(new Error('username+password required'), { statusCode: 400 });
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw Object.assign(new Error('Bad username'), { statusCode: 400 });
    if (password.length < 8) throw Object.assign(new Error('Password min 8 chars'), { statusCode: 400 });
    const rl: Role = role === 'admin' || role === 'readonly' ? role : 'editor';
    const h = await hashPass(password);
    try {
      openMeta(cfg.metaPath).prepare(`INSERT INTO users (id,username,passHash,role,createdAt) VALUES (?,?,?,?,?)`).run(randomUUID(), username, h, rl, Date.now());
    } catch {
      throw Object.assign(new Error('Username exists'), { statusCode: 409 });
    }
    return { ok: true };
  });

  app.patch('/api/auth/users/:id', async (req) => {
    needAdmin(req);
    const { id } = req.params as { id: string };
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: Role };
    if (username !== undefined && !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw Object.assign(new Error('Bad username'), { statusCode: 400 });
    if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 128)) throw Object.assign(new Error('Password must be 8-128 chars'), { statusCode: 400 });
    if (role !== undefined && !['admin', 'editor', 'readonly'].includes(role)) throw Object.assign(new Error('Bad role'), { statusCode: 400 });
    const db = openMeta(cfg.metaPath);
    const current = db.prepare(`SELECT id FROM users WHERE id=?`).get(id) as { id: string } | undefined;
    if (!current) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    const fields: string[] = [];
    const values: unknown[] = [];
    if (username !== undefined) { fields.push('username=?'); values.push(username); }
    if (role !== undefined) { fields.push('role=?'); values.push(role); }
    if (password !== undefined) { fields.push('passHash=?'); values.push(await hashPass(password)); }
    if (!fields.length) return { ok: true };
    values.push(id);
    try {
      db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id=?`).run(...values);
    } catch {
      throw Object.assign(new Error('Username exists'), { statusCode: 409 });
    }
    return { ok: true };
  });

  app.delete('/api/auth/users/:id', async (req) => {
    const me = needAdmin(req);
    const { id } = req.params as { id: string };
    if (id === me.id) throw Object.assign(new Error('Cannot delete self'), { statusCode: 400 });
    openMeta(cfg.metaPath).prepare(`DELETE FROM users WHERE id=?`).run(id);
    return { ok: true, actor: actor(req) };
  });
}
