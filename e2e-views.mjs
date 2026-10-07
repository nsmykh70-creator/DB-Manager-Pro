// E2E представлений: create/drop через design API + чтение и валидация.
const BASE = 'http://localhost:3001';
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

async function cycle(key, c, db, idType) {
  const TBL = 'dz_v_t';
  const VIEW = 'dz_v';
  await req('DELETE', `/api/connections/${c.id}/${db}/views/${VIEW}`, T).catch(() => {});
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [
      { name: 'id', type: idType, primary: true, autoInc: true },
      { name: 'title', type: 'VARCHAR(100)', nullable: false },
    ]
  });
  await req('POST', `/api/connections/${c.id}/import`, T, { format: 'json', db, table: TBL, data: JSON.stringify([{ title: 'hello' }]) });
  const created = await req('POST', `/api/connections/${c.id}/${db}/views`, T, { name: VIEW, sql: `SELECT id, title FROM ${TBL}` });
  check(`${key} createView`, /CREATE VIEW/i.test(created.statement), created.statement.slice(0, 100));
  const tables = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} view listed`, tables.includes(VIEW), tables.join(','));
  const withKind = await req('GET', `/api/connections/${c.id}/${db}/tables?withKind=1`, T);
  const entry = withKind.find((t) => t.name === VIEW);
  check(`${key} withKind marks view`, entry?.kind === 'view', JSON.stringify(entry));
  const schema = await req('GET', `/api/connections/${c.id}/${db}/${VIEW}/schema`, T);
  check(`${key} view kind+cols`, schema.kind === 'view' && schema.columns.map((col) => col.name).join(',') === 'id,title', JSON.stringify(schema.columns.map((col) => col.name)));
  const page = await req('GET', `/api/connections/${c.id}/${db}/${VIEW}/rows?page=1&pageSize=10`, T);
  check(`${key} view rows`, page.rows.length === 1 && page.rows[0].title === 'hello', JSON.stringify(page.rows));
  try {
    await req('POST', `/api/connections/${c.id}/${db}/views`, T, { name: VIEW, sql: `SELECT 1 AS one` });
    check(`${key} duplicate rejected`, false);
  } catch (e) { check(`${key} duplicate rejected`, e.status === 409, `status=${e.status}`); }
  for (const [nm, sql, want] of [
    ['write rejected', `INSERT INTO ${TBL} (title) VALUES ('x')`, 400],
    ['multi rejected', `SELECT 1; SELECT 2`, 400],
    ['empty rejected', `   `, 400],
  ]) {
    try {
      await req('POST', `/api/connections/${c.id}/${db}/views`, T, { name: 'dz_v_bad', sql });
      check(`${key} ${nm}`, false);
    } catch (e) { check(`${key} ${nm}`, e.status === want, `status=${e.status}`); }
  }
  try {
    await req('POST', `/api/connections/${c.id}/${db}/views`, T, { name: 'dz`v', sql: 'SELECT 1 AS one' });
    check(`${key} bad name rejected`, false);
  } catch (e) { check(`${key} bad name rejected`, e.status === 400, `status=${e.status}`); }
  await req('DELETE', `/api/connections/${c.id}/${db}/views/${VIEW}`, T);
  const gone = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} view dropped`, !gone.includes(VIEW), '');
  try {
    await req('DELETE', `/api/connections/${c.id}/${db}/views/${VIEW}`, T);
    check(`${key} drop missing rejected`, false);
  } catch (e) { check(`${key} drop missing rejected`, e.status === 404, `status=${e.status}`); }
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

await cycle('sqlite', byName['e2e-sqlite'], 'main', 'INTEGER');
await cycle('mysql', byName['e2e-mysql'], 'demo', 'INT');
await cycle('maria', byName['e2e-maria'], 'demo', 'INT');
await cycle('pg', byName['e2e-pg'], 'demo', 'INTEGER');

// MongoDB/Redis представлений нет — честный 400
for (const [key, name, db] of [['mongo', 'e2e-mongo', 'demo'], ['redis', 'e2e-redis', '0']]) {
  const c = byName[name];
  try {
    await req('POST', `/api/connections/${c.id}/${db}/views`, T, { name: 'dz_v', sql: 'SELECT 1 AS one' });
    check(`${key} views rejected`, false);
  } catch (e) { check(`${key} views rejected`, e.status === 400, `status=${e.status}`); }
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exitCode = 1; }
else console.log('VIEWS ALL GREEN');
