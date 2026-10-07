import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnvFile(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '../.env'),
    resolve(moduleDir, '../../.env'),
    resolve(process.cwd(), 'backend', '.env'),
    resolve(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, 'utf-8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
      }
    } catch {}
    break;
  }
}

export interface AppConfig {
  port: number;
  host: string;
  encryptionKeyHex: string;
  jwtSecret: string;
  queryMaxRows: number;
  queryTimeoutMs: number;
  metaPath: string;
  adminUser: string;
  adminPassword: string;
  requireAuth: boolean;
  corsOrigins: string[];
  rateLimitMax: number;
}

function need(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env ${name}. See backend/.env.example`);
  return v;
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET ?? '';
    const encryptionKey = process.env.ENCRYPTION_KEY ?? '';
    const adminPassword = process.env.ADMIN_PASSWORD ?? '';
    if (!jwtSecret || /dev|change|default|secret/i.test(jwtSecret)) throw new Error('JWT_SECRET must be replaced in production');
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey) || /^0+$/.test(encryptionKey)) throw new Error('ENCRYPTION_KEY must be a generated 64-character hex value');
    if (adminPassword.length < 12 || /^(admin|password|testpass|change)/i.test(adminPassword)) throw new Error('ADMIN_PASSWORD must be replaced with a strong value');
  }
  return {
     port: Number(process.env.PORT ?? 3001),
     host: process.env.HOST ?? '127.0.0.1',
    encryptionKeyHex: need('ENCRYPTION_KEY'),
    jwtSecret: need('JWT_SECRET'),
    queryMaxRows: Number(process.env.QUERY_MAX_ROWS ?? 1000),
    queryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS ?? 30000),
    metaPath: process.env.META_PATH ?? './data/meta.db',
    adminUser: need('ADMIN_USER'),
    adminPassword: need('ADMIN_PASSWORD'),
    requireAuth: (process.env.REQUIRE_AUTH ?? '1') === '1',
    corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map((origin) => origin.trim()).filter(Boolean),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 200)
  };
}
