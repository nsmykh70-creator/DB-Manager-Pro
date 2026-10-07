// E2E потокового экспорта: 5000 строк, проверка полноты csv/json/sql.
const BASE = 'http://localhost:3001';
let failures = 0;

async function req(method, path, token, body, raw) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 200)}`);
  }
  return raw ? r.text() : r.json();
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const N = 5000;
const rows = Array.from({ length: N }, (_, i) => ({ name: `u${i}`, age: i % 100, note: `a"b,c;${i}` }));

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;
const conns = await req('GET', '/api/connections', T);
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
async function ensureConn(input) {
  if (byName[input.name]) return byName[input.name];
  return req('POST', '/api/connections', T, input);
}

const sqlite = await ensureConn({ name: 'e2e-sqlite', kind: 'sqlite', filePath: './data/test.db' });
const mysql = byName['e2e-mysql'];
const pg = byName['e2e-pg'];
const mongo = byName['e2e-mongo'];

await req('POST', `/api/connections/${sqlite.id}/query`, T, { sql: 'DROP TABLE IF EXISTS big' });
await req('POST', `/api/connections/${sqlite.id}/query`, T, { sql: 'CREATE TABLE big(name TEXT, age INTEGER, note TEXT)' });
await req('POST', `/api/connections/${mysql.id}/query`, T, { sql: 'DROP TABLE IF EXISTS big' });
await req('POST', `/api/connections/${mysql.id}/query`, T, { sql: 'CREATE TABLE big(name VARCHAR(100), age INT, note TEXT)' });
await req('POST', `/api/connections/${pg.id}/query`, T, { sql: 'DROP TABLE IF EXISTS big' });
await req('POST', `/api/connections/${pg.id}/query`, T, { sql: 'CREATE TABLE big(name TEXT, age INT, note TEXT)' });

for (const [key, c, db, tbl] of [['sqlite', sqlite, 'main', 'big'], ['mysql', mysql, 'demo', 'big'], ['pg', pg, 'demo', 'big']]) {
  const r = await req('POST', `/api/connections/${c.id}/import`, T, { format: 'json', db, table: tbl, data: JSON.stringify(rows) });
  check(`${key} seed 5k`, r.inserted === N, JSON.stringify(r));
}
await req('POST', `/api/connections/${mongo.id}/import`, T, { format: 'json', db: 'demo', table: 'bigcol', data: JSON.stringify(rows) });
check('mongo seed 5k', true);

async function cycle(key, c, db, tbl, wantSql) {
  const t0 = Date.now();
  const csv = await req('GET', `/api/connections/${c.id}/${db}/${tbl}/export?format=csv`, T, undefined, true);
  const lines = csv.trim().split('\n');
  check(`${key} csv lines`, lines.length === N + 1, `got=${lines.length} ms=${Date.now() - t0}`);
  check(`${key} csv quote`, csv.includes('"a""b,c;0"'), 'escaped');
  const js = await req('GET', `/api/connections/${c.id}/${db}/${tbl}/export?format=json`, T, undefined, true);
  const arr = JSON.parse(js);
  check(`${key} json rows`, arr.length === N, `got=${arr.length}`);
  if (wantSql) {
    const sq = await req('GET', `/api/connections/${c.id}/${db}/${tbl}/export?format=sql`, T, undefined, true);
    const ins = sq.split('\n').filter((l) => l.startsWith('INSERT'));
    check(`${key} sql inserts`, ins.length === N, `got=${ins.length}`);
    check(`${key} sql escape`, sq.includes(`'a"b,c;0'`), 'literals intact');
  }
}

await cycle('sqlite', sqlite, 'main', 'big', true);
await cycle('mysql', mysql, 'demo', 'big', true);
await cycle('pg', pg, 'demo', 'big', true);
await cycle('mongo', mongo, 'demo', 'bigcol', false);

// round-trip: sql-дамп mysql -> импорт в sqlite.
// Дамп самодостаточный: export?format=sql начинается с CREATE TABLE IF NOT EXISTS,
// поэтому скрипт = DROP + CREATE big2 + CREATE(из дампа) + N INSERT = N + 3.
const dump = await req('GET', `/api/connections/${mysql.id}/demo/big/export?format=sql`, T, undefined, true);
const sc = await req('POST', `/api/connections/${sqlite.id}/import`, T, { format: 'sql', db: 'main', data: 'DROP TABLE IF EXISTS big2; CREATE TABLE big2(name TEXT, age INTEGER, note TEXT);' + dump.replaceAll('INSERT INTO "big"', 'INSERT INTO "big2"').replaceAll('INSERT INTO `big`', 'INSERT INTO "big2"') });
check('sql roundtrip statements', sc.statements === N + 3, JSON.stringify(sc));
const cnt = await req('POST', `/api/connections/${sqlite.id}/query`, T, { sql: 'SELECT COUNT(*) AS c FROM big2' });
check('sql roundtrip count', cnt.rows[0].c === N, JSON.stringify(cnt.rows));

// cleanup
await req('POST', `/api/connections/${sqlite.id}/query`, T, { sql: 'DROP TABLE IF EXISTS big' });
await req('POST', `/api/connections/${sqlite.id}/query`, T, { sql: 'DROP TABLE IF EXISTS big2' });
await req('POST', `/api/connections/${mysql.id}/query`, T, { sql: 'DROP TABLE big' });
await req('POST', `/api/connections/${pg.id}/query`, T, { sql: 'DROP TABLE big' });
const { MongoClient } = await import('mongodb');
const mc = new MongoClient('mongodb://127.0.0.1:27017');
await mc.connect();
await mc.db('demo').collection('bigcol').drop().catch(() => {});
await mc.close();

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('EXPORT ALL GREEN');
