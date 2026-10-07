// Стартовые подключения панели под локальные сервисы FarajaWebServer.
// Идемпотентно: вставляет пресет, только если подключения с таким именем нет.
// Пароли не храним (локальные MariaDB/MySQL — root без пароля, остальные
// правит пользователь через мастер панели).
// Запуск: node faraja-seed-presets.mjs [--faraja-root C:\FarajaWebServer]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FARAJA_ROOT = resolve(arg('--faraja-root') ?? process.env.FARAJA_ROOT ?? (
  existsSync(join(here, '..', 'config', 'server.json')) ? join(here, '..') : here
));
const require = createRequire(join(here, 'backend', 'package.json'));
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = (await import('better-sqlite3')).default;
}
const BackendDb = Database?.default ?? Database;

function readServerJson() {
  try {
    return JSON.parse(readFileSync(join(FARAJA_ROOT, 'config', 'server.json'), 'utf-8'));
  } catch {
    return {};
  }
}
function parseEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const server = readServerJson();
const env = parseEnv(join(here, 'backend', '.env'));
const metaPath = env.META_PATH ?? join(FARAJA_ROOT, 'data', 'dbmanager', 'meta.db');
const P = (k, d) => Number(server[k] ?? d);

const PRESETS = [
  { name: 'MariaDB (Faraja)', kind: 'mariadb', host: '127.0.0.1', port: P('mariadb_port', 3306), user: 'root' },
  { name: 'MySQL (Faraja)', kind: 'mysql', host: '127.0.0.1', port: P('mysql_port', 3307), user: 'root' },
  { name: 'PostgreSQL (Faraja)', kind: 'postgres', host: '127.0.0.1', port: P('postgresql_port', 5432), user: 'postgres' },
  { name: 'Redis (Faraja)', kind: 'redis', host: '127.0.0.1', port: P('redis_port', 6379) },
  { name: 'MongoDB (Faraja)', kind: 'mongodb', host: '127.0.0.1', port: P('mongodb_port', 27017) },
];

const db = new BackendDb(metaPath);
db.exec(`CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  host TEXT, port INTEGER, databaseName TEXT, userName TEXT,
  passwordCipher TEXT, filePath TEXT, readOnly INTEGER DEFAULT 0,
  createdAt INTEGER NOT NULL
)`);
const have = new Set(db.prepare(`SELECT name FROM connections`).all().map((r) => r.name));
let created = 0;
for (const p of PRESETS) {
  if (have.has(p.name)) {
    console.log(`have  ${p.name}`);
    continue;
  }
  db.prepare(`INSERT INTO connections (id,name,kind,host,port,databaseName,userName,passwordCipher,filePath,readOnly,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), p.name, p.kind, p.host ?? null, p.port ?? null, null,
    p.user ?? null, null, null, 0, Date.now(),
  );
  created++;
  console.log(`made  ${p.name} (${p.kind} 127.0.0.1:${p.port})`);
}
db.close();
console.log(`FARAJA PRESETS OK (${created} created, meta=${metaPath})`);
