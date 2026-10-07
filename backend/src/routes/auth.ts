import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import { hashPass, signToken, signTempToken, verifyPass, verifyTokenPayload, authBlocked, authFailed, authOk, type PanelUser, type Role } from '../core/auth.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../core/totp.js';
import { readSessionTtlMin } from './settings.js';
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
  // Публичный флаг первоначальной настройки: true, пока хоть один пользователь
  // сидит на дефолтном пароле. Экран входа по нему показывает подсказку
  // «admin / admin»; после смены пароля подсказка исчезает сама.
  app.get('/api/auth/setup', async () => {
    const row = openMeta(cfg.metaPath).prepare(`SELECT COUNT(*) AS c FROM users WHERE mustChange=1`).get() as { c: number };
    return { defaultCredentials: row.c > 0 };
  });
  app.post('/api/auth/login', async (req) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) throw Object.assign(new Error('username+password required'), { statusCode: 400 });
    const throttleKey = `login:${req.ip}:${username}`;
    if (authBlocked(throttleKey)) throw Object.assign(new Error('Too many failed attempts, try later'), { statusCode: 429 });
    const db = openMeta(cfg.metaPath);
    const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as { id: string; username: string; passHash: string; role: Role; mustChange?: number; totpEnabled?: number } | undefined;
    if (!r || !(await verifyPass(password, r.passHash))) {
      authFailed(throttleKey);
      await new Promise((res) => setTimeout(res, 300)); // anti-bruteforce задержка
      throw Object.assign(new Error('Bad credentials'), { statusCode: 401 });
    }
    authOk(throttleKey);
    const user: PanelUser = { id: r.id, username: r.username, role: r.role };
    const mustChangePassword = Number(r.mustChange ?? 0) === 1;
    // Обязательная смена пароля — раньше второго фактора: сначала новые
    // учётные данные, потом уже код из приложения.
    if (mustChangePassword) {
      return { token: signToken(user, cfg.jwtSecret, readSessionTtlMin(cfg)), user, mustChangePassword: true };
    }
    if (Number(r.totpEnabled ?? 0) === 1) {
      return { need2fa: true as const, tempToken: signTempToken(user, cfg.jwtSecret), user };
    }
    return { token: signToken(user, cfg.jwtSecret, readSessionTtlMin(cfg)), user, mustChangePassword: false };
  });

  app.get('/api/auth/me', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    return { user: u };
  });

  /**
   * Двухфакторка (TOTP, RFC 6238). Свою включает только себе: все три ручки
   * работают от текущего токена, чужой userId принять нельзя.
   */
  app.get('/api/auth/2fa/status', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const row = openMeta(cfg.metaPath).prepare(`SELECT totpEnabled FROM users WHERE id=?`).get(u.id) as { totpEnabled?: number } | undefined;
    return { enabled: Number(row?.totpEnabled ?? 0) === 1 };
  });

  // Шаг 1: подтвердить пароль и получить секрет + otpauth-ссылку для
  // приложения-аутентификатора. Секрет сохраняется, но включается только
  // после проверки кода (чтобы не запереть себя опечаткой).
  app.post('/api/auth/2fa/setup', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (authBlocked(`2fa-setup:${req.ip}:${u.id}`)) throw Object.assign(new Error('Too many failed attempts, try later'), { statusCode: 429 });
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password) throw Object.assign(new Error('password required'), { statusCode: 400 });
    const db = openMeta(cfg.metaPath);
    const row = db.prepare(`SELECT passHash FROM users WHERE id=?`).get(u.id) as { passHash: string } | undefined;
    if (!row || !(await verifyPass(password, row.passHash))) {
      authFailed(`2fa-setup:${req.ip}:${u.id}`);
      await new Promise((res) => setTimeout(res, 300));
      throw Object.assign(new Error('Bad credentials'), { statusCode: 401 });
    }
    authOk(`2fa-setup:${req.ip}:${u.id}`);
    const secret = generateSecret();
    db.prepare(`UPDATE users SET totpSecret=?, totpEnabled=0 WHERE id=?`).run(secret, u.id);
    return { secret, otpauthUrl: otpauthUrl(secret, u.username) };
  });

  // Шаг 2: проверить код из приложения и включить 2FA.
  app.post('/api/auth/2fa/enable', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (authBlocked(`2fa-enable:${req.ip}:${u.id}`)) throw Object.assign(new Error('Too many failed attempts, try later'), { statusCode: 429 });
    const { code } = (req.body ?? {}) as { code?: string };
    const db = openMeta(cfg.metaPath);
    const row = db.prepare(`SELECT totpSecret FROM users WHERE id=?`).get(u.id) as { totpSecret?: string | null } | undefined;
    if (!row?.totpSecret) throw Object.assign(new Error('Run 2fa setup first'), { statusCode: 400 });
    if (!verifyTotp(row.totpSecret, String(code ?? ''))) {
      authFailed(`2fa-enable:${req.ip}:${u.id}`);
      await new Promise((res) => setTimeout(res, 300));
      throw Object.assign(new Error('Bad code'), { statusCode: 401 });
    }
    authOk(`2fa-enable:${req.ip}:${u.id}`);
    db.prepare(`UPDATE users SET totpEnabled=1 WHERE id=?`).run(u.id);
    return { ok: true };
  });

  // Выключение — только по паролю, иначе угнанная сессия снимет защиту.
  app.post('/api/auth/2fa/disable', async (req) => {
    const u = (req as { user?: PanelUser }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (authBlocked(`2fa-disable:${req.ip}:${u.id}`)) throw Object.assign(new Error('Too many failed attempts, try later'), { statusCode: 429 });
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password) throw Object.assign(new Error('password required'), { statusCode: 400 });
    const db = openMeta(cfg.metaPath);
    const row = db.prepare(`SELECT passHash FROM users WHERE id=?`).get(u.id) as { passHash: string } | undefined;
    if (!row || !(await verifyPass(password, row.passHash))) {
      authFailed(`2fa-disable:${req.ip}:${u.id}`);
      await new Promise((res) => setTimeout(res, 300));
      throw Object.assign(new Error('Bad credentials'), { statusCode: 401 });
    }
    authOk(`2fa-disable:${req.ip}:${u.id}`);
    db.prepare(`UPDATE users SET totpSecret=NULL, totpEnabled=0 WHERE id=?`).run(u.id);
    return { ok: true };
  });

  // Второй шаг входа: промежуточный токен + код → полный токен.
  app.post('/api/auth/2fa/verify', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });    let payload;
    try {
      payload = verifyTokenPayload(h.slice(7), cfg.jwtSecret);
    } catch {
      throw Object.assign(new Error('Bad token'), { statusCode: 401 });
    }
    if (payload.scope !== '2fa') throw Object.assign(new Error('Not a 2fa token'), { statusCode: 401 });
    if (authBlocked(`2fa-verify:${req.ip}:${payload.sub}`)) throw Object.assign(new Error('Too many failed attempts, try later'), { statusCode: 429 });
    const { code } = (req.body ?? {}) as { code?: string };
    const db = openMeta(cfg.metaPath);
    const row = db.prepare(`SELECT * FROM users WHERE id=?`).get(payload.sub) as { id: string; username: string; passHash: string; role: Role; totpSecret?: string | null; totpEnabled?: number } | undefined;
    if (!row || row.username !== payload.username || Number(row.totpEnabled ?? 0) !== 1 || !row.totpSecret) {
      throw Object.assign(new Error('Two-factor is not active'), { statusCode: 401 });
    }
    if (!verifyTotp(row.totpSecret, String(code ?? ''))) {
      authFailed(`2fa-verify:${req.ip}:${payload.sub}`);
      await new Promise((res) => setTimeout(res, 300));
      throw Object.assign(new Error('Bad code'), { statusCode: 401 });
    }
    authOk(`2fa-verify:${req.ip}:${payload.sub}`);
    const user: PanelUser = { id: row.id, username: row.username, role: row.role };
    return { token: signToken(user, cfg.jwtSecret, readSessionTtlMin(cfg)), user };
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
    // Смена пароля снимает флаг обязательной смены (первый вход с дефолтом).
    if (password !== undefined) { fields.push('passHash=?'); values.push(await hashPass(password)); fields.push('mustChange=?'); values.push(0); }
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
