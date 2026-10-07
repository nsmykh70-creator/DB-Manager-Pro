// E2E схем PostgreSQL: create/drop + таблицы внутри схемы.
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

{
  const c = byName['e2e-pg'];
  const db = 'demo';
  const SCHEMA = 'dz_s';
  const QT = `${SCHEMA}.dz_t`;
  await req('DELETE', `/api/connections/${c.id}/${db}/schemas/${SCHEMA}?cascade=1`, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/schemas`, T, { name: SCHEMA });
  check('pg createSchema', /CREATE SCHEMA/i.test(created.statement), created.statement);
  try {
    await req('POST', `/api/connections/${c.id}/${db}/schemas`, T, { name: SCHEMA });
    check('pg duplicate rejected', false);
  } catch (e) { check('pg duplicate rejected', e.status === 409, `status=${e.status}`); }
  try {
    await req('POST', `/api/connections/${c.id}/${db}/schemas`, T, { name: 'dz`s' });
    check('pg bad name rejected', false);
  } catch (e) { check('pg bad name rejected', e.status === 400, `status=${e.status}`); }
  try {
    await req('DELETE', `/api/connections/${c.id}/${db}/schemas/public`, T);
    check('pg public protected', false);
  } catch (e) { check('pg public protected', e.status === 400, `status=${e.status}`); }
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: QT, columns: [{ name: 'id', type: 'INTEGER', primary: true }, { name: 'title', type: 'VARCHAR(50)' }]
  });
  const tables = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check('pg schema table listed', tables.includes(QT), tables.filter((t) => t.includes('dz_')).join(','));
  const schema = await req('GET', `/api/connections/${c.id}/${db}/${QT}/schema`, T);
  check('pg schema table readable', schema.table === QT && schema.columns.length === 2, JSON.stringify(schema.columns.map((col) => col.name)));
  try {
    await req('DELETE', `/api/connections/${c.id}/${db}/schemas/${SCHEMA}`, T);
    check('pg non-empty rejected', false);
  } catch (e) { check('pg non-empty rejected', e.status === 409, `status=${e.status}`); }
  await req('DELETE', `/api/connections/${c.id}/${db}/${QT}`, T);
  await req('DELETE', `/api/connections/${c.id}/${db}/schemas/${SCHEMA}`, T);
  const after = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check('pg schema dropped', !after.includes(QT), '');
  try {
    await req('DELETE', `/api/connections/${c.id}/${db}/schemas/${SCHEMA}`, T);
    check('pg drop missing rejected', false);
  } catch (e) { check('pg drop missing rejected', e.status === 404, `status=${e.status}`); }
}

// Остальные СУБД схем не имеют — честный 400
for (const [key, name, db] of [['mysql', 'e2e-mysql', 'demo'], ['sqlite', 'e2e-sqlite', 'main']]) {
  const c = byName[name];
  try {
    await req('POST', `/api/connections/${c.id}/${db}/schemas`, T, { name: 'dz_s' });
    check(`${key} schemas rejected`, false);
  } catch (e) { check(`${key} schemas rejected`, e.status === 400, `status=${e.status}`); }
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exitCode = 1; }
else console.log('SCHEMA ALL GREEN');
