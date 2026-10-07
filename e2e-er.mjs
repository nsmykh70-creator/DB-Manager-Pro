// E2E ER-диаграммы: FK-схема, проверка relations.
const BASE = 'http://localhost:3001';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
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

async function fkCycle(key, c, db, q) {
  for (const sql of q.drop) await req('POST', `/api/connections/${c.id}/query`, T, { sql }).catch(() => {});
  for (const sql of q.create) await req('POST', `/api/connections/${c.id}/query`, T, { sql });
  const er = await req('GET', `/api/connections/${c.id}/${db}/er`, T);
  check(`${key} er tables`, er.tables.includes('authors') && er.tables.includes('books'), er.tables.join(','));
  const rel = er.relations.find((r) => r.table === 'books' && r.column === 'author_id');
  check(`${key} er fk`, !!rel && rel.refTable === 'authors' && rel.refColumn === 'id', JSON.stringify(rel ?? er.relations));
  for (const sql of q.drop) await req('POST', `/api/connections/${c.id}/query`, T, { sql }).catch(() => {});
}

await fkCycle('mysql', byName['e2e-mysql'], 'demo', {
  drop: ['DROP TABLE IF EXISTS books', 'DROP TABLE IF EXISTS authors'],
  create: [
    'CREATE TABLE authors (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100))',
    'CREATE TABLE books (id INT AUTO_INCREMENT PRIMARY KEY, author_id INT, title VARCHAR(200), FOREIGN KEY (author_id) REFERENCES authors(id))'
  ]
});

await fkCycle('pg', byName['e2e-pg'], 'demo', {
  drop: ['DROP TABLE IF EXISTS books', 'DROP TABLE IF EXISTS authors'],
  create: [
    'CREATE TABLE authors (id SERIAL PRIMARY KEY, name TEXT)',
    'CREATE TABLE books (id SERIAL PRIMARY KEY, author_id INT REFERENCES authors(id), title TEXT)'
  ]
});

if (!byName['e2e-sqlite']) throw new Error('no e2e-sqlite conn');
await fkCycle('sqlite', byName['e2e-sqlite'], 'main', {
  drop: ['DROP TABLE IF EXISTS books', 'DROP TABLE IF EXISTS authors'],
  create: [
    'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)',
    'CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT)'
  ]
});

const mer = await req('GET', `/api/connections/${byName['e2e-mongo'].id}/demo/er`, T);
check('mongo er empty relations', Array.isArray(mer.relations) && mer.relations.length === 0 && mer.tables.includes('users'), mer.tables.join(','));

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('ER ALL GREEN');
