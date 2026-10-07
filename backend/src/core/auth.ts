import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { openMeta } from './store.js';
import { isWriteSql } from './sql-classifier.js';
export { isWriteSql } from './sql-classifier.js';

export type Role = 'admin' | 'editor' | 'readonly';
export interface PanelUser { id: string; username: string; role: Role; }
export interface JwtPayload {
  sub: string; username: string; role: Role;
  /** Область токена: '2fa' — промежуточный (только подтверждение кода),
   *  отсутствие поля — полный (старые токены тоже полные). */
  scope?: '2fa';
}

export async function hashPass(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export async function verifyPass(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function signToken(u: PanelUser, secret: string, ttlMin = 720): string {
  const minutes = Number.isFinite(ttlMin) && ttlMin >= 5 && ttlMin <= 43200 ? Math.floor(ttlMin) : 720;
  return jwt.sign({ sub: u.id, username: u.username, role: u.role } as JwtPayload, secret, { expiresIn: `${minutes}m` });
}

/** Короткий (5 мин) промежуточный токен второго шага 2FA. Полным не является:
 *  auth-hook отбрасывает его везде, кроме /auth/2fa/verify. */
export function signTempToken(u: PanelUser, secret: string): string {
  return jwt.sign({ sub: u.id, username: u.username, role: u.role, scope: '2fa' } as JwtPayload, secret, { expiresIn: '5m' });
}

export function verifyToken(token: string, secret: string): PanelUser {
  const p = jwt.verify(token, secret) as JwtPayload;
  return { id: p.sub, username: p.username, role: p.role };
}

/** Полный пейлоад (нужен auth-hook: промежуточный 2FA-токен пускаем только
 *  на подтверждение кода). */
export function verifyTokenPayload(token: string, secret: string): JwtPayload {
  return jwt.verify(token, secret) as JwtPayload;
}

export function isCurrentUser(metaPath: string, user: PanelUser): boolean {
  const row = openMeta(metaPath).prepare(`SELECT id,username,role FROM users WHERE id=?`).get(user.id) as { id: string; username: string; role: Role } | undefined;
  return Boolean(row && row.username === user.username && row.role === user.role);
}

/** Создать админа из ENV при первом старте, если таблица users пуста. */
export async function ensureAdmin(metaPath: string, username: string, password: string, mustChange = false): Promise<void> {
  const db = openMeta(metaPath);
  const n = (db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  if (n > 0) return;
  const h = await hashPass(password);
  db.prepare(`INSERT INTO users (id,username,passHash,role,createdAt,mustChange) VALUES (?,?,?,?,?,?)`).run(randomUUID(), username, h, 'admin', Date.now(), mustChange ? 1 : 0);
}

/** Глобальный RBAC для роли readonly: запретить любые пишущие SQL. */
export function assertRoleWritable(role: Role | undefined, sqlOrAction: string): void {
  if (role === 'readonly' && isWriteSql(sqlOrAction)) {
    throw Object.assign(new Error('Role readonly cannot write'), { statusCode: 403 });
  }
}

/**
 * Временная блокировка перебора паролей/кодов: 10 неудач за 10 минут с одного
 * ключа (IP + пользователь) — отказ 429 на 15 минут. Пауза 300 мс остаётся
 * первым рубежом, блокировка — вторым. Хранилище в памяти: рестарт сбрасывает
 * счётчики (приемлемо для одного инстанса; кластера у панели нет).
 */
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 10 * 60_000;
const AUTH_BLOCK_MS = 15 * 60_000;
const authFailures = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();

export function authBlocked(key: string, now = Date.now()): boolean {
  const entry = authFailures.get(key);
  if (!entry) return false;
  if (now < entry.blockedUntil) return true;
  if (now - entry.firstAt > AUTH_FAIL_WINDOW_MS) authFailures.delete(key);
  return false;
}

export function authFailed(key: string, now = Date.now()): void {
  let entry = authFailures.get(key);
  if (!entry || now - entry.firstAt > AUTH_FAIL_WINDOW_MS) {
    entry = { count: 0, firstAt: now, blockedUntil: 0 };
  }
  entry.count++;
  if (entry.count >= AUTH_FAIL_LIMIT) entry.blockedUntil = now + AUTH_BLOCK_MS;
  authFailures.set(key, entry);
  if (authFailures.size > 10_000) {
    for (const [k, v] of authFailures) {
      if (now > v.blockedUntil && now - v.firstAt > AUTH_FAIL_WINDOW_MS) authFailures.delete(k);
      if (authFailures.size <= 10_000) break;
    }
  }
}

export function authOk(key: string): void {
  authFailures.delete(key);
}
