import { ensureRedis } from './e2e-fixtures.mjs';
// E2E CRUD триггеров: создание/удаление через design API для mysql, mariadb,
// postgres (тело — вызов функции) и sqlite (тело оборачивается в BEGIN..END).
// Плюс валидация: мусорные имена, неизвестные timing/event, тело из двух
// стейтментов там, где СУБД требует один.
const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const DB_HOST = process.env.E2E_DB_HOST || '';
const MYSQL_HOST = process.env.E2E_MYSQL_HOST || DB_HOST || 'mysql';
const MARIADB_HOST = process.env.E2E_MARIADB_HOST || DB_HOST || 'mariadb';
const PG_HOST = process.env.E2E_PG_HOST || DB_HOST || 'postgres';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;
const conns = await req('GET', '/api/connections', T);
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

async function syncHost(c, host) {
  if (c.host !== host) await req('PATCH', `/api/connections/${c.id}`, T, { host });
  return host;
}

const TBL = 'trg_host';

async function reset(c, db) {
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${TBL}` }).catch(() => {});
}

async function schemaTriggers(c, db) {
  const s = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  return s.triggers;
}

// --- MySQL / MariaDB: одиночный стейтмент в FOR EACH ROW
for (const key of ['mysql', 'maria']) {
  const c = byName[`e2e-${key}`];
  await syncHost(c, key === 'mysql' ? MYSQL_HOST : MARIADB_HOST);
  const db = 'demo';
  await reset(c, db);
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [{ name: 'id', type: key === 'mysql' ? 'INT' : 'INT', primary: true }, { name: 'name', type: 'VARCHAR(50)' }]
  });
  const created = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, {
    name: 'trg_demo_bi', timing: 'before', event: 'insert', statement: 'SET @x = NEW.name'
  });
  check(`${key} createTrigger`, /CREATE TRIGGER/.test(created.statement) && /BEFORE INSERT/.test(created.statement) && /FOR EACH ROW/.test(created.statement), created.statement);
  let list = await schemaTriggers(c, db);
  let trg = list.find((t) => t.name === 'trg_demo_bi');
  check(`${key} trigger in schema`, trg?.timing === 'BEFORE' && trg?.event === 'INSERT' && /NEW\.name/.test(trg?.statement ?? ''), JSON.stringify(trg));

  // дубль имени — ошибка сервера
  try {
    await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, { name: 'trg_demo_bi', timing: 'BEFORE', event: 'INSERT', statement: 'SET @x = 1' });
    check(`${key} duplicate rejected`, false);
  } catch (e) { check(`${key} duplicate rejected`, e.status === 409, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 60)}`); }

  for (const [nm, body, wantStatus] of [
    ['bad timing', { name: 'trg_x', timing: 'SOMETIMES', event: 'INSERT', statement: 'SET @x = 1' }, 400],
    ['bad event', { name: 'trg_x', timing: 'BEFORE', event: 'SELECT', statement: 'SET @x = 1' }, 400],
    ['bad name', { name: 'trg`x', timing: 'BEFORE', event: 'INSERT', statement: 'SET @x = 1' }, 400],
    ['multi statement body', { name: 'trg_x', timing: 'BEFORE', event: 'INSERT', statement: 'SET @x = 1; SET @y = 2' }, 400],
    ['instead of', { name: 'trg_x', timing: 'INSTEAD OF', event: 'INSERT', statement: 'SET @x = 1' }, 400],
    ['empty body', { name: 'trg_x', timing: 'BEFORE', event: 'INSERT', statement: '  ' }, 400]
  ]) {
    try {
      await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, body);
      check(`${key} ${nm} rejected`, false);
    } catch (e) { check(`${key} ${nm} rejected`, e.status === wantStatus, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 70)}`); }
  }

  const dropped = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_demo_bi`, T);
  check(`${key} dropTrigger`, /DROP TRIGGER/.test(dropped.statement), dropped.statement);
  list = await schemaTriggers(c, db);
  check(`${key} trigger gone`, !list.some((t) => t.name === 'trg_demo_bi'), JSON.stringify(list.map((t) => t.name)));
  // повторное удаление не должно падать
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_demo_bi`, T);
  check(`${key} dropTrigger idempotent`, true, '');
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE ${TBL}` });
}

// --- PostgreSQL: тело — вызов функции
{
  const c = byName['e2e-pg'];
  await syncHost(c, PG_HOST);
  const db = 'demo';
  await reset(c, db);
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP FUNCTION IF EXISTS trg_touch()' });
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [{ name: 'id', type: 'SERIAL', primary: true }, { name: 'name', type: 'TEXT' }]
  });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE FUNCTION trg_touch() RETURNS trigger AS $$ BEGIN NEW.name := upper(NEW.name); RETURN NEW; END; $$ LANGUAGE plpgsql' });
  const created = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, {
    name: 'trg_pg_bi', timing: 'BEFORE', event: 'INSERT', statement: 'trg_touch'
  });
  check('pg createTrigger', /EXECUTE FUNCTION "public"\."trg_touch"\(\)/.test(created.statement), created.statement);
  const list = await schemaTriggers(c, db);
  const trg = list.find((t) => t.name === 'trg_pg_bi');
  check('pg trigger in schema', trg?.timing === 'BEFORE' && trg?.event === 'INSERT', JSON.stringify(trg));

  // имя функции валидируется: инъекция в statement не пройдёт
  for (const [nm, body] of [
    ['function name injection', { name: 'trg_x', timing: 'BEFORE', event: 'INSERT', statement: 'trg_touch(); DROP TABLE users' }],
    ['function name backtick', { name: 'trg_x', timing: 'BEFORE', event: 'INSERT', statement: 'a"b' }]
  ]) {
    try {
      await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, body);
      check(`pg ${nm} rejected`, false);
    } catch (e) { check(`pg ${nm} rejected`, e.status === 400, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 70)}`); }
  }

  const dropped = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_pg_bi`, T);
  check('pg dropTrigger', /DROP TRIGGER "trg_pg_bi" ON "public"\."trg_host"/.test(dropped.statement), dropped.statement);
  check('pg trigger gone', !(await schemaTriggers(c, db)).some((t) => t.name === 'trg_pg_bi'), '');
  // неизвестная таблица — 404, а не 500
  try {
    await req('DELETE', `/api/connections/${c.id}/${db}/no_such_table/triggers/trg_pg_bi`, T);
    check('pg dropTrigger 404', false);
  } catch (e) { check('pg dropTrigger 404', e.status === 404, `status=${e.status}`); }
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE ${TBL}` });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP FUNCTION trg_touch()' });
}

// --- SQLite: тело само оборачивается в BEGIN ... END, несколько стейтментов разрешены
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  await reset(c, db);
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [{ name: 'id', type: 'INTEGER', primary: true }, { name: 'name', type: 'TEXT' }]
  });
  const created = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, {
    name: 'trg_sq_ai', timing: 'after', event: 'insert', statement: "UPDATE trg_host SET name = NEW.name WHERE id = NEW.id; UPDATE trg_host SET name = name WHERE id = NEW.id"
  });
  check('sqlite createTrigger wraps body', /BEGIN UPDATE .*; UPDATE .*; END/i.test(created.statement), created.statement);
  const list = await schemaTriggers(c, db);
  const trg = list.find((t) => t.name === 'trg_sq_ai');
  check('sqlite trigger in schema', trg?.timing === 'AFTER' && trg?.event === 'INSERT' && /BEGIN/.test(trg?.statement ?? ''), JSON.stringify(trg)?.slice(0, 160));

  // BEGIN/END от пользователя не оборачиваются дважды
  const wrapped = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, {
    name: 'trg_sq_ai2', timing: 'BEFORE', event: 'UPDATE', statement: 'BEGIN UPDATE trg_host SET name = name; END'
  });
  check('sqlite no double wrap', (wrapped.statement.match(/BEGIN/gi) ?? []).length === 1, wrapped.statement);
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_sq_ai2`, T);

  const dropped = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_sq_ai`, T);
  check('sqlite dropTrigger', /DROP TRIGGER IF EXISTS/.test(dropped.statement), dropped.statement);
  check('sqlite trigger gone', !(await schemaTriggers(c, db)).some((t) => t.name === 'trg_sq_ai'), '');
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// --- MongoDB/Redis: триггеров нет
const redisConn = await ensureRedis(req, T, byName);
for (const [name, c] of [['e2e-mongo', byName['e2e-mongo']], ['e2e-redis', redisConn]]) {
  const db = name === 'e2e-mongo' ? 'demo' : '0';
  try {
    await req('POST', `/api/connections/${c.id}/${db}/whatever/triggers`, T, { name: 't', timing: 'BEFORE', event: 'INSERT', statement: 'x' });
    check(`${name} trigger rejected`, false);
  } catch (e) { check(`${name} trigger rejected`, e.status === 400 && /not supported/i.test(String(e.body?.error ?? e.message)), `status=${e.status}`); }
}

// --- readonly и read-only соединение
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const c = byName['e2e-mysql'];
  const r = await fetch(`${BASE}/api/connections/${c.id}/demo/${TBL}/triggers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ro.token}` },
    body: JSON.stringify({ name: 'trg_ro', timing: 'BEFORE', event: 'INSERT', statement: 'SET @x = 1' })
  });
  check('ro trigger blocked', r.status === 403, `status=${r.status}`);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('TRIGGERS ALL GREEN');
