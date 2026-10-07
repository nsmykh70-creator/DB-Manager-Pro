// e2e-data-undo.mjs — откат изменений данных (insert/update/delete) на 4 СУБД
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
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
};

const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body;
const T = admin.token;
const ro = (await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' })).body;
const editor = (await req('POST', '/api/auth/login', null, { username: 'e2e_editor', password: 'editorpass123' })).body;
check('logins', !!T && !!ro.token && !!editor.token);

const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
const TBL = 'du_rows';
const log = (n, c, e) => console.log(`  [${n}] ${c}${e ? ' | ' + e : ''}`);

const rowList = async (c, db) => (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=100`, T)).body.rows ?? [];
const listUndo = async (c, db) => (await req('GET', `/api/data-undo?connId=${c.id}&db=${db}&table=${TBL}&limit=20`, T)).body;
const latest = async (c, db, op) => (await listUndo(c, db)).find((e) => e.op === op);

async function seed(c, db) {
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [
      { name: 'id', type: c.kind === 'mongodb' ? 'TEXT' : c.kind === 'sqlite' ? 'INTEGER' : 'INT', primary: true, autoInc: c.kind !== 'sqlite', nullable: false },
      { name: 'note', type: 'TEXT', nullable: true }
    ]
  });
  if (created.status >= 400) log('create table', c.name, JSON.stringify(created.body).slice(0, 120));
  let n0 = 0;
  for (const n of ['one', 'two', 'three']) {
    // у SQLite в панели нет AUTOINCREMENT, поэтому первичный ключ задаём явно
    const row = c.kind === 'sqlite' ? { id: ++n0, note: n } : { note: n };
    const r = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row });
    if (r.status >= 400) log('seed row', c.name, JSON.stringify(r.body).slice(0, 120));
  }
}

async function dropAll(c, db) {
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
}

// --- общий сценарий на каждой СУБД
for (const [name, db] of [['e2e-mysql', 'demo'], ['e2e-maria', 'demo'], ['e2e-pg', 'demo'], ['e2e-sqlite', 'main']]) {
  const c = byName[name];
  if (!c) { check(`${name} connection`, false); continue; }
  console.log(`--- ${name} (${c.kind})`);
  await seed(c, db);
  check(`${name} seeded`, (await rowList(c, db)).length === 3, 'rows=' + (await rowList(c, db)).length);

  // UPDATE → откат возвращает прежние значения
  const upd = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { note: 'two' }, patch: { note: 'CHANGED' } });
  check(`${name} update applied`, upd.status === 200, JSON.stringify(upd.body).slice(0, 80));
  const uRec = await latest(c, db, 'update');
  check(`${name} update recorded`, !!uRec && uRec.undoable, JSON.stringify(uRec));
  const uRes = await req('POST', `/api/data-undo/${uRec.id}/undo`, T);
  check(`${name} update undone`, uRes.status === 200 && uRes.body.affected >= 1, JSON.stringify(uRes.body));
  check(`${name} value restored`, (await rowList(c, db)).find((r) => r.note === 'two')?.note === 'two',
    JSON.stringify((await rowList(c, db)).map((r) => r.note)));

  // повторный откат запрещён, redo возвращает изменение
  const again = await req('POST', `/api/data-undo/${uRec.id}/undo`, T);
  check(`${name} double undo blocked`, again.status === 409, 'status=' + again.status);
  const redo = await req('POST', `/api/data-undo/${uRec.id}/redo`, T);
  check(`${name} redo applied`, redo.status === 200, JSON.stringify(redo.body));
  check(`${name} value changed again`, (await rowList(c, db)).some((r) => r.note === 'CHANGED'),
    JSON.stringify((await rowList(c, db)).map((r) => r.note)));
  await req('POST', `/api/data-undo/${uRec.id}/undo`, T); // возвращаем исходное состояние

  // INSERT → откат удаляет добавленную строку
  const ins = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row: c.kind === 'sqlite' ? { id: 99, note: 'extra' } : { note: 'extra' } });
  check(`${name} insert applied`, ins.status === 200, JSON.stringify(ins.body).slice(0, 80));
  const iRec = await latest(c, db, 'insert');
  check(`${name} insert recorded`, !!iRec && iRec.undoable && iRec.rows === 1, JSON.stringify(iRec));
  const iRes = await req('POST', `/api/data-undo/${iRec.id}/undo`, T);
  check(`${name} insert undone`, iRes.status === 200 && iRes.body.affected === 1, JSON.stringify(iRes.body));
  check(`${name} extra row gone`, !(await rowList(c, db)).some((r) => r.note === 'extra'),
    JSON.stringify((await rowList(c, db)).map((r) => r.note)));

  // DELETE → откат возвращает строки с теми же ключами
  const keysBefore = (await rowList(c, db)).map((r) => r.id).sort().join(',');
  const del = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { note: 'one' } });
  check(`${name} delete applied`, del.status === 200, JSON.stringify(del.body).slice(0, 80));
  check(`${name} row gone`, !(await rowList(c, db)).some((r) => r.note === 'one'));
  const dRec = await latest(c, db, 'delete');
  check(`${name} delete recorded`, !!dRec, JSON.stringify(dRec));
  check(`${name} delete undoable`, dRec.undoable === true, JSON.stringify(dRec));
  const dRes = await req('POST', `/api/data-undo/${dRec.id}/undo`, T);
  check(`${name} delete undone`, dRes.status === 200 && dRes.body.affected >= 1, JSON.stringify(dRes.body));
  const back = await rowList(c, db);
  check(`${name} delete restored`, back.length === 3 && back.some((r) => r.note === 'one'), JSON.stringify(back.map((r) => r.note)));
  check(`${name} keys preserved`, back.map((r) => r.id).sort().join(',') === keysBefore,
    `${back.map((r) => r.id).sort().join(',')} vs ${keysBefore}`);

  // ограничения и доступ
  // Правка, после которой строку удалили: откат обязан вернуть её с прежним
  // ключом (у serial это возможно) либо внятно объяснить, почему не смог.
  const ghost = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { note: 'three' }, patch: { note: 'GHOST' } });
  check(`${name} ghost update applied`, ghost.status === 200, JSON.stringify(ghost.body).slice(0, 80));
  const gRec = await latest(c, db, 'update');
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { note: 'GHOST' } });
  const gRes = await req('POST', `/api/data-undo/${gRec.id}/undo`, T);
  check(`${name} ghost undo restored`, gRes.status === 200, JSON.stringify(gRes.body).slice(0, 90));
  check(`${name} ghost row back`, (await rowList(c, db)).some((r) => r.note === 'three'), JSON.stringify((await rowList(c, db)).map((r) => r.note)));

  const roList = await req('GET', `/api/data-undo?connId=${c.id}`, ro.token);
  check(`${name} readonly blocked`, roList.status === 403, 'status=' + roList.status);
  const edList = await req('GET', `/api/data-undo?connId=${c.id}`, editor.token);
  check(`${name} editor can list`, edList.status === 200, 'status=' + edList.status);
  const noConn = await req('GET', '/api/data-undo', T);
  check(`${name} connId required`, noConn.status === 400, 'status=' + noConn.status);
  const unknown = await req('POST', '/api/data-undo/nope/undo', T);
  check(`${name} unknown entry 404`, unknown.status === 404, 'status=' + unknown.status);

  await dropAll(c, db);
}

// --- MongoDB: откат по _id
{
  const c = byName['e2e-mongo'];
  const db = 'demo';
  console.log('--- e2e-mongo (mongodb)');
  await dropAll(c, db);
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, { name: TBL, columns: [{ name: 'x', type: 'TEXT' }] });
  for (const a of [1, 2]) await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row: { a } });
  let docs = (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T)).body.rows ?? [];
  check('mongo seeded', docs.length === 2, 'rows=' + docs.length);
  const ids = docs.map((d) => d._id).sort().join(',');

  const upd = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { a: 1 }, patch: { a: 99 } });
  check('mongo update applied', upd.status === 200, JSON.stringify(upd.body).slice(0, 80));
  const uRec = await latest(c, db, 'update');
  const uRes = await req('POST', `/api/data-undo/${uRec.id}/undo`, T);
  check('mongo update undone', uRes.status === 200, JSON.stringify(uRes.body));
  docs = (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T)).body.rows ?? [];
  check('mongo value restored', docs.some((d) => d.a === 1) && !docs.some((d) => d.a === 99), JSON.stringify(docs.map((d) => d.a)));
  check('mongo ids kept on update undo', docs.map((d) => d._id).sort().join(',') === ids, docs.map((d) => d._id).sort().join(','));

  const del = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { a: 2 } });
  check('mongo delete applied', del.status === 200, JSON.stringify(del.body).slice(0, 80));
  const dRec = await latest(c, db, 'delete');
  check('mongo delete recorded', !!dRec && dRec.undoable, JSON.stringify(dRec));
  const dRes = await req('POST', `/api/data-undo/${dRec.id}/undo`, T);
  check('mongo delete undone', dRes.status === 200, JSON.stringify(dRes.body));
  docs = (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T)).body.rows ?? [];
  check('mongo doc restored with same _id', docs.length === 2 && docs.map((d) => d._id).sort().join(',') === ids,
    JSON.stringify(docs.map((d) => d._id)));

  const ins = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row: { a: 3 } });
  const iRec = await latest(c, db, 'insert');
  const iRes = await req('POST', `/api/data-undo/${iRec.id}/undo`, T);
  check('mongo insert undone', iRes.status === 200 && iRes.body.affected === 1, JSON.stringify(iRes.body));
  docs = (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T)).body.rows ?? [];
  check('mongo insert removed', !docs.some((d) => d.a === 3), JSON.stringify(docs.map((d) => d.a)));

  // Регрессия: _id приходит из панели строкой, а в Mongo это ObjectId.
  // Без преобразования правка и удаление по _id молча ничего не делали.
  const probe = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row: { a: 7 } });
  const probeId = probe.body.insertedId;
  const updById = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { _id: String(probeId) }, patch: { a: 8 } });
  check('mongo update by _id string works', updById.status === 200 && updById.body.matched === 1, JSON.stringify(updById.body));
  const delById = await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { filter: { _id: String(probeId) } });
  check('mongo delete by _id string works', delById.status === 200 && delById.body.deleted === 1, JSON.stringify(delById.body));
  docs = (await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=50`, T)).body.rows ?? [];
  check('mongo probe doc gone', !docs.some((d) => d.a === 8), JSON.stringify(docs.map((d) => d.a)));

  await dropAll(c, db);
}

// --- PostgreSQL IDENTITY: ключ нельзя вернуть, и это должно быть сказано прямо
{
  const c = byName['e2e-pg'];
  const db = 'demo';
  const IDENT = 'du_ident';
  console.log('--- e2e-pg GENERATED ALWAYS AS IDENTITY');
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${IDENT}`, db });
  // Регрессия транслятора T-SQL: `GENERATED ... AS IDENTITY` — стандартный SQL,
  // раньше он превращался в «GENERATED ALWAYS AS » и запрос падал с 500.
  const script = `CREATE TABLE ${IDENT} (id integer GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (id), note text);`
    + ` INSERT INTO ${IDENT} (note) VALUES ('a'), ('b');`;
  const imp = await req('POST', `/api/connections/${c.id}/import`, T, { format: 'sql', db, data: script, table: IDENT });
  check('identity table created', imp.status === 200, JSON.stringify(imp.body).slice(0, 120));
  const sch = await req('GET', `/api/connections/${c.id}/${db}/${IDENT}/schema`, T);
  const idCol = (sch.body.columns ?? []).find((x) => x.name === 'id');
  check('identity detected in schema', idCol?.autoInc === true && /ALWAYS/i.test(String(idCol?.extra)), JSON.stringify(idCol));
  const docs = (await req('GET', `/api/connections/${c.id}/${db}/${IDENT}/rows?page=1&pageSize=10`, T)).body.rows ?? [];
  check('identity rows', docs.length === 2, 'rows=' + docs.length);
  const del = await req('DELETE', `/api/connections/${c.id}/${db}/${IDENT}/rows`, T, { filter: { id: docs[0].id } });
  check('identity delete applied', del.status === 200 && del.body.deleted === 1, JSON.stringify(del.body).slice(0, 80));
  const rec = (await req('GET', `/api/data-undo?connId=${c.id}&db=${db}&table=${IDENT}&limit=20`, T)).body.find((e) => e.op === 'delete');
  check('identity delete not undoable', rec && rec.undoable === false, JSON.stringify(rec));
  check('identity reason mentions keys', rec && /identity/i.test(rec.summary), rec?.summary);
  const undo = await req('POST', `/api/data-undo/${rec.id}/undo`, T);
  check('identity undo refused with 409', undo.status === 409, 'status=' + undo.status);
  const after = (await req('GET', `/api/connections/${c.id}/${db}/${IDENT}/rows?page=1&pageSize=10`, T)).body.rows ?? [];
  check('identity data untouched by refusal', after.length === 1, 'rows=' + after.length);
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${IDENT}` });
}

// --- админские мелочи: список отсекается по подключению, удаление записи (admin)
{
  const c = byName['e2e-mysql'];
  const list = await req('GET', `/api/data-undo?connId=${c.id}&limit=100`, T);
  const all = Array.isArray(list.body) ? list.body : [];
  check('list is scoped to connection', all.every((e) => e.connId === c.id), 'n=' + all.length);
  check('list has no row payloads', !JSON.stringify(all).includes('beforeJson'), 'payload leak');
  if (all[0]) {
    const delByEditor = await req('DELETE', `/api/data-undo/${all[0].id}`, editor.token);
    check('editor cannot delete entry', delByEditor.status === 403, 'status=' + delByEditor.status);
    const delByAdmin = await req('DELETE', `/api/data-undo/${all[0].id}`, T);
    check('admin deletes entry', delByAdmin.status === 200, JSON.stringify(delByAdmin.body));
  }
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('DATA UNDO ALL GREEN');
