// E2E всех драйверов через HTTP API. Требует запущенный backend (REQUIRE_AUTH=1).
import { ensureDatabase } from './e2e-fixtures.mjs';

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
// Хосты, которые backend видит изнутри своего контейнера: по умолчанию это
// compose-имена сервисов. Для нативного запуска backend на хосте задайте
// E2E_*_HOST=127.0.0.1 (или E2E_DB_HOST, чтобы переопределить все сразу).
const DB_HOST = process.env.E2E_DB_HOST || '';
const MYSQL_HOST = process.env.E2E_MYSQL_HOST || DB_HOST || 'mysql';
const MARIADB_HOST = process.env.E2E_MARIADB_HOST || DB_HOST || 'mariadb';
const PG_HOST = process.env.E2E_PG_HOST || DB_HOST || 'postgres';
const MONGO_HOST = process.env.E2E_MONGO_HOST || DB_HOST || 'mongo';
// Хост для прямых подключений из самого скрипта (не через API).
const LOCAL_MONGO_HOST = process.env.E2E_LOCAL_MONGO_HOST || '127.0.0.1';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload = undefined;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? JSON.stringify(j)}`);
  return j;
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;

const wanted = [
  { name: 'e2e-mysql', kind: 'mysql', host: MYSQL_HOST, port: 3306, database: 'demo', user: 'root', password: 'root' },
  { name: 'e2e-maria', kind: 'mariadb', host: MARIADB_HOST, port: 3306, database: 'demo', user: 'root', password: 'root' },
  { name: 'e2e-pg', kind: 'postgres', host: PG_HOST, port: 5432, database: 'demo', user: 'root', password: 'root' },
  { name: 'e2e-mongo', kind: 'mongodb', host: MONGO_HOST, port: 27017, database: 'demo' }
];

const existing = await req('GET', '/api/connections', T);
const conns = {};
for (const w of wanted) {
  let c = existing.find((x) => x.name === w.name);
  if (!c) c = await req('POST', '/api/connections', T, w);
  else {
    // Синхронизируем существующее подключение с текущим compose-окружением,
    // иначе устаревший host/port из прошлых прогонов ломает весь набор.
    const drift = ['host', 'port', 'database', 'user'].filter((k) => c[k] !== w[k] && w[k] !== undefined);
    if (drift.length) c = await req('PATCH', `/api/connections/${c.id}`, T, Object.fromEntries(drift.map((k) => [k, w[k]])));
  }
  conns[w.kind === 'mariadb' ? 'maria' : w.kind === 'mongodb' ? 'mongo' : w.kind === 'postgres' ? 'pg' : 'mysql'] = c;
  const t = await req('POST', `/api/connections/${c.id}/test`, T);
  check(`${w.name} test`, t.ok === true, `${t.latencyMs}ms`);
}

// Базу demo могли удалить из UI или сбить вручную — тогда весь набор падает
// не по своей вине. Восстанавливаем её перед проверками (идемпотентно).
await ensureDatabase(req, T, conns.mysql.id, { colType: 'VARCHAR(100)', idType: 'INT AUTO_INCREMENT' });
await ensureDatabase(req, T, conns.maria.id, { colType: 'VARCHAR(100)', idType: 'INT AUTO_INCREMENT' });
await ensureDatabase(req, T, conns.pg.id, { colType: 'TEXT', idType: 'SERIAL' });
await ensureDatabase(req, T, conns.mongo.id, { mongo: true });

async function cycle(key, id, db, isMongo) {
  const dbs = await req('GET', `/api/connections/${id}/databases`, T);
  check(`${key} databases`, Array.isArray(dbs) && dbs.includes('demo'), JSON.stringify(dbs).slice(0, 80));
  const tables = await req('GET', `/api/connections/${id}/${db}/tables`, T);
  check(`${key} tables`, tables.includes('users'), JSON.stringify(tables));
  const rows = await req('GET', `/api/connections/${id}/${db}/users/rows?page=1&pageSize=10`, T);
  check(`${key} rows`, rows.columns.includes('name') && rows.rows.length >= 2, `cols=${rows.columns}`);
  const sql = isMongo ? JSON.stringify({ collection: 'users', filter: {}, limit: 50 }) : 'SELECT * FROM users';
  const q = await req('POST', `/api/connections/${id}/query`, T, { sql });
  check(`${key} query`, q.rowCount >= 2, `rowCount=${q.rowCount} execMs=${q.execMs}`);
  const imp = await req('POST', `/api/connections/${id}/import`, T, { format: 'json', db, table: 'users', data: JSON.stringify([{ name: 'E2E', age: 99 }]) });
  check(`${key} import`, imp.inserted === 1, JSON.stringify(imp));
  const q2 = await req('POST', `/api/connections/${id}/query`, T, { sql });
  check(`${key} count+1`, q2.rowCount === q.rowCount + 1, `${q.rowCount}->${q2.rowCount}`);
  // чистка за собой
  const del = isMongo ? JSON.stringify({ collection: 'users', filter: { name: 'E2E' }, limit: 50 }) : `DELETE FROM users WHERE name='E2E'`;
  if (!isMongo) await req('POST', `/api/connections/${id}/query`, T, { sql: del });
  else {
    // mongo query — только чтение; удаляем напрямую драйвером ниже
    const { MongoClient } = await import('mongodb');
    const mc = new MongoClient(`mongodb://${LOCAL_MONGO_HOST}:27017`);
    await mc.connect();
    await mc.db('demo').collection('users').deleteMany({ name: 'E2E' });
    await mc.close();
  }
}

await cycle('mysql', conns.mysql.id, 'demo', false);
await cycle('maria', conns.maria.id, 'demo', false);
await cycle('pg', conns.pg.id, 'demo', false);
await cycle('mongo', conns.mongo.id, 'demo', true);

// SQL-скрипт импорт на mysql + export csv
const scr = await req('POST', `/api/connections/${conns.mysql.id}/import`, T, { format: 'sql', db: 'demo', data: 'CREATE TABLE IF NOT EXISTS e2e_t(a TEXT); INSERT INTO e2e_t(a) VALUES (\'x\');' });
check('mysql execScript', scr.statements === 2, JSON.stringify(scr));
await req('POST', `/api/connections/${conns.mysql.id}/query`, T, { sql: 'DROP TABLE e2e_t' });
check('mysql drop ok', true);

// --- удаление баз данных: права, системные базы и Redis
{
  const status = async (method, path, token, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const parsed = await r.json().catch(() => ({}));
    return { status: r.status, body: parsed };
  };

  // Redis: «база» — это номер 0…15, удалить её нельзя. Раньше панель показывала
  // кнопку и получала 400 «Unsupported kind», теперь и кнопки нет, и ошибка внятная.
  // Подключение создаём при необходимости — набор должен быть самовосстанавливающимся.
  const allConns = await req('GET', '/api/connections', T);
  let redisConn = allConns.find((c) => c.name === 'e2e-redis');
  if (!redisConn) {
    const anyRedis = allConns.find((c) => c.kind === 'redis');
    // Подключение может существовать под другим именем (создали вручную) —
    // остальные наборы ищут именно e2e-redis, поэтому переименовываем.
    redisConn = anyRedis
      ? await req('PATCH', `/api/connections/${anyRedis.id}`, T, { name: 'e2e-redis', host: process.env.E2E_REDIS_HOST || 'redis' })
      : await req('POST', '/api/connections', T, {
        name: 'e2e-redis', kind: 'redis', host: process.env.E2E_REDIS_HOST || 'redis', port: 6379, database: '0'
      });
    console.log('  redis: connection prepared', redisConn.id);
  }
  if (redisConn) {
    const del = await status('DELETE', `/api/connections/${redisConn.id}/databases/15`, T);
    check('redis db drop refused', del.status === 400, `status=${del.status}`);
    check('redis refusal explains', /redis/i.test(String(del.body.error ?? '')), String(del.body.error).slice(0, 120));
    const dbs = await req('GET', `/api/connections/${redisConn.id}/databases`, T);
    check('redis databases still listed', Array.isArray(dbs) && dbs.length > 0, 'n=' + (Array.isArray(dbs) ? dbs.length : 'n/a'));
  } else {
    check('redis connection present', false, 'no redis connection in this env');
  }

  // системные базы защищены
  const sysDrop = await status('DELETE', `/api/connections/${conns.mysql.id}/databases/mysql`, T);
  check('system db protected', sysDrop.status === 400, `status=${sysDrop.status}`);

  // права: editor/anonymous удалить базу не может
  const editor = await req('POST', '/api/auth/login', null, { username: 'e2e_editor', password: 'editorpass123' });
  const edDrop = await status('DELETE', `/api/connections/${conns.mysql.id}/databases/demo`, editor.token);
  check('editor cannot drop db', edDrop.status === 403, `status=${edDrop.status}`);
  const anonDrop = await status('DELETE', `/api/connections/${conns.mysql.id}/databases/demo`);
  check('anonymous cannot drop db', anonDrop.status === 401, `status=${anonDrop.status}`);

  // обычный случай: создали и удалили
  const tmp = 'e2e_drop_db';
  await req('POST', '/api/connections/' + conns.mysql.id + '/query', T, { sql: `DROP DATABASE IF EXISTS \`${tmp}\`` });
  await req('POST', '/api/databases', T, { connectionId: conns.mysql.id, name: tmp });
  const afterCreate = await req('GET', `/api/connections/${conns.mysql.id}/databases`, T);
  check('db created', afterCreate.some((d) => d === tmp || d?.name === tmp), 'n=' + afterCreate.length);
  const dropped = await status('DELETE', `/api/connections/${conns.mysql.id}/databases/${tmp}`, T);
  check('db dropped', dropped.status === 200, `status=${dropped.status} ${JSON.stringify(dropped.body).slice(0, 80)}`);
  const afterDrop = await req('GET', `/api/connections/${conns.mysql.id}/databases`, T);
  check('db gone', !afterDrop.some((d) => d === tmp || d?.name === tmp), 'n=' + afterDrop.length);

  // Имя БД: длина и символы. Без проверки длины длинное имя доходило до СУБД
  // и панель отвечала 502 вместо понятного 400.
  const longName = 'e2e_' + 'x'.repeat(80);
  const longRes = await status('POST', '/api/databases', T, { connectionId: conns.mysql.id, name: longName });
  check('too long name is 400 not 502', longRes.status === 400, `status=${longRes.status} ${JSON.stringify(longRes.body).slice(0, 80)}`);
  for (const bad of ['моя_база', 'my-db', 'db.name']) {
    const r = await status('POST', '/api/databases', T, { connectionId: conns.mysql.id, name: bad });
    check(`bad name rejected: ${bad}`, r.status === 400 && /латиница/i.test(String(r.body.error)), `status=${r.status}`);
  }

  // DELETE без тела, но с Content-Type: application/json — обычная ситуация
  // для curl/скриптов; раньше Fastify отвечал 400 «Body cannot be empty».
  const tmp2 = 'e2e_drop_db2';
  await req('POST', '/api/databases', T, { connectionId: conns.mysql.id, name: tmp2 });
  const withCt = await fetch(`${BASE}/api/connections/${conns.mysql.id}/databases/${tmp2}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }
  });
  check('delete with json content-type and no body', withCt.status === 200, `status=${withCt.status}`);
  const gone2 = await req('GET', `/api/connections/${conns.mysql.id}/databases`, T);
  check('db gone after header-only delete', !gone2.includes(tmp2), 'n=' + gone2.length);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('ALL GREEN');
