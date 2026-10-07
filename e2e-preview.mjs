import { ensureRedis } from './e2e-fixtures.mjs';
// E2E предпросмотра DDL: /preview должен возвращать ровно те же стейтменты,
// которые применит PATCH, ничего не выполняя; поведение транзакционности
// отличается у MySQL (нет отката) и pg/sqlite (есть).
const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const DB_HOST = process.env.E2E_DB_HOST || '';
const MYSQL_HOST = process.env.E2E_MYSQL_HOST || DB_HOST || 'mysql';
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

const TBL = 'pv_t';

async function prepare(c, db, cols) {
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${TBL}` }).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, { name: TBL, columns: cols });
}

const colDefs = (pkType) => [
  { name: 'id', type: pkType, primary: true },
  { name: 'title', type: 'VARCHAR(50)', nullable: false }
];

for (const key of ['mysql', 'maria', 'pg', 'sqlite']) {
  const c = byName[`e2e-${key}`];
  if (key === 'mysql' && c.host !== MYSQL_HOST) await req('PATCH', `/api/connections/${c.id}`, T, { host: MYSQL_HOST });
  if (key === 'pg' && c.host !== PG_HOST) await req('PATCH', `/api/connections/${c.id}`, T, { host: PG_HOST });
  const db = key === 'sqlite' ? 'main' : 'demo';
  const pkType = key === 'pg' ? 'INTEGER' : key === 'sqlite' ? 'INTEGER' : 'INT';
  await prepare(c, db, colDefs(pkType));

  const ops = [
    { op: 'addColumn', column: { name: 'note', type: key === 'pg' || key === 'sqlite' ? 'TEXT' : 'VARCHAR(50)' } },
    { op: 'addIndex', index: { name: 'idx_pv_title', columns: ['title'], unique: true } }
  ];
  const preview = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/preview`, T, { ops });
  check(`${key} preview statements`, preview.statements.length === 2 && /ALTER TABLE/.test(preview.statements[0]) && /CREATE UNIQUE INDEX/.test(preview.statements[1]), JSON.stringify(preview.statements));
  check(`${key} preview before`, Array.isArray(preview.before) && preview.before.some((line) => line.startsWith('column id')), JSON.stringify(preview.before).slice(0, 140));
  const expectTx = key === 'pg' || key === 'sqlite';
  check(`${key} preview transactional flag`, preview.transactional === expectTx, `got=${preview.transactional} want=${expectTx}`);
  check(`${key} preview hint`, preview.applyHint.length > 20, preview.applyHint.slice(0, 60));

  // предпросмотр ничего не применил
  const untouched = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check(`${key} preview is dry-run`, !untouched.columns.some((col) => col.name === 'note') && !untouched.indexes.some((ix) => ix.name === 'idx_pv_title'), untouched.columns.map((col) => col.name).join(','));

  // apply отдаёт те же стейтменты
  const applied = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops });
  check(`${key} apply matches preview`, JSON.stringify(applied.statements) === JSON.stringify(preview.statements), JSON.stringify(applied.statements).slice(0, 160));
  const after = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check(`${key} applied`, after.columns.some((col) => col.name === 'note') && after.indexes.some((ix) => ix.name === 'idx_pv_title'), '');

  // preview alterColumn на SQLite — rebuild-план без применения (раньше был 400)
  if (key === 'sqlite') {
    const rb = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/preview`, T, { ops: [{ op: 'alterColumn', name: 'title', column: { name: 'title', type: 'VARCHAR(100)' } }] });
    check('sqlite preview rebuild op', rb.transactional === true && /_dbpanel_rebuild_/.test(JSON.stringify(rb.statements)), JSON.stringify(rb.statements).slice(0, 120));
    const still = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
    const title = still.columns.find((col) => col.name === 'title');
    check('sqlite preview rebuild dry-run', title && !/VARCHAR\(100\)/i.test(title.type), JSON.stringify(title));
  }
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// MongoDB/Redis: DDL нет — предпросмотра тоже
{
  const mongo = byName['e2e-mongo'];
  try {
    await req('POST', `/api/connections/${mongo.id}/demo/x/preview`, T, { ops: [{ op: 'addColumn', column: { name: 'a', type: 'TEXT' } }] });
    check('mongo preview rejected', false);
  } catch (e) { check('mongo preview rejected', e.status === 400, `status=${e.status}`); }
  const redis = await ensureRedis(req, T, byName);
  try {
    await req('POST', `/api/connections/${redis.id}/0/x/preview`, T, { ops: [{ op: 'addColumn', column: { name: 'a', type: 'TEXT' } }] });
    check('redis preview rejected', false);
  } catch (e) { check('redis preview rejected', e.status === 400, `status=${e.status}`); }
}

// readonly может смотреть предпросмотр (это чтение), но применить не может
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const c = byName['e2e-sqlite'];
  const preview = await req('POST', `/api/connections/${c.id}/main/${TBL}/preview`, ro.token, { ops: [{ op: 'addColumn', column: { name: 'x', type: 'TEXT' } }] });
  check('ro can preview', Array.isArray(preview.statements), JSON.stringify(preview.statements));
  const apply = await fetch(`${BASE}/api/connections/${c.id}/main/${TBL}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ro.token}` },
    body: JSON.stringify({ ops: [{ op: 'addColumn', column: { name: 'x', type: 'TEXT' } }] })
  });
  check('ro cannot apply', apply.status === 403, `status=${apply.status}`);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('PREVIEW ALL GREEN');
