// Bootstrap панели DB Manager Pro под FarajaWebServer.
// Готовит backend/.env: порт из config/server.json (mydbroot_port),
// META_PATH под FarajaWebServer, SQLITE_DIR=www/sqlite, секреты.
// Существующие ENCRYPTION_KEY/JWT_SECRET/ADMIN_* не затирает.
// Запуск: node faraja-bootstrap.mjs [--faraja-root C:\FarajaWebServer]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// Скрипт живёт в корне панели (mydbroot/): backend всегда рядом (here/backend),
// а FARAJA_ROOT — родитель, если рядом есть config/server.json (раскладка Faraja).
const FARAJA_ROOT = resolve(arg('--faraja-root') ?? process.env.FARAJA_ROOT ?? (
  existsSync(join(here, '..', 'config', 'server.json')) ? join(here, '..') : here
));
const BACKEND_DIR = join(here, 'backend');
const ENV_PATH = join(BACKEND_DIR, '.env');

function readServerJson() {
  try {
    return JSON.parse(readFileSync(join(FARAJA_ROOT, 'config', 'server.json'), 'utf-8'));
  } catch {
    return {};
  }
}
function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const server = readServerJson();
const port = Number(server.mydbroot_port ?? 3001);
// Единый meta с лаунчером V16: тот форсирует META_PATH=<mydbroot>/backend/data/meta.db
// через окружение процесса (см. docs/FARAJA.md) — bootstrap обязан указывать туда же,
// иначе пресеты и журнал уедут в другой файл.
const metaPath = join(here, 'backend', 'data', 'meta.db');
const sqliteDir = join(FARAJA_ROOT, 'www', 'sqlite');
mkdirSync(dirname(metaPath), { recursive: true });
mkdirSync(sqliteDir, { recursive: true });

const prev = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf-8')) : {};
const hex = (n) => randomBytes(n).toString('hex');
const env = {
  PORT: String(prev.PORT ?? port),
  HOST: prev.HOST ?? '127.0.0.1',
  ENCRYPTION_KEY: prev.ENCRYPTION_KEY ?? hex(32),
  JWT_SECRET: prev.JWT_SECRET ?? hex(32),
  QUERY_MAX_ROWS: prev.QUERY_MAX_ROWS ?? '1000',
  QUERY_TIMEOUT_MS: prev.QUERY_TIMEOUT_MS ?? '30000',
  META_PATH: prev.META_PATH ?? metaPath,
  SQLITE_DIR: prev.SQLITE_DIR ?? sqliteDir,
  ADMIN_USER: prev.ADMIN_USER ?? 'admin',
  ...(prev.ADMIN_PASSWORD ? { ADMIN_PASSWORD: prev.ADMIN_PASSWORD } : {}),
  REQUIRE_AUTH: prev.REQUIRE_AUTH ?? '1',
  CORS_ORIGIN: prev.CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000',
  RATE_LIMIT_MAX: prev.RATE_LIMIT_MAX ?? '200',
  FARAJA_SSO_SECRET: prev.FARAJA_SSO_SECRET ?? hex(32),
};
const lines = [
  `PORT=${env.PORT}`,
  `HOST=${env.HOST}`,
  `ENCRYPTION_KEY=${env.ENCRYPTION_KEY}`,
  `JWT_SECRET=${env.JWT_SECRET}`,
  `QUERY_MAX_ROWS=${env.QUERY_MAX_ROWS}`,
  `QUERY_TIMEOUT_MS=${env.QUERY_TIMEOUT_MS}`,
  `META_PATH=${env.META_PATH}`,
  `SQLITE_DIR=${env.SQLITE_DIR}`,
  `ADMIN_USER=${env.ADMIN_USER}`,
  ...(env.ADMIN_PASSWORD ? [`ADMIN_PASSWORD=${env.ADMIN_PASSWORD}`] : [`# ADMIN_PASSWORD не задан: первый вход admin/admin с обязательной сменой`]),
  `REQUIRE_AUTH=${env.REQUIRE_AUTH}`,
  `CORS_ORIGIN=${env.CORS_ORIGIN}`,
  `RATE_LIMIT_MAX=${env.RATE_LIMIT_MAX}`,
  `FARAJA_SSO_SECRET=${env.FARAJA_SSO_SECRET}`,
  ``,
];
writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
// Зеркало секрета для лаунчера (MiniServer.py читает backend/.env напрямую,
// файл — запасной путь без парсинга .env).
const mirror = join(FARAJA_ROOT, 'config', 'dbmanager-sso.txt');
try {
  mkdirSync(dirname(mirror), { recursive: true });
  writeFileSync(mirror, env.FARAJA_SSO_SECRET + '\n', 'utf-8');
} catch { /* только Windows-пути без прав — не фатально */ }
console.log(`FARAJA BOOTSTRAP OK: port=${env.PORT} meta=${env.META_PATH} sqlite=${env.SQLITE_DIR}`);
