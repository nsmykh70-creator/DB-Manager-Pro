// E2E точек восстановления (checkpoint): ручная точка, автоснимок перед
// dropColumn/drop table, восстановление данных и отказ перетирать таблицу
// без явного подтверждения.
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
async function syncHost(c, host) { if (c.host !== host) await req('PATCH', `/api/connections/${c.id}`, T, { host }); }

const TBL = 'cp_t';

async function seedRows(c, db) {
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${TBL}` }).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL, columns: [{ name: 'id', type: c.kind === 'postgres' ? 'INTEGER' : c.kind === 'sqlite' ? 'INTEGER' : 'INT', primary: true }, { name: 'note', type: c.kind === 'postgres' || c.kind === 'sqlite' ? 'TEXT' : 'VARCHAR(50)' }]
  });
  await req('POST', `/api/connections/${c.id}/import`, T, {
    format: 'json', db, table: TBL,
    data: JSON.stringify([{ id: 1, note: 'one' }, { id: 2, note: 'two' }, { id: 3, note: 'three' }])
  });
}

async function rows(c, db) {
  const r = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T);
  return r.rows;
}

// --- MySQL: ручная точка, восстановление, автоснимок перед dropColumn
{
  const c = byName['e2e-mysql'];
  await syncHost(c, MYSQL_HOST);
  const db = 'demo';
  await seedRows(c, db);
  check('seed rows', (await rows(c, db)).length === 3, '');

  const cp = await req('POST', '/api/checkpoints', T, { connId: c.id, db, table: TBL, reason: 'manual' });
  check('manual checkpoint', cp.id && cp.rows === 3 && cp.bytes > 0 && cp.format === 'sql', JSON.stringify({ rows: cp.rows, bytes: cp.bytes, format: cp.format }));

  const list = await req('GET', `/api/checkpoints?connId=${c.id}&db=${db}&table=${TBL}`, T);
  check('checkpoint listed', Array.isArray(list) && list.some((x) => x.id === cp.id), `count=${list.length}`);

  // портим данные и структуру, затем восстанавливаем
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { id: 1 }, patch: { note: 'CHANGED' } });
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { id: 2 } });
  check('data damaged', (await rows(c, db)).length === 2, '');

  const restored = await req('POST', `/api/checkpoints/${cp.id}/restore`, T, { dropExisting: true });
  check('restore ok', restored.ok !== false && restored.rows === 3, JSON.stringify(restored));
  const after = await rows(c, db);
  check('restore data', after.length === 3 && after.find((r) => r.id === 1)?.note === 'one', JSON.stringify(after).slice(0, 140));

  // восстановление без dropExisting, когда таблица есть, обязано отказать
  try {
    await req('POST', `/api/checkpoints/${cp.id}/restore`, T, {});
    check('restore refuses overwrite', false);
  } catch (e) { check('restore refuses overwrite', e.status === 409 && /pass dropExisting=1/.test(String(e.body?.error ?? e.message)), `status=${e.status}`); }

  // автоснимок перед dropColumn: данные остаются в дампе точки
  const before = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropColumn', name: 'note' }] });
  check('dropColumn returns checkpoint', Boolean(before.checkpointId), JSON.stringify(before).slice(0, 140));
  const cps = await req('GET', `/api/checkpoints?connId=${c.id}&db=${db}&table=${TBL}`, T);
  const auto = cps.find((x) => x.id === before.checkpointId);
  check('auto checkpoint recorded', auto?.reason === 'before dropColumn' && auto?.rows === 3, JSON.stringify({ reason: auto?.reason, rows: auto?.rows }));
  const restoredAuto = await req('POST', `/api/checkpoints/${before.checkpointId}/restore`, T, { dropExisting: true });
  check('restore after dropColumn', restoredAuto.rows === 3, JSON.stringify(restoredAuto));
  const back = await rows(c, db);
  check('column restored with data', back.length === 3 && back.find((r) => r.id === 1)?.note === 'one', JSON.stringify(back).slice(0, 140));

  // автоснимок перед DROP TABLE
  const dropped = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
  check('drop table returns checkpoint', Boolean(dropped.checkpointId), JSON.stringify(dropped).slice(0, 140));
  const gone = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check('table dropped', !gone.includes(TBL), gone.join(','));
  const revived = await req('POST', `/api/checkpoints/${dropped.checkpointId}/restore`, T, { dropExisting: false });
  check('recreate from checkpoint', revived.recreated === false && revived.rows === 3, JSON.stringify(revived));
  const tables = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check('table back with data', tables.includes(TBL) && (await rows(c, db)).length === 3, tables.join(','));

  // удаление точки
  await req('DELETE', `/api/checkpoints/${cp.id}`, T);
  const after2 = await req('GET', `/api/checkpoints?connId=${c.id}&db=${db}&table=${TBL}`, T);
  check('checkpoint deleted', !after2.some((x) => x.id === cp.id), `count=${after2.length}`);
  // файлы удалённых точек тоже должны исчезнуть
  await req('DELETE', `/api/checkpoints/${dropped.checkpointId}`, T);
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
}

// --- PostgreSQL
{
  const c = byName['e2e-pg'];
  await syncHost(c, PG_HOST);
  const db = 'demo';
  await seedRows(c, db);
  const cp = await req('POST', '/api/checkpoints', T, { connId: c.id, db, table: TBL, reason: 'manual' });
  check('pg checkpoint', cp.rows === 3, JSON.stringify({ rows: cp.rows, format: cp.format }));
  // Очистка через SQL: пустой фильтр API отклоняет намеренно (DELETE без WHERE — опасная операция)
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DELETE FROM ${TBL}` });
  check('pg emptied', (await rows(c, db)).length === 0, '');
  const restored = await req('POST', `/api/checkpoints/${cp.id}/restore`, T, { dropExisting: true });
  check('pg restore', restored.rows === 3, JSON.stringify(restored));
  const back = await rows(c, db);
  check('pg data back', back.length === 3 && back.find((r) => r.id === 2)?.note === 'two', JSON.stringify(back).slice(0, 140));
  await req('DELETE', `/api/checkpoints/${cp.id}`, T);
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// --- SQLite (файл целиком в своём каталоге)
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  await seedRows(c, db);
  const cp = await req('POST', '/api/checkpoints', T, { connId: c.id, db, table: TBL, reason: 'manual' });
  check('sqlite checkpoint', cp.rows === 3, JSON.stringify({ rows: cp.rows }));
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { id: 3 }, patch: { note: 'X' } });
  await req('POST', `/api/checkpoints/${cp.id}/restore`, T, { dropExisting: true });
  const back = await rows(c, db);
  check('sqlite restore data', back.length === 3 && back.find((r) => r.id === 3)?.note === 'three', JSON.stringify(back).slice(0, 140));
  await req('DELETE', `/api/checkpoints/${cp.id}`, T);
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// --- MongoDB: json-формат вместо SQL
{
  const c = byName['e2e-mongo'];
  const db = 'demo';
  const coll = 'cp_mongo';
  await req('DELETE', `/api/connections/${c.id}/${db}/${coll}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, { name: coll, columns: [{ name: 'x', type: 'TEXT' }] });
  await req('POST', `/api/connections/${c.id}/import`, T, { format: 'json', db, table: coll, data: JSON.stringify([{ a: 1 }, { a: 2 }]) });
  const cp = await req('POST', '/api/checkpoints', T, { connId: c.id, db, table: coll, reason: 'manual' });
  check('mongo checkpoint json', cp.format === 'json' && cp.rows === 2, JSON.stringify({ format: cp.format, rows: cp.rows }));
  const restored = await req('POST', `/api/checkpoints/${cp.id}/restore`, T, { dropExisting: true });
  check('mongo restore', restored.rows === 2, JSON.stringify(restored));
  const docs = await req('GET', `/api/connections/${c.id}/${db}/${coll}/rows?page=1&pageSize=50`, T);
  const docRows = docs.rows ?? [];
  check('mongo docs back', docRows.length === 2, JSON.stringify(docRows).slice(0, 160));
  // содержимое документов должно совпасть с тем, что было до точки
  check('mongo doc values intact', docRows.map((r) => r.a).sort().join(',') === '1,2', JSON.stringify(docRows.map((r) => r.a)));
  // _id обязан пережить откат, иначе ссылки из других коллекций разорвутся
  const idsBefore = docRows.map((r) => String(r._id)).sort().join(',');
  check('mongo ids readable', idsBefore.includes(','), idsBefore);
  // повреждение данных и восстановление поверх
  await req('DELETE', `/api/connections/${c.id}/${db}/${coll}/rows`, T, { filter: { a: 1 } });
  const damaged = await req('GET', `/api/connections/${c.id}/${db}/${coll}/rows?page=1&pageSize=50`, T);
  check('mongo docs damaged', (damaged.rows ?? []).length === 1, 'left=' + (damaged.rows ?? []).length);
  const restored2 = await req('POST', `/api/checkpoints/${cp.id}/restore`, T, { dropExisting: true });
  check('mongo restore after damage', restored2.rows === 2, JSON.stringify(restored2));
  const backDocs = await req('GET', `/api/connections/${c.id}/${db}/${coll}/rows?page=1&pageSize=50`, T);
  check('mongo data back', (backDocs.rows ?? []).length === 2, 'rows=' + (backDocs.rows ?? []).length);
  const idsAfter = (backDocs.rows ?? []).map((r) => String(r._id)).sort().join(',');
  check('mongo ids preserved by restore', idsAfter === idsBefore, `${idsAfter} vs ${idsBefore}`);
  await req('DELETE', `/api/checkpoints/${cp.id}`, T);
  await req('DELETE', `/api/connections/${c.id}/${db}/${coll}`, T);
}

// --- readonly и ошибки
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const c = byName['e2e-mysql'];
  const r = await fetch(`${BASE}/api/checkpoints?connId=${c.id}`, { headers: { authorization: `Bearer ${ro.token}` } });
  check('ro list blocked', r.status === 403, `status=${r.status}`);
  const r2 = await fetch(`${BASE}/api/checkpoints`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ro.token}` }, body: JSON.stringify({ connId: c.id, db: 'demo', table: 'x' }) });
  check('ro create blocked', r2.status === 403, `status=${r2.status}`);
  const r3 = await fetch(`${BASE}/api/checkpoints?connId=${c.id}&db=demo&table=${TBL}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  check('unauth blocked', r3.status === 401, `status=${r3.status}`);
  try {
    await req('POST', '/api/checkpoints', T, { db: 'demo', table: TBL });
    check('checkpoint needs connId', false);
  } catch (e) { check('checkpoint needs connId', e.status === 400, `status=${e.status}`); }
  try {
    await req('POST', '/api/checkpoints/nope/restore', T, { dropExisting: true });
    check('unknown checkpoint 404', false);
  } catch (e) { check('unknown checkpoint 404', e.status === 404, `status=${e.status}`); }
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('CHECKPOINT ALL GREEN');
