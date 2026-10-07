// e2e-explain.mjs — план выполнения запроса (EXPLAIN) и защита от не-чтения
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? 'admin123';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const req = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: r.status, body: parsed };
};

const T = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body.token;
const ro = (await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' })).body.token;
const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

// 1) планы для всех СУБД, где EXPLAIN есть
const sqliteTables = (await req('GET', `/api/connections/${byName['e2e-sqlite'].id}/main/tables`, T)).body ?? [];
const sqliteTable = sqliteTables[0];
for (const [name, db, sql] of [
  ['e2e-mysql', 'demo', 'SELECT * FROM users'],
  ['e2e-maria', 'demo', 'SELECT * FROM users'],
  ['e2e-pg', 'demo', 'SELECT * FROM users'],
  ['e2e-sqlite', 'main', `SELECT * FROM "${sqliteTable}"`]
]) {
  const c = byName[name];
  const r = await req('POST', `/api/connections/${c.id}/explain`, T, { sql, db });
  const plan = r.body.plan;
  check(`${name} explain returns plan`, r.status === 200 && plan && plan.rowCount > 0 && Array.isArray(plan.columns),
    `status=${r.status} rows=${plan?.rowCount} ${JSON.stringify(plan?.rows?.[0] ?? {}).slice(0, 80)}`);
}

// 2) ANALYZE в PostgreSQL (выполняет запрос — только для чтения)
const pg = byName['e2e-pg'];
const an = await req('POST', `/api/connections/${pg.id}/explain`, T, { sql: 'SELECT count(*) FROM users', db: 'demo', analyze: true });
check('pg analyze includes timings', an.status === 200 && /Execution Time|Planning Time/.test(JSON.stringify(an.body)),
  `status=${an.status} ${JSON.stringify(an.body).slice(0, 90)}`);
check('analyze rejects writes', (await req('POST', `/api/connections/${pg.id}/explain`, T, { sql: 'DELETE FROM users', db: 'demo', analyze: true })).status === 400);

// 3) не-чтение отклоняется
for (const [name, db, sql, why] of [
  ['e2e-mysql', 'demo', 'DELETE FROM users WHERE id=1', 'DELETE'],
  ['e2e-mysql', 'demo', 'DROP TABLE users', 'DROP'],
  ['e2e-mysql', 'demo', 'INSERT INTO users (name) VALUES (1)', 'INSERT'],
  ['e2e-mysql', 'demo', 'SELECT 1; UPDATE users SET name = 1', 'мультистейтмент с UPDATE'],
  ['e2e-mongo', 'demo', '{}', 'mongo: нет планировщика'],
  ['e2e-redis', '0', 'GET x', 'redis: нет планировщика']
]) {
  const c = byName[name];
  const r = await req('POST', `/api/connections/${c.id}/explain`, T, { sql, db });
  check(`rejected ${why}`, r.status === 400, `status=${r.status} ${String(r.body.error).slice(0, 60)}`);
}

// 4) прочее: пустой запрос, readonly может смотреть план
check('empty sql rejected', (await req('POST', `/api/connections/${pg.id}/explain`, T, { sql: '   ', db: 'demo' })).status === 400);
check('sql required', (await req('POST', `/api/connections/${pg.id}/explain`, T, { db: 'demo' })).status === 400);
check('readonly can explain', (await req('POST', `/api/connections/${pg.id}/explain`, ro, { sql: 'SELECT 1', db: 'demo' })).status === 200);
check('unknown connection 404', (await req('POST', '/api/connections/nope/explain', T, { sql: 'SELECT 1', db: 'demo' })).status === 404);

// 5) аудит: план запроса попадает в журнал
const audit = (await req('GET', `/api/audit?connId=${pg.id}&limit=40`, T)).body ?? [];
check('explain is audited', audit.some((a) => a.action === 'query.explain'), audit.slice(0, 3).map((a) => a.action).join(','));

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('EXPLAIN ALL GREEN');
