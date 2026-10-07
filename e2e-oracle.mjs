// E2E Oracle.
//
// Стенд вынесен в отдельный compose-профиль (`docker compose --profile oracle
// up -d --wait oracle`): образ Oracle весит ~2 ГБ и ест ~2 ГБ RAM, поэтому в
// обычном `dbs:up` его нет. Набор сам пропускает себя, если стенд не поднят —
// иначе `npm run e2e:full` падал бы на машинах без Oracle.
//
// Что проверяем по профилю MVP: подключение, одну «базу» (= схему = пользователь),
// конструктор (CREATE/ALTER/DROP), чтение данных, массовые операции и план запроса.
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

// Хост для подключения, которое панель создаёт через API: backend работает
// внутри compose, поэтому там имя сервиса. Проба доступности идёт с машины
// разработчика, где этого имени нет — для неё отдельный адрес.
const ORACLE_HOST = process.env.E2E_ORACLE_HOST || 'oracle';
const ORACLE_PROBE_HOST = process.env.E2E_ORACLE_PROBE_HOST || '127.0.0.1';
const ORACLE_PORT = Number(process.env.E2E_ORACLE_PORT || 1521);
const ORACLE_SERVICE = process.env.E2E_ORACLE_SERVICE || 'FREEPDB1';
const ORACLE_USER = process.env.E2E_ORACLE_USER || 'demo';
const ORACLE_PASSWORD = process.env.E2E_ORACLE_PASSWORD || 'demo';

// ── Стенд недоступен? Тогда набор не проверяет ничего и выходит успешно ──
// Пробуем подключиться напрямую из теста: это не зависит от того, поднят ли
// backend, и сразу отсеивает «профиль не включён».
async function oracleReachable() {
  try {
    const oracledb = (await import('oracledb')).default;
    const pool = await oracledb.createPool({
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: `${ORACLE_PROBE_HOST}:${ORACLE_PORT}/${ORACLE_SERVICE}`,
      poolMin: 0,
      poolMax: 1,
      connectTimeout: 5000
    });
    const conn = await pool.getConnection();
    conn.close().catch(() => undefined);
    await pool.close(0);
    return true;
  } catch (e) {
    console.log(`SKIP стенд Oracle недоступен (${ORACLE_PROBE_HOST}:${ORACLE_PORT}/${ORACLE_SERVICE}): ${String(e?.message ?? e).slice(0, 140)}`);
    console.log('Поднять стенд: docker compose --profile oracle up -d --wait oracle');
    return false;
  }
}

if (!(await oracleReachable())) {
  console.log('ORACLE SKIPPED (стенд не запущен)');
  process.exit(0);
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;

const conns = await req('GET', '/api/connections', T);
let conn = conns.find((c) => c.name === 'e2e-oracle');
if (!conn) {
  conn = await req('POST', '/api/connections', T, {
    name: 'e2e-oracle', kind: 'oracle', host: ORACLE_HOST, port: ORACLE_PORT,
    database: ORACLE_SERVICE, user: ORACLE_USER, password: ORACLE_PASSWORD
  });
} else if (conn.host !== ORACLE_HOST || conn.port !== ORACLE_PORT) {
  conn = await req('PATCH', `/api/connections/${conn.id}`, T, { host: ORACLE_HOST, port: ORACLE_PORT });
}
check('oracle conn', !!conn.id, conn.id);

const test = await req('POST', `/api/connections/${conn.id}/test`, T);
check('oracle test', test.ok === true, `${test.latencyMs}ms`);

// «База» = схема = пользователь подключения, поэтому в списке ровно одна
// запись — и это имя нашего пользователя в верхнем регистре.
const dbs = await req('GET', `/api/connections/${conn.id}/databases`, T);
check('oracle dbs = одна схема', dbs.length === 1 && dbs[0] === ORACLE_USER.toUpperCase(), dbs.join(','));
const db = dbs[0];
if (!db) { console.log('FAILURES: ' + failures); process.exit(1); }

const status = await req('GET', `/api/connections/${conn.id}/status`, T);
check('oracle status', typeof status.version === 'string' && status.version.length > 0, status.version);

// ── Конструктор: создать, изменить, прочитать, удалить ──
const TBL = 'dz_oracle';
await req('DELETE', `/api/connections/${conn.id}/${db}/${TBL}`, T).catch(() => {});
await req('POST', `/api/connections/${conn.id}/${db}/tables`, T, {
  name: TBL,
  columns: [
    // NUMBER с autoInc — проверка Oracle-ветки IDENTITY в columnSql
    { name: 'id', type: 'NUMBER', primary: true, autoInc: true },
    { name: 'title', type: 'VARCHAR2(200)', nullable: false },
    { name: 'total', type: 'INTEGER', default: '0' }
  ]
});
const tables = await req('GET', `/api/connections/${conn.id}/${db}/tables`, T);
check('oracle created', tables.includes(TBL), tables.join(','));

const schema = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/schema`, T);
// Oracle хранит созданные нами имена в нижнем регистре (мы создавали таблицу
// в кавычках), поэтому сверяем регистронезависимо — как и делает сама панель,
// которая всегда обращается к именам в двойных кавычках.
const colNames = schema.columns.map((c) => c.name);
check('oracle schema columns', colNames.join(',').toLowerCase() === 'id,title,total', colNames.join(','));
check('oracle identity detected', schema.columns[0].autoInc === true, JSON.stringify(schema.columns[0]));
check('oracle model shape',
  schema.kind === 'table' && Array.isArray(schema.indexes) && Array.isArray(schema.foreignKeys) && Array.isArray(schema.triggers)
  && schema.columns.every((c) => typeof c.ordinal === 'number' && typeof c.nullable === 'boolean'),
  `kind=${schema.kind} cols=${schema.columns.length}`);

// ALTER-пакет: добавить колонку и переименовать
await req('PATCH', `/api/connections/${conn.id}/${db}/${TBL}`, T, {
  ops: [
    { op: 'addColumn', column: { name: 'note', type: 'VARCHAR2(100)' } },
    { op: 'renameColumn', from: 'total', to: 'amount' }
  ]
});
const afterAlter = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/schema`, T);
const afterCols = afterAlter.columns.map((c) => c.name.toLowerCase());
check('oracle altered', afterCols.includes('note') && afterCols.includes('amount') && !afterCols.includes('total'), afterCols.join(','));

// Индекс: у Oracle тип не указывается, пустое поле — валидный случай.
// Колонку берём из схемы: имя приходит ровно в том регистре, в каком создано.
await req('PATCH', `/api/connections/${conn.id}/${db}/${TBL}`, T, {
  ops: [{ op: 'addIndex', index: { name: 'idx_oracle_title', columns: ['title'], unique: true } }]
});
const withIndex = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/schema`, T);
check('oracle index', withIndex.indexes.some((ix) => ix.name.toLowerCase() === 'idx_oracle_title' && ix.unique === true),
  withIndex.indexes.map((ix) => ix.name).join(','));

// ── Данные: импорт, чтение страницы, фильтр, массовая правка ──
await req('POST', `/api/connections/${conn.id}/import`, T, {
  format: 'json', db, table: TBL,
  data: JSON.stringify([{ title: 'Ann', amount: 30 }, { title: 'Bob', amount: 25 }])
});
const page = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/rows?page=1&pageSize=10`, T);
check('oracle rows', page.rows.length === 2, JSON.stringify(page.rows));

const filtered = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/rows?page=1&pageSize=10&filter=${encodeURIComponent('title=Ann')}`, T);
check('oracle filter', filtered.rows.length === 1 && String(filtered.rows[0].title) === 'Ann', JSON.stringify(filtered.rows));

// INSERT с автоинкрементом: номер обязан выдать сервер
const inserted = await req('POST', `/api/connections/${conn.id}/${db}/${TBL}/rows`, T, { row: { title: 'Cid', amount: 1 } });
check('oracle insert', inserted.ok !== false, JSON.stringify(inserted));
// Свободный SQL пользователя пишется вручную, поэтому имя таблицы здесь в
// кавычках: Oracle складывает некавыченный идентификатор в ВЕРХНИЙ РЕГИСТР, а
// панель создала таблицу в двойных кавычках (то есть с маленькими буквами).
const auto = await req('POST', `/api/connections/${conn.id}/query`, T, { sql: `SELECT "id" FROM "${TBL}" WHERE "title" = 'Cid'` });
check('oracle identity assigned', auto.rows.length === 1 && Number(auto.rows[0].ID ?? auto.rows[0].id) > 0, JSON.stringify(auto.rows));

// Массовая правка: панель требует сначала предпросмотра, затем подтверждения —
// так же, как для остальных СУБД, поэтому проверяем весь цикл.
const bulkUrl = `/api/connections/${conn.id}/${db}/${TBL}/rows/bulk`;
const bulkDry = await req('POST', bulkUrl, T, { where: 'title=Bob', patch: { amount: 99 } });
check('oracle bulk dry-run', bulkDry.dryRun === true && bulkDry.matched === 1 && bulkDry.requiresConfirm === true,
  JSON.stringify(bulkDry).slice(0, 160));
const bulk = await req('POST', bulkUrl, T, { where: 'title=Bob', patch: { amount: 99 }, dryRun: false, confirm: true });
check('oracle bulk update', bulk.affected === 1 && bulk.mode === 'set', JSON.stringify(bulk).slice(0, 160));
const afterBulk = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/rows?page=1&pageSize=10&filter=${encodeURIComponent('title=Bob')}`, T);
check('oracle bulk applied', Number(afterBulk.rows[0]?.amount) === 99, JSON.stringify(afterBulk.rows));

// SELECT без LIMIT: панель обязана ограничивать выдачу сама (FETCH NEXT)
const all = await req('POST', `/api/connections/${conn.id}/query`, T, { sql: `SELECT "id", "title" FROM "${TBL}"` });
check('oracle query capped', all.rowCount <= 1000 && all.columns.join(',').toLowerCase().includes('title'), JSON.stringify(all.columns));

// LIMIT в Oracle не существует — должен быть понятный отказ, а не молчание
try {
  await req('POST', `/api/connections/${conn.id}/query`, T, { sql: `SELECT "id" FROM "${TBL}" LIMIT 1` });
  check('oracle LIMIT rejected', false);
} catch (e) { check('oracle LIMIT rejected', e.status === 500 || e.status === 400, e.message.slice(0, 120)); }

// План запроса: у Oracle нужен PLAN_TABLE, драйвер создаёт её сам
const explained = await req('POST', `/api/connections/${conn.id}/explain`, T, { db, sql: `SELECT * FROM "${TBL}"` });
const plan = explained.plan ?? explained;
check('oracle explain', plan.rowCount > 0 && plan.columns.includes('plan'), JSON.stringify(plan.rows.slice(0, 2)));
// Служебная PLAN_TABLE, которую создаёт драйвер, — не пользовательские данные
const afterExplain = await req('GET', `/api/connections/${conn.id}/${db}/tables`, T);
check('oracle plan table hidden', !afterExplain.some((x) => x.toUpperCase() === 'PLAN_TABLE'), afterExplain.join(','));

// Удаление колонки и таблицы
await req('PATCH', `/api/connections/${conn.id}/${db}/${TBL}`, T, { ops: [{ op: 'dropColumn', name: 'note' }] });
const afterDrop = await req('GET', `/api/connections/${conn.id}/${db}/${TBL}/schema`, T);
check('oracle dropColumn', !afterDrop.columns.map((c) => c.name.toLowerCase()).includes('note'), afterDrop.columns.map((c) => c.name).join(','));

await req('DELETE', `/api/connections/${conn.id}/${db}/${TBL}`, T);
check('oracle dropped', !(await req('GET', `/api/connections/${conn.id}/${db}/tables`, T)).includes(TBL), '');

// ── Перенос модели с другой СУБД ───────────────────────────────────────────
// Пользовательский сценарий: модель снята с MySQL (типы VARCHAR/TEXT/INT) и
// применяется к Oracle. Без перевода типов он падал с «Bad column type for
// oracle: VARCHAR(100)», и FK к не созданной таблице давал ORA-00942.
const XN = 'mdl_xparent', XC = 'mdl_xchild';
{
  await req('DELETE', `/api/connections/${conn.id}/${db}/${XN}`, T).catch(() => {});
  await req('DELETE', `/api/connections/${conn.id}/${db}/${XC}`, T).catch(() => {});
  // Модель с прошлого прогона могла остаться, если он оборвался на середине:
  // повторное создание вернуло бы 409 и набор падал бы не из-за своих ошибок.
  const staleModels = await req('GET', '/api/models?limit=100', T);
  for (const m of staleModels.filter((x) => x.name === 'e2e_oracle_xengine')) {
    await req('DELETE', `/api/models/${m.id}`, T).catch(() => {});
  }
  const model = await req('POST', '/api/models', T, {
    name: 'e2e_oracle_xengine', dbKind: 'mysql',
    tables: [
      { name: XN, columns: [
        { name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false },
        { name: 'title', type: 'VARCHAR(100)', nullable: false },
        { name: 'price', type: 'DECIMAL(10,2)' }
      ], indexes: [{ name: 'idx_x_title', columns: ['title'] }] },
      { name: XC, columns: [
        { name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false },
        { name: 'parent_id', type: 'INT', nullable: false },
        { name: 'note', type: 'TEXT' }
      ], indexes: [],
        foreignKeys: [{ name: 'fk_x_child', columns: ['parent_id'], refTable: XN, refColumns: ['id'], onDelete: 'CASCADE' }] }
    ]
  });
  const appliedModel = await req('POST', `/api/models/${model.id}/apply`, T, { connId: conn.id, db });
  check('модель с MySQL-типами перенесена в Oracle',
    appliedModel.ok === true && (appliedModel.errors ?? []).length === 0,
    JSON.stringify(appliedModel.errors ?? []).slice(0, 200));
  const parentStmt = (appliedModel.statements ?? []).find(x => x.includes(XN.toUpperCase()) || x.includes(XN));
  check('VARCHAR(100) стал VARCHAR2(100)', /VARCHAR2\(100\)/.test(parentStmt ?? ''), parentStmt ?? '');
  check('TEXT стал CLOB', /\bCLOB\b/.test((appliedModel.statements ?? []).find(x => x.includes(XC)) ?? ''),
    (appliedModel.statements ?? []).find(x => x.includes(XC)) ?? '');
  check('DECIMAL(10,2) сохранил точность', /NUMBER\(10,\s*2\)/.test(parentStmt ?? ''), parentStmt ?? '');

  const xschema = await req('GET', `/api/connections/${conn.id}/${db}/${XC}/schema`, T);
  check('FK из модели применён', xschema.foreignKeys.length === 1 && xschema.foreignKeys[0].refTable === XN,
    JSON.stringify(xschema.foreignKeys));
  // Точная колонка переживает вставку: если бы точность потерялась, это вылезло
  // бы здесь, а не при создании таблицы.
  await req('POST', `/api/connections/${conn.id}/${db}/${XN}/rows`, T, { row: { title: 'p', price: 12.34 } });
  // Имена в кавычках: модель создала таблицу с кавычками (значит, строчными),
  // а некавыченное имя Oracle сложил бы в верхний регистр — ORA-00904.
  const price = await req('POST', `/api/connections/${conn.id}/query`, T, { sql: `SELECT "price" FROM "${XN}"` });
  // Ключи результата сервер возвращает строчными (у таблицы из модели имена
  // в кавычках), поэтому читаем без предположения о регистре.
  const priceRow = price.rows?.[0] ?? {};
  check('NUMBER(10,2) принимает дробное значение', Number(priceRow.price ?? priceRow.PRICE) === 12.34, JSON.stringify(price.rows));

  await req('DELETE', `/api/connections/${conn.id}/${db}/${XC}`, T);
  await req('DELETE', `/api/connections/${conn.id}/${db}/${XN}`, T);
  await req('DELETE', `/api/models/${model.id}`, T);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('ORACLE ALL GREEN');