import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../core/config.js';

// Типы СУБД, которые панель умеет показывать. Настройка enabledKinds
// ограничивает, какие из них видны в боковых панелях и доступны для выбора.
const ALL_KINDS = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'] as const;
type Kind = (typeof ALL_KINDS)[number];

const defaults = {
  projectName: 'DB Manager Pro',
  timezone: 'UTC',
  theme: 'dark' as 'light' | 'dark',
  checkUpdates: true,
  toastsEnabled: true,
  toastDuration: 5000,
  notificationsEnabled: true,
  enabledKinds: [...ALL_KINDS] as Kind[],
};

type Settings = typeof defaults;

/** Приводим список типов к Known: мусор и дубликаты отбрасываем, порядок
 * сохраняем. Пустой или отсутствующий список означает «все типы включены» —
 * иначе старый settings.json без этого поля выключил бы всё сразу. */
function normalizeKinds(value: unknown): Kind[] {
  if (!Array.isArray(value)) return [...ALL_KINDS];
  const seen = new Set<string>();
  for (const item of value) {
    const kind = typeof item === 'string' ? (item === 'postgresql' ? 'postgres' : item) : '';
    if ((ALL_KINDS as readonly string[]).includes(kind)) seen.add(kind);
  }
  return ALL_KINDS.filter(kind => seen.has(kind));
}

function settingsPath(cfg: AppConfig): string {
  return resolve(dirname(cfg.metaPath), 'settings.json');
}

function readSettings(cfg: AppConfig): Settings {
  const path = settingsPath(cfg);
  if (!existsSync(path)) return { ...defaults };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    return {
      projectName: typeof value.projectName === 'string' ? value.projectName : defaults.projectName,
      timezone: typeof value.timezone === 'string' ? value.timezone : defaults.timezone,
      theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : defaults.theme,
      checkUpdates: typeof value.checkUpdates === 'boolean' ? value.checkUpdates : defaults.checkUpdates,
      toastsEnabled: typeof value.toastsEnabled === 'boolean' ? value.toastsEnabled : defaults.toastsEnabled,
      toastDuration: Number.isFinite(Number(value.toastDuration)) && Number(value.toastDuration) >= 0 ? Number(value.toastDuration) : defaults.toastDuration,
      notificationsEnabled: typeof value.notificationsEnabled === 'boolean' ? value.notificationsEnabled : defaults.notificationsEnabled,
      enabledKinds: normalizeKinds(value.enabledKinds),
    };
  } catch {
    return { ...defaults };
  }
}

export function settingsRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/settings', async () => readSettings(cfg));
  app.put('/api/settings', async (req) => {
    // Настройки панели — общие для инстанса: менять может только админ
    const u = (req as unknown as { user?: { role?: string } }).user;
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const body = (req.body ?? {}) as Partial<Settings>;
    const next: Settings = {
      projectName: typeof body.projectName === 'string' && body.projectName.trim() ? body.projectName.trim().slice(0, 120) : defaults.projectName,
      timezone: typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim().slice(0, 64) : defaults.timezone,
      theme: body.theme === 'light' || body.theme === 'dark' ? body.theme : defaults.theme,
      checkUpdates: typeof body.checkUpdates === 'boolean' ? body.checkUpdates : defaults.checkUpdates,
      toastsEnabled: typeof body.toastsEnabled === 'boolean' ? body.toastsEnabled : defaults.toastsEnabled,
      toastDuration: Number.isFinite(Number(body.toastDuration)) && Number(body.toastDuration) >= 0 ? Math.min(Number(body.toastDuration), 3_600_000) : defaults.toastDuration,
      notificationsEnabled: typeof body.notificationsEnabled === 'boolean' ? body.notificationsEnabled : defaults.notificationsEnabled,
      enabledKinds: normalizeKinds(body.enabledKinds),
    };
    writeFileSync(settingsPath(cfg), JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

export { ALL_KINDS };
