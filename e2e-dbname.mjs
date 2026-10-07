/**
 * Правила имени базы данных: по одному набору на СУБД.
 *
 * Регрессия, которую закрывает этот набор: единая проверка «[A-Za-z0-9_], до 64»
 * отвергала валидные имена (дефис в MongoDB) и пропускала 64-символьные, которые
 * MongoDB и PostgreSQL не принимают (у обоих предел 63) — пользователь получал
 * 502 «Internal server error» вместо понятного 400.
 */

const base = 'http://127.0.0.1:3002/api';
let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('PASS', name, detail ? '| ' + detail : ''); }
  else { failures.push(name); console.log('FAIL', name, '|', detail); }
}

const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }) });
const { token } = await login.json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

const connections = await (await fetch(base + '/connections', { headers: H })).json();
// Берём рабочее подключение стенда, а не любое подходящее по виду: пробные
// подключения вида audit_probe тоже имеют kind=mysql, но ведут в никуда
// (127.0.0.1:1), и тест падал с 502 вместо проверки имён.
const byKind = kind => connections.find(c => /^e2e-/.test(c.name) && c.kind === kind && !c.readOnly)
  ?? connections.find(c => c.kind === kind && !c.readOnly);

async function create(conn, name) {
  const r = await fetch(base + '/databases', { method: 'POST', headers: H, body: JSON.stringify({ connectionId: conn.id, name }) });
  return { status: r.status, body: await r.text() };
}

const suffix = Date.now().toString(36);

// 1) валидные имена с дефисом: MongoDB и PostgreSQL их принимают
for (const [kind, name] of [['mongodb', 'shop-' + suffix], ['postgres', 'shop_' + suffix]]) {
  const conn = byKind(kind);
  if (!conn) { check(kind + ' connection present', false, 'нет подключения'); continue; }
  const r = await create(conn, name);
  check(kind + ' accepts dash name', r.status === 200 || r.status === 409, r.status + ' ' + r.body.slice(0, 100));
  if (r.status === 200) await fetch(base + '/connections/' + conn.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
}

// 2) 64 символа — предел MySQL, но не MongoDB/PostgreSQL: ни 400, ни 502 от сервера
for (const [kind, len] of [['mongodb', 64], ['postgres', 64]]) {
  const conn = byKind(kind);
  if (!conn) continue;
  const r = await create(conn, 'x'.repeat(len));
  check(kind + ' rejects 64 chars with 400 not 502', r.status === 400, r.status + ' ' + r.body.replace(/<[^>]+>/g, ' ').slice(0, 90));
  check(kind + ' 64-char error is readable', !/Internal server error/.test(r.body), r.body.replace(/<[^>]+>/g, ' ').trim().slice(0, 90));
}

// 3) 63 символа допустимы у MongoDB и PostgreSQL
for (const kind of ['mongodb', 'postgres']) {
  const conn = byKind(kind);
  if (!conn) continue;
  const name = ('y' + suffix).padEnd(63, 'z').slice(0, 63);
  const r = await create(conn, name);
  check(kind + ' accepts 63 chars', r.status === 200 || r.status === 409, r.status + ' ' + r.body.slice(0, 80));
  if (r.status === 200) await fetch(base + '/connections/' + conn.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
}

// 4) 64 символа у MySQL допустимы (его настоящий предел), 65 — нет
const mysql = byKind('mysql');
if (mysql) {
  const name = ('m' + suffix).padEnd(64, 'q').slice(0, 64);
  const r = await create(mysql, name);
  check('mysql accepts 64 chars', r.status === 200 || r.status === 409, r.status + ' ' + r.body.slice(0, 80));
  if (r.status === 200) await fetch(base + '/connections/' + mysql.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
  const over = await create(mysql, name + 'q');
  check('mysql rejects 65 chars with readable 400', over.status === 400 && !/Internal server error/.test(over.body), over.status + ' ' + over.body.replace(/<[^>]+>/g, ' ').slice(0, 90));
}

// 5) недопустимые имена — 400 с внятным текстом, а не 502
const bad = [
  ['postgres', '1lead' + suffix],
  ['postgres', 'has space' + suffix],
  ['postgres', 'точка.имя'],
  ['mongodb', 'dot.name' + suffix],
  ['mongodb', 'system.config'],
  ['mongodb', 'через/слэш'],
  ['mysql', 'my-db' + suffix],
  ['mysql', 'Магазин'],
  ['mysql', 'пробел внутри']
];
for (const [kind, name] of bad) {
  const conn = byKind(kind);
  if (!conn) continue;
  const r = await create(conn, name);
  const readable = !/Internal server error/.test(r.body);
  check(kind + ' rejects ' + JSON.stringify(name) + ' with readable 400', r.status === 400 && readable, r.status + ' ' + r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 90));
}

// 6) имя обрезается: пробелы по краям не должны ломать создание
const trimmed = byKind('postgres');
if (trimmed) {
  const name = 'trim' + suffix;
  const r = await create(trimmed, '  ' + name + '  ');
  check('name is trimmed before create', r.status === 200 || r.status === 409, r.status + ' ' + r.body.slice(0, 80));
  if (r.status === 200) await fetch(base + '/connections/' + trimmed.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
}

// 7) MongoDB: база, отличающаяся только регистром, — понятный 400, а не 502
const mongo = byKind('mongodb');
if (mongo) {
  const name = 'case' + suffix;
  const first = await create(mongo, name);
  if (first.status === 200) {
    const clash = await create(mongo, name.toUpperCase());
    check('mongo case-insensitive clash is 400 not 502', clash.status === 400 && !/Internal server error/.test(clash.body), clash.status + ' ' + clash.body.replace(/<[^>]+>/g, ' ').slice(0, 100));
    await fetch(base + '/connections/' + mongo.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
  } else {
    check('mongo base db created for clash test', false, first.status + ' ' + first.body.slice(0, 80));
  }
}

// 8) чтение из БД, имя которой не проходит строгий ident() (дефис).
// Регрессия: маршруты отдавали «Bad database: my-db» (400), хотя база существует и
// драйвер оборачивает имя в обратные кавычки. Чтение обязано работать.
const dashTargets = ['mongodb', 'postgres'];
for (const kind of dashTargets) {
  const conn = byKind(kind);
  if (!conn) continue;
  const name = 'read-me-' + suffix;

  // создаём базу с дефисом: у MongoDB панель это разрешает, у PostgreSQL — только
  // напрямую через SQL (в двойных кавычках такой идентификатор допустим)
  if (kind === 'mongodb') {
    const created = await create(conn, name);
    if (created.status !== 200) { check(kind + ' dash db created', false, created.status + ' ' + created.body.slice(0, 80)); continue; }
  } else {
    const c = await fetch(base + '/connections/' + conn.id + '/query', { method: 'POST', headers: H, body: JSON.stringify({ db: 'demo', sql: 'CREATE DATABASE "' + name + '"' }) });
    if (c.status !== 200) { check(kind + ' dash db created via SQL', false, c.status + ' ' + (await c.text()).replace(/<[^>]+>/g, ' ').slice(0, 90)); continue; }
  }

  const tables = await fetch(base + '/connections/' + conn.id + '/' + encodeURIComponent(name) + '/tables', { headers: H });
  check(kind + ' lists tables in dash-named db', tables.status === 200, tables.status + ' ' + (await tables.text()).replace(/<[^>]+>/g, ' ').slice(0, 90));

  // Mongo-запрос в панели — это JSON-строка в поле sql
  const payload = kind === 'mongodb'
    ? { db: name, sql: JSON.stringify({ db: name, collection: 'probe_t', filter: {} }) }
    : { db: name, sql: 'SELECT current_database() AS db' };
  const qr = await fetch(base + '/connections/' + conn.id + '/query', { method: 'POST', headers: H, body: JSON.stringify(payload) });
  const qbody = await qr.text();
  check(kind + ' runs query in dash-named db', qr.status === 200 && !/Bad database/.test(qbody), qr.status + ' ' + qbody.replace(/<[^>]+>/g, ' ').slice(0, 90));

  const dry = await fetch(base + '/connections/' + conn.id + '/databases/' + encodeURIComponent(name) + '?dryRun=1', { method: 'DELETE', headers: H });
  check(kind + ' dry-run drop of dash-named db', dry.status === 200, dry.status + ' ' + (await dry.text()).replace(/<[^>]+>/g, ' ').slice(0, 90));

  const dropped = await fetch(base + '/connections/' + conn.id + '/databases/' + encodeURIComponent(name), { method: 'DELETE', headers: H });
  check(kind + ' drops dash-named db', dropped.status === 200, dropped.status + ' ' + (await dropped.text()).replace(/<[^>]+>/g, ' ').slice(0, 90));
}

// 9) имя с дефисом в MySQL читается, даже если панель его не создаёт:
//    такая база могла появиться на сервере помимо панели
const mysqlConn = byKind('mysql');
if (mysqlConn) {
  const name = 'outside-' + suffix;
  const r = await fetch(base + '/connections/' + mysqlConn.id + '/query', { method: 'POST', headers: H, body: JSON.stringify({ db: 'demo', sql: 'CREATE DATABASE \`' + name + '\`' }) });
  check('mysql external dash db created via SQL', r.status === 200, r.status + ' ' + (await r.text()).replace(/<[^>]+>/g, ' ').slice(0, 80));
  const tables = await fetch(base + '/connections/' + mysqlConn.id + '/' + encodeURIComponent(name) + '/tables', { headers: H });
  check('mysql lists tables in external dash db', tables.status === 200, tables.status + ' ' + (await tables.text()).replace(/<[^>]+>/g, ' ').slice(0, 90));
  await fetch(base + '/connections/' + mysqlConn.id + '/query', { method: 'POST', headers: H, body: JSON.stringify({ db: 'demo', sql: 'DROP DATABASE \`' + name + '\`' }) });
}

console.log(failures.length ? 'FAILURES: ' + failures.length : 'DBNAME ALL GREEN');
if (failures.length) process.exit(1);
