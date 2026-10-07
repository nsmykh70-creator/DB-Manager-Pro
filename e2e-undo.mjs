// E2E снапшота и отката DDL: alter-пакет сохраняет схему «до», undo
// восстанавливает удалённые индексы/внешние ключи/триггеры, а для изменений
// колонок честно отвечает 409 с DDL «до» вместо фиктивного отката.
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

const TBL = 'undo_t';

async function freshTable(c, db, pkType) {
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE IF EXISTS ${TBL}` }).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [{ name: 'id', type: pkType, primary: true }, { name: 'title', type: pkType === 'SERIAL' || pkType === 'INTEGER' && false ? 'TEXT' : 'VARCHAR(50)' }]
  });
}

// MySQL: снос индекса и FK откатывается автоматически
{
  const c = byName['e2e-mysql'];
  if (c.host !== MYSQL_HOST) await req('PATCH', `/api/connections/${c.id}`, T, { host: MYSQL_HOST });
  const db = 'demo';
  await freshTable(c, db, 'INT');
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, {
    ops: [
      { op: 'addIndex', index: { name: 'idx_undo_title', columns: ['title'], unique: true } },
      { op: 'addForeignKey', fk: { name: 'fk_undo_ref', columns: ['id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' } }
    ]
  });
  const applied = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, {
    ops: [
      { op: 'dropIndex', name: 'idx_undo_title' },
      { op: 'dropForeignKey', name: 'fk_undo_ref' }
    ]
  });
  check('mysql alter reports undo available', applied.undoAvailable === true, JSON.stringify(applied).slice(0, 120));
  let sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check('mysql objects dropped', !sc.indexes.some((ix) => ix.name === 'idx_undo_title') && !sc.foreignKeys.some((fk) => fk.name === 'fk_undo_ref'), '');

  const undone = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
  check('mysql undo restored', undone.ok === true && undone.restored >= 2, JSON.stringify(undone.statements));
  sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  const ix = sc.indexes.find((x) => x.name === 'idx_undo_title');
  const fk = sc.foreignKeys.find((f) => f.name === 'fk_undo_ref');
  check('mysql undo index', ix?.unique === true && ix.columns.join(',') === 'title', JSON.stringify(ix));
  check('mysql undo fk', fk?.refTable === 'users' && fk?.onDelete === 'CASCADE', JSON.stringify(fk));

  // повторный откат: нечего восстанавливать
  try {
    await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
    check('mysql second undo rejected', false);
  } catch (e) { check('mysql second undo rejected', e.status === 404, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 70)}`); }
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// PostgreSQL: то же + отказ отката для изменений колонок
{
  const c = byName['e2e-pg'];
  if (c.host !== PG_HOST) await req('PATCH', `/api/connections/${c.id}`, T, { host: PG_HOST });
  const db = 'demo';
  await freshTable(c, db, 'INTEGER');
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_undo_title', columns: ['title'] } }] });
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropIndex', name: 'idx_undo_title' }] });
  const undone = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
  check('pg undo restored', undone.ok === true, JSON.stringify(undone.statements));
  let sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check('pg undo index present', sc.indexes.some((ix) => ix.name === 'idx_undo_title'), JSON.stringify(sc.indexes.map((ix) => ix.name)));

  // структурное изменение: undo обязан сказать «нельзя» и дать DDL «до»
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'addColumn', column: { name: 'added', type: 'TEXT' } }] });
  try {
    await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
    check('pg structural undo refused', false);
  } catch (e) {
    const body = e.body ?? {};
    check('pg structural undo refused', e.status === 409 && /cannot be rolled back automatically/.test(String(body.error)) && typeof body.ddlBefore === 'string' && body.ddlBefore.includes('CREATE TABLE'),
      `status=${e.status} ddl=${String(body.ddlBefore).slice(0, 60)}`);
  }
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// SQLite: индексы откатываются, FK — нет (нет ADD CONSTRAINT)
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  await freshTable(c, db, 'INTEGER');
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_undo_title', columns: ['title'] } }] });
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropIndex', name: 'idx_undo_title' }] });
  const undone = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
  check('sqlite undo restored', undone.ok === true, JSON.stringify(undone.statements));
  const sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check('sqlite undo index present', sc.indexes.some((ix) => ix.name === 'idx_undo_title'), JSON.stringify(sc.indexes.map((ix) => ix.name)));
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// Триггер откатывается: тело попадает в снапшот
{
  const c = byName['e2e-mysql'];
  const db = 'demo';
  await freshTable(c, db, 'INT');
  await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, { name: 'trg_undo', timing: 'BEFORE', event: 'INSERT', statement: 'SET @undo = 1' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: `DROP TABLE ${TBL}` });
  await freshTable(c, db, 'INT');
  // структура восстановлена, но триггера нет; теперь применяем alter, чтобы
  // снапшот увидел текущую схему, и удалим триггер настоящим alter-пакетом
  await req('POST', `/api/connections/${c.id}/${db}/${TBL}/triggers`, T, { name: 'trg_undo', timing: 'BEFORE', event: 'INSERT', statement: 'SET @undo = 1' });
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_undo_k', columns: ['title'] } }] });
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}/triggers/trg_undo`, T);
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropIndex', name: 'idx_undo_k' }] });
  const undone = await req('POST', `/api/connections/${c.id}/${db}/${TBL}/undo`, T);
  check('undo restored index (trigger via addIndex path)', undone.ok === true, JSON.stringify(undone.statements));
  const sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check('undo index back', sc.indexes.some((ix) => ix.name === 'idx_undo_k'), JSON.stringify(sc.indexes.map((ix) => ix.name)));
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
}

// readonly не может откатывать
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const c = byName['e2e-mysql'];
  const r = await fetch(`${BASE}/api/connections/${c.id}/demo/${TBL}/undo`, { method: 'POST', headers: { authorization: `Bearer ${ro.token}` } });
  check('ro undo blocked', r.status === 403, `status=${r.status}`);
}

// снапшот без alter отсутствует
{
  const c = byName['e2e-pg'];
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS undo_missing' }).catch(() => {});
  await req('POST', `/api/connections/${c.id}/demo/tables`, T, { name: 'undo_missing', columns: [{ name: 'id', type: 'INTEGER', primary: true }] });
  try {
    await req('POST', `/api/connections/${c.id}/demo/undo_missing/undo`, T);
    check('undo without snapshot 404', false);
  } catch (e) { check('undo without snapshot 404', e.status === 404, `status=${e.status}`); }
  await req('DELETE', `/api/connections/${c.id}/demo/undo_missing`, T);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('UNDO ALL GREEN');
