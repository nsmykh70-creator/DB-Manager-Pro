// E2E конструктора таблиц: create/alter/drop + injection-чеки.
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

async function cycle(key, c, db, idType, autoDef) {
  const TBL = 'dz_t';
  // cleanup на случай прошлого падения
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [
      { name: 'id', type: idType, primary: true, autoInc: true },
      { name: 'title', type: key === 'pg' ? 'VARCHAR(200)' : 'VARCHAR(200)', nullable: false },
      { name: 'cnt', type: 'INTEGER', default: '0' }
    ]
  }).catch((e) => { throw new Error(key + ' create: ' + e.message); });
  void autoDef;
  const tables = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} created`, tables.includes(TBL), tables.join(','));
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, {
    ops: [
      { op: 'addColumn', column: { name: 'extra', type: 'TEXT' } },
      { op: 'renameColumn', from: 'cnt', to: 'total' }
    ]
  });
  const schema = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  // Проверяем именно columns: в TableSchema есть поле extra (engine/collation),
  // поэтому поиск подстроки по всему JSON больше непригоден.
  const colNames = (s) => s.columns.map((col) => col.name);
  const s = JSON.stringify(schema.columns);
  check(`${key} altered`, colNames(schema).includes('extra') && colNames(schema).includes('total') && !s.includes('"cnt"'), colNames(schema).join(','));
  check(`${key} model shape`, schema.kind === 'table' && Array.isArray(schema.indexes) && Array.isArray(schema.foreignKeys) && Array.isArray(schema.triggers) && schema.columns.every((col) => typeof col.ordinal === 'number' && typeof col.nullable === 'boolean'),
    `kind=${schema.kind} cols=${schema.columns.length}`);
  await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropColumn', name: 'extra' }] });
  const afterDrop = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check(`${key} dropColumn`, !colNames(afterDrop).includes('extra'), colNames(afterDrop).join(','));
  // данные пишутся в созданную таблицу
  await req('POST', `/api/connections/${c.id}/import`, T, { format: 'json', db, table: TBL, data: JSON.stringify([{ title: 'hello', total: 5 }]) });
  const q = await req('POST', `/api/connections/${c.id}/query`, T, { sql: key === 'mongo' ? JSON.stringify({ collection: TBL, filter: {}, limit: 10 }) : `SELECT title,total FROM ${TBL}` });
  check(`${key} data`, q.rowCount === 1, JSON.stringify(q.rows));
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T);
  const t2 = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} dropped`, !t2.includes(TBL), '');
}

await cycle('sqlite', byName['e2e-sqlite'], 'main', 'INTEGER');
await cycle('mysql', byName['e2e-mysql'], 'demo', 'INT');
await cycle('maria', byName['e2e-maria'], 'demo', 'INT');
await cycle('pg', byName['e2e-pg'], 'demo', 'INTEGER');

// mongo: create + drop коллекции
{
  const c = byName['e2e-mongo'];
  await req('DELETE', `/api/connections/${c.id}/demo/dz_c`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/demo/tables`, T, { name: 'dz_c', columns: [{ name: 'x', type: 'TEXT' }] });
  const t = await req('GET', `/api/connections/${c.id}/demo/tables`, T);
  check('mongo created', t.includes('dz_c'), t.join(','));
  try {
    await req('PATCH', `/api/connections/${c.id}/demo/dz_c`, T, { ops: [{ op: 'dropColumn', name: 'x' }] });
    check('mongo alter rejected', false);
  } catch (e) { check('mongo alter rejected', e.status === 400, e.message); }
  await req('DELETE', `/api/connections/${c.id}/demo/dz_c`, T);
  check('mongo dropped', !(await req('GET', `/api/connections/${c.id}/demo/tables`, T)).includes('dz_c'), '');
}

// injection-чеки на sqlite
{
  const c = byName['e2e-sqlite'];
  for (const [nm, payload, want] of [
    ['bad name', { name: 'a`b', columns: [{ name: 'id', type: 'INTEGER' }] }, 400],
    ['bad type', { name: 't2', columns: [{ name: 'id', type: 'INTEGER); DROP TABLE users;--' }] }, 400],
    ['bad default', { name: 't3', columns: [{ name: 'id', type: 'INTEGER', default: '(SELECT 1)' }] }, 400]
  ]) {
    try {
      await req('POST', `/api/connections/${c.id}/main/tables`, T, payload);
      check(`inject ${nm}`, false);
    } catch (e) { check(`inject ${nm}`, e.status === want, e.message.slice(0, 80)); }
  }
}

// DDL-операции расширенного набора: индексы, внешние ключи, PK, alterColumn,
// переименование таблицы. MySQL/MariaDB/PG умеют всё, SQLite — часть.
for (const key of ['mysql', 'maria', 'pg']) {
  const c = byName[`e2e-${key}`];
  const db = 'demo';
  const TBL = 'dz_ops';
  // Таблицу, на которую ссылается внешний ключ, создаём сами: раньше тут стоял
  // `users` из сида, и после любого прогона, который его трогал, тест падал с
  // «Failed to open the referenced table 'users'» — не из-за своей проверки.
  const REF = 'dz_ref';
  const ref = REF;
  const q = (n) => (key === 'pg' ? `"${n}"` : `\`${n}\``);
  await req('DELETE', `/api/connections/${c.id}/${db}/${REF}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: REF,
    columns: [{ name: 'id', type: key === 'pg' ? 'INTEGER' : 'INT', primary: true }]
  });
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL,
    columns: [
      { name: 'id', type: key === 'pg' ? 'INTEGER' : 'INT', primary: true },
      { name: 'title', type: key === 'pg' ? 'TEXT' : 'VARCHAR(100)', nullable: false },
      { name: 'note', type: key === 'pg' ? 'TEXT' : 'VARCHAR(100)' }
    ]
  });

  // addIndex / dropIndex
  const addIdx = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_ops_title', columns: ['title'], unique: true } }] });
  check(`${key} addIndex`, addIdx.ok === true && addIdx.applied === 1 && /CREATE UNIQUE INDEX/.test(addIdx.statements[0]), JSON.stringify(addIdx.statements));
  let sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check(`${key} index visible`, sc.indexes.some((ix) => ix.name === 'idx_ops_title' && ix.unique === true && ix.columns.join(',') === 'title'), JSON.stringify(sc.indexes.map((ix) => ix.name)));

  // addForeignKey / dropForeignKey
  const fkName = 'fk_ops_ref';
  const addFk = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, {
    ops: [{ op: 'addForeignKey', fk: { name: fkName, columns: ['id'], refTable: ref, refColumns: ['id'], onDelete: 'CASCADE' } }]
  });
  check(`${key} addForeignKey`, /ADD CONSTRAINT/.test(addFk.statements[0]) && /ON DELETE CASCADE/.test(addFk.statements[0]), JSON.stringify(addFk.statements));
  sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  check(`${key} fk visible`, sc.foreignKeys.some((fk) => fk.name === fkName && fk.refTable === ref && fk.onDelete === 'CASCADE'), JSON.stringify(sc.foreignKeys));

  // alterColumn: тип + nullable + default
  const alt = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, {
    ops: [{ op: 'alterColumn', name: 'note', column: { name: 'note', type: key === 'pg' ? 'VARCHAR(200)' : 'VARCHAR(200)', nullable: false, default: '0' } }]
  });
  check(`${key} alterColumn`, alt.applied >= 1, JSON.stringify(alt.statements));
  sc = await req('GET', `/api/connections/${c.id}/${db}/${TBL}/schema`, T);
  const note = sc.columns.find((col) => col.name === 'note');
  const wantType = key === 'pg' ? 'character varying(200)' : 'varchar(200)';
  check(`${key} alterColumn applied`, note?.nullable === false && note?.type === wantType, JSON.stringify(note));

  // renameColumn уже покрыт выше, renameTable — отдельно
  const ren = await req('PATCH', `/api/connections/${c.id}/${db}/${TBL}`, T, { ops: [{ op: 'renameTable', to: 'dz_ops2' }] });
  check(`${key} renameTable`, /RENAME TO/.test(ren.statements[0]), JSON.stringify(ren.statements));
  const tablesAfter = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} renamed`, tablesAfter.includes('dz_ops2') && !tablesAfter.includes(TBL), tablesAfter.join(','));

  // транзакционность пакета: падающая операция откатывает весь пакет
  try {
    await req('PATCH', `/api/connections/${c.id}/${db}/dz_ops2`, T, {
      ops: [{ op: 'addColumn', column: { name: 'ok_col', type: key === 'pg' ? 'INTEGER' : 'INT' } }, { op: 'addIndex', index: { name: 'idx_dup', columns: ['ok_col'] } }, { op: 'addIndex', index: { name: 'idx_dup', columns: ['title'] } }]
    });
    check(`${key} atomic alter rejected`, false);
  } catch (e) {
    const rolledBack = key === 'mysql' || key === 'maria' ? e.status === 409 || !e.body?.partial : true;
    check(`${key} atomic alter rejected`, rolledBack, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 90)}`);
  }
  if (key === 'pg') {
    const sc2 = await req('GET', `/api/connections/${c.id}/${db}/dz_ops2/schema`, T);
    check('pg alter rolled back', !sc2.columns.some((col) => col.name === 'ok_col'), sc2.columns.map((col) => col.name).join(','));
  }

  // очистка: сначала FK, потом индекс, потом таблица
  const dropFk = await req('PATCH', `/api/connections/${c.id}/${db}/dz_ops2`, T, { ops: [{ op: 'dropForeignKey', name: fkName }] });
  check(`${key} dropForeignKey`, /DROP (FOREIGN KEY|CONSTRAINT)/.test(dropFk.statements[0]), JSON.stringify(dropFk.statements));
  const dropIdx = await req('PATCH', `/api/connections/${c.id}/${db}/dz_ops2`, T, { ops: [{ op: 'dropIndex', name: 'idx_ops_title' }] });
  check(`${key} dropIndex`, /DROP INDEX/.test(dropIdx.statements[0]), JSON.stringify(dropIdx.statements));
  await req('DELETE', `/api/connections/${c.id}/${db}/dz_ops2`, T);
  const leftover = await req('GET', `/api/connections/${c.id}/${db}/tables`, T);
  check(`${key} ops cleaned`, !leftover.includes('dz_ops2'), leftover.join(','));
  await req('DELETE', `/api/connections/${c.id}/${db}/${REF}`, T);
}

// SQLite: часть операций поддерживается, неподдерживаемые дают понятный 400
{
  const c = byName['e2e-sqlite'];
  const TBL = 'dz_ops';
  await req('DELETE', `/api/connections/${c.id}/main/${TBL}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/main/tables`, T, {
    name: TBL,
    columns: [{ name: 'id', type: 'INTEGER', primary: true }, { name: 'title', type: 'VARCHAR(50)' }]
  });
  const addIdx = await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_ops_title', columns: ['title'] } }] });
  check('sqlite addIndex', addIdx.transactional === true && addIdx.applied === 1, JSON.stringify(addIdx.statements));
  const sc = await req('GET', `/api/connections/${c.id}/main/${TBL}/schema`, T);
  check('sqlite index visible', sc.indexes.some((ix) => ix.name === 'idx_ops_title'), JSON.stringify(sc.indexes.map((ix) => ix.name)));
  const dropIdx = await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'dropIndex', name: 'idx_ops_title' }] });
  check('sqlite dropIndex', /DROP INDEX/.test(dropIdx.statements[0]), JSON.stringify(dropIdx.statements));
  for (const [nm, ops, want] of [
    ['alterColumn rebuild', [{ op: 'alterColumn', name: 'title', column: { name: 'title', type: 'VARCHAR(100)' } }], /_dbpanel_rebuild_/],
  ]) {
    try {
      const r = await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops });
      check(`sqlite ${nm}`, r.applied >= 1 && want.test(JSON.stringify(r.statements)), JSON.stringify(r.statements).slice(0, 120));
    } catch (e) { check(`sqlite ${nm}`, false, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 80)}`); }
  }
  {
    // alterColumn через пересборку: тип применён, данные на месте
    const sc2 = await req('GET', `/api/connections/${c.id}/main/${TBL}/schema`, T);
    check('sqlite alterColumn applied', sc2.columns.some((col) => col.name === 'title' && /VARCHAR\(100\)/i.test(col.type)), JSON.stringify(sc2.columns.map((col) => `${col.name}:${col.type}`)));
  }
  {
    // addForeignKey через пересборку: нужна реальная ref-таблица.
    // addColumn и addForeignKey идут одним пакетом: rebuild строит новую
    // таблицу сразу с колонкой и ключом (меньше запросов — suite живёт
    // в лимите 200 req/min вместе с остальными наборами e2e:all).
    await req('DELETE', `/api/connections/${c.id}/main/dz_ref`, T).catch(() => {});
    await req('POST', `/api/connections/${c.id}/main/tables`, T, {
      name: 'dz_ref', columns: [{ name: 'id', type: 'INTEGER', primary: true }]
    });
    const addFk = await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [
      { op: 'addColumn', column: { name: 'ref_id', type: 'INTEGER' } },
      { op: 'addForeignKey', fk: { columns: ['ref_id'], refTable: 'dz_ref', refColumns: ['id'], onDelete: 'CASCADE' } },
    ] });
    check('sqlite addForeignKey rebuild', addFk.applied >= 2, JSON.stringify(addFk.statements).slice(0, 120));
    const sc3 = await req('GET', `/api/connections/${c.id}/main/${TBL}/schema`, T);
    check('sqlite fk visible', sc3.foreignKeys.some((fk) => fk.refTable === 'dz_ref'), JSON.stringify(sc3.foreignKeys));
    const fkName = sc3.foreignKeys.find((fk) => fk.refTable === 'dz_ref')?.name ?? 'fk_x';
    await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'dropForeignKey', name: fkName }] });
    // setPrimaryKey через пересборку — тем же финальным GET проверяем и уход
    // FK: один запрос вместо двух.
    const setPk = await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'setPrimaryKey', columns: ['title'] }] });
    check('sqlite setPrimaryKey rebuild', setPk.applied >= 1, JSON.stringify(setPk.statements).slice(0, 120));
    const sc5 = await req('GET', `/api/connections/${c.id}/main/${TBL}/schema`, T);
    check('sqlite fk gone', !sc5.foreignKeys.some((fk) => fk.refTable === 'dz_ref'), JSON.stringify(sc5.foreignKeys));
    check('sqlite pk moved', sc5.columns.some((col) => col.name === 'title' && col.primary), JSON.stringify(sc5.columns.map((col) => `${col.name}:${col.primary ? 'PK' : ''}`)));
    await req('DELETE', `/api/connections/${c.id}/main/dz_ref`, T).catch(() => {});
  }
  // откат пакета: addColumn успешный, dropIndex несуществующего — ошибка, всё откатилось
  await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'addIndex', index: { name: 'idx_tmp', columns: ['title'] } }] });
  try {
    await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops: [{ op: 'addColumn', column: { name: 'rolled_back', type: 'TEXT' } }, { op: 'dropIndex', name: 'idx_missing' }] });
    check('sqlite atomic alter rejected', false);
  } catch (e) { check('sqlite atomic alter rejected', e.status >= 400, `status=${e.status}`); }
  const after = await req('GET', `/api/connections/${c.id}/main/${TBL}/schema`, T);
  check('sqlite alter rolled back', !after.columns.some((col) => col.name === 'rolled_back'), after.columns.map((col) => col.name).join(','));
  await req('DELETE', `/api/connections/${c.id}/main/${TBL}`, T);
}

// безопасность: чужой ввод в именах индексов/констрейнтов
{
  const c = byName['e2e-sqlite'];
  const TBL = 'dz_inject';
  await req('DELETE', `/api/connections/${c.id}/main/${TBL}`, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/main/tables`, T, { name: TBL, columns: [{ name: 'id', type: 'INTEGER' }] });
  for (const [nm, ops] of [
    ['index name', [{ op: 'addIndex', index: { name: 'i`, x`', columns: ['id'] } }]],
    ['index column', [{ op: 'addIndex', index: { name: 'i_ok', columns: ['id`, x'] } }]],
    ['fk ref table', [{ op: 'addForeignKey', fk: { name: 'fk_ok', columns: ['id'], refTable: 'a`, b', refColumns: ['id'] } }]],
    ['fk action', [{ op: 'addForeignKey', fk: { name: 'fk_ok', columns: ['id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE; DROP TABLE users' } }]]
  ]) {
    try {
      await req('PATCH', `/api/connections/${c.id}/main/${TBL}`, T, { ops });
      check(`inject ${nm}`, false);
    } catch (e) { check(`inject ${nm}`, e.status === 400, `status=${e.status} ${String(e.body?.error ?? e.message).slice(0, 70)}`); }
  }
  await req('DELETE', `/api/connections/${c.id}/main/${TBL}`, T);
}

// readonly заблокирован
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const RH = `Bearer ${ro.token}`;
  const r = await fetch(BASE + `/api/connections/${byName['e2e-sqlite'].id}/main/tables`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: RH },
    body: JSON.stringify({ name: 'ro_t', columns: [{ name: 'id', type: 'INTEGER' }] })
  });
  check('ro create blocked', r.status === 403, `status=${r.status}`);
}

// Планы визуального конструктора колонок: серверная сторона контракта.
//
// Планировщик (frontend/src/core/columnPlan.ts) проверяется скриптом
// check-column-plan.mts — там чистая функция без БД. Здесь проверяется то, что
// он генерирует, действительно применяется: раньше переименование первичного
// ключа попутно роняло и саму колонку, и такое расхождение не ловилось.
{
  const c = byName['e2e-sqlite'];
  const TBL = 'dz_plan_t';
  const url = `/api/connections/${c.id}/main/${TBL}`;
  await req('DELETE', url, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/main/tables`, T, {
    name: TBL,
    columns: [
      { name: 'id', type: 'INTEGER', primary: true, autoInc: true },
      { name: 'name', type: 'VARCHAR(64)', nullable: false },
      { name: 'note', type: 'TEXT' }
    ]
  });
  for (const n of [1, 2]) {
    await req('POST', `${url}/rows`, T, { row: { name: `n${n}`, note: 'x' } });
  }
  const cols = async () => {
    const schema = await req('GET', `${url}/schema`, T);
    return (schema.columns ?? []).map(c => c.name);
  };
  const values = async column => {
    const page = await req('GET', `${url}/rows?pageSize=50`, T);
    return (page.rows ?? []).map(r => r[column]).sort().join(',');
  };

  // 1) переименование уникальной колонки: rename, без drop
  {
    const ops = [{ op: 'renameColumn', from: 'name', to: 'title' }];
    const preview = await req('POST', `${url}/preview`, T, { ops });
    check('план: переименование видно в предпросмотре', (preview.statements ?? []).some(s => /title/i.test(s)), JSON.stringify(preview.statements).slice(0, 100));
    await req('PATCH', url, T, { ops });
    check('план: колонка переименована', (await cols()).includes('title'), (await cols()).join(','));
    check('план: исходного имени больше нет', !(await cols()).includes('name'));
    check('план: данные сохранились', await values('title') === 'n1,n2', await values('title'));
    check('план: переименование не удалило колонку', (await cols()).length === 3, (await cols()).join(','));
  }

  // 2) удаление колонки + добавление новой: drop после add
  {
    const ops = [
      { op: 'addColumn', column: { name: 'extra', type: 'VARCHAR(32)', nullable: true, default: null } },
      { op: 'dropColumn', name: 'note' }
    ];
    await req('PATCH', url, T, { ops });
    const now = await cols();
    check('план: колонка добавлена', now.includes('extra'), now.join(','));
    check('план: колонка удалена', !now.includes('note'), now.join(','));
  }

  // 3) смена первичного ключа — на MySQL: SQLite не умеет ALTER COLUMN
  //    (сервер честно отвечает 400 «recreate the table instead»), а конструктор
  //    про это предупреждает заранее.
  await req('DELETE', url, T).catch(() => {});

  const m = byName['e2e-mysql'];
  const MURL = `/api/connections/${m.id}/demo/${TBL}`;
  await req('DELETE', MURL, T).catch(() => {});
  await req('POST', `/api/connections/${m.id}/demo/tables`, T, {
    name: TBL,
    columns: [
      // без AUTO_INCREMENT: в MySQL перенести ключ с auto_increment-колонки нельзя
      // («there can be only one auto column and it must be defined as a key»),
      // и это ограничение СУБД, а не панели
      { name: 'id', type: 'INT', primary: true },
      { name: 'code', type: 'VARCHAR(32)', nullable: false }
    ]
  });
  {
    const ops = [{ op: 'setPrimaryKey', columns: ['code'] }];
    const preview = await req('POST', `${MURL}/preview`, T, { ops });
    check('план: смена PK в предпросмотре', (preview.statements ?? []).length > 0, JSON.stringify(preview.statements).slice(0, 110));
    // Ключ снимается сам: раньше такая операция падала с 500 «Multiple primary key defined»
    check('план: перед сменой ключа его снимают', (preview.statements ?? []).some(s => /DROP PRIMARY KEY/i.test(s)), JSON.stringify(preview.statements).slice(0, 110));
    await req('PATCH', MURL, T, { ops });
    const schema = await req('GET', `${MURL}/schema`, T);
    const pk = (schema.columns ?? []).filter(c => c.primary).map(c => c.name);
    check('план: первичный ключ перенесён', pk.length === 1 && pk[0] === 'code', pk.join(','));
  }
  await req('DELETE', MURL, T).catch(() => {});
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('DESIGN ALL GREEN');
