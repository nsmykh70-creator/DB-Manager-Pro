// e2e-bulk.mjs — массовые операции по фильтру и предпросмотр (dry-run) разрушительных действий
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
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: r.status, body: parsed };
};

const T = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body.token;
const ro = (await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' })).body.token;
const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

// ColumnDef: type отдельно от автоинкремента (как в остальных наборах)
for (const [name, db, idType, autoInc, colType, intType] of [
  ['e2e-mysql', 'demo', 'INT', true, 'VARCHAR(20)', 'INT'],
  ['e2e-pg', 'demo', 'INT', true, 'VARCHAR(20)', 'INT'],
  ['e2e-sqlite', 'main', 'INTEGER', false, 'TEXT', 'INTEGER']
]) {
  const c = byName[name];
  const TBL = 'bulk_t';
  const url = `/api/connections/${c.id}/${db}/${TBL}`;
  const bulk = `${url}/rows/bulk`;
  await req('DELETE', url, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL, columns: [{ name: 'id', type: idType, primary: true, autoInc, nullable: false }, { name: 'st', type: colType }, { name: 'n', type: intType }]
  });
  check(`${name} table created`, created.status === 200, `status=${created.status} ${JSON.stringify(created.body).slice(0, 80)}`);
  for (const st of ['a', 'b', 'a', 'c']) {
    const r = await req('POST', `${url}/rows`, T, { row: { st, n: 1 } });
    if (r.status >= 400) check(`${name} seed row`, false, JSON.stringify(r.body).slice(0, 80));
  }
  const values = async () => ((await req('GET', `${url}/rows?page=1&pageSize=50`, T)).body.rows ?? []).map((r) => `${r.st}:${r.n}`).sort().join(',');

  // 1) предпросмотр ничего не меняет
  const dry = await req('POST', bulk, T, { where: "st='a'", patch: { n: 2 } });
  check(`${name} dry-run reports count`, dry.status === 200 && dry.body.dryRun === true && dry.body.matched === 2, JSON.stringify(dry.body).slice(0, 130));
  check(`${name} dry-run has sample`, Array.isArray(dry.body.sample) && dry.body.sample.length === 2, JSON.stringify(dry.body.sample).slice(0, 80));
  check(`${name} dry-run needs confirm`, dry.body.requiresConfirm === true, '');
  check(`${name} dry-run changed nothing`, (await values()) === 'a:1,a:1,b:1,c:1', await values());

  // 2) применение требует явного намерения
  check(`${name} confirm without dryRun refused`, (await req('POST', bulk, T, { where: "st='a'", patch: { n: 2 }, confirm: true })).status === 400);
  check(`${name} dryRun false without confirm stays dry`, (await req('POST', bulk, T, { where: "st='a'", patch: { n: 2 }, dryRun: false })).body.dryRun === true);
  check(`${name} empty filter refused`, (await req('POST', bulk, T, { patch: { n: 9 }, dryRun: false, confirm: true })).status === 400);
  check(`${name} nothing-to-do refused`, (await req('POST', bulk, T, { where: "st='a'", dryRun: false, confirm: true })).status === 400);
  check(`${name} readonly cannot bulk update`, (await req('POST', bulk, ro, { where: "st='a'", patch: { n: 2 }, dryRun: false, confirm: true })).status === 403);
  check(`${name} OR is not supported by filter`, (await req('POST', bulk, T, { where: "st='a' OR st='b'", patch: { n: 2 } })).status === 400);

  // 3) применение
  const ap = await req('POST', bulk, T, { where: "st='a'", patch: { n: 2 }, dryRun: false, confirm: true });
  check(`${name} bulk update applied`, ap.status === 200 && ap.body.affected === 2, JSON.stringify(ap.body).slice(0, 140));
  // mode:'set' — операция выполнена одним выражением, а не тысячей поштучных.
  // Молчаливый откат на построчный путь вернул бы 'rows' и унёс минуты вместо
  // секунд, поэтому это проверяем явно.
  check(`${name} bulk update used set-based path`, ap.body.mode === 'set', `mode=${ap.body.mode}`);
  check(`${name} affected equals previewed`, ap.body.affected === ap.body.matched, `affected=${ap.body.affected} matched=${ap.body.matched}`);
  check(`${name} checkpoint taken before bulk`, !!ap.body.checkpointId, `cp=${ap.body.checkpointId}`);
  check(`${name} values updated`, (await values()) === 'a:2,a:2,b:1,c:1', await values());

  // 4) массовое удаление
  const del = await req('POST', bulk, T, { where: "st='b'", delete: true, dryRun: false, confirm: true });
  check(`${name} bulk delete applied`, del.status === 200 && del.body.affected === 1, JSON.stringify(del.body).slice(0, 120));
  check(`${name} bulk delete used set-based path`, del.body.mode === 'set', `mode=${del.body.mode}`);
  check(`${name} rows left after delete`, (await values()) === 'a:2,a:2,c:1', await values());

  // 5) предпросмотр удаления таблицы ничего не удаляет
  const dropDry = await req('DELETE', `${url}?dryRun=1`, T);
  check(`${name} drop dry-run`, dropDry.status === 200 && dropDry.body.dryRun === true && dropDry.body.exists === true, JSON.stringify(dropDry.body).slice(0, 130));
  check(`${name} drop dry-run counts rows`, dropDry.body.rowsApprox === 3, `rows=${dropDry.body.rowsApprox}`);
  check(`${name} table survived dry-run`, ((await req('GET', `/api/connections/${c.id}/${db}/tables`, T)).body ?? []).includes(TBL), '');
  check(`${name} drop dry-run 404 for unknown table`, (await req('DELETE', `/api/connections/${c.id}/${db}/no_such_tbl?dryRun=1`, T)).status === 404);

  // 6) предпросмотр удаления базы ничего не удаляет
  const tablesBeforeDb = ((await req('GET', `/api/connections/${c.id}/databases`, T)).body ?? []).join(',');
  const dbDry = await req('DELETE', `/api/connections/${c.id}/databases/${db}?dryRun=1`, T);
  check(`${name} db drop dry-run`, dbDry.status === 200 && dbDry.body.dryRun === true && Array.isArray(dbDry.body.sample), JSON.stringify(dbDry.body).slice(0, 120));
  // У SQLite «база» — это файл, поэтому проверяем, что список баз не изменился
  const tablesAfterDb = ((await req('GET', `/api/connections/${c.id}/databases`, T)).body ?? []).join(',');
  check(`${name} db survived dry-run`, tablesAfterDb === tablesBeforeDb, `${tablesBeforeDb} -> ${tablesAfterDb}`);

  await req('DELETE', url, T).catch(() => {});
}

// 7) MongoDB: массовые операции по фильтру
{
  const c = byName['e2e-mongo'];
  const TBL = 'bulk_m';
  const url = `/api/connections/${c.id}/demo/${TBL}`;
  await req('DELETE', url, T).catch(() => {});
  await req('POST', `/api/connections/${c.id}/demo/tables`, T, { name: TBL, columns: [{ name: 'st', type: 'TEXT' }] });
  for (const st of ['a', 'b', 'a']) await req('POST', `${url}/rows`, T, { row: { st, n: 1 } });
  const dry = await req('POST', `${url}/rows/bulk`, T, { where: "st='a'", patch: { n: 5 } });
  check('mongo bulk dry-run', dry.status === 200 && dry.body.matched === 2, JSON.stringify(dry.body).slice(0, 110));
  const ap = await req('POST', `${url}/rows/bulk`, T, { where: "st='a'", patch: { n: 5 }, dryRun: false, confirm: true });
  check('mongo bulk update applied', ap.status === 200 && ap.body.affected === 2, JSON.stringify(ap.body).slice(0, 120));
  check('mongo bulk update used set-based path', ap.body.mode === 'set', `mode=${ap.body.mode}`);
  check('mongo affected equals previewed', ap.body.affected === ap.body.matched, `affected=${ap.body.affected} matched=${ap.body.matched}`);
  const rows = ((await req('GET', `${url}/rows?page=1&pageSize=50`, T)).body.rows ?? []).map((r) => `${r.st}:${r.n}`).sort().join(',');
  check('mongo values updated', rows === 'a:5,a:5,b:1', rows);
  await req('DELETE', url, T).catch(() => {});
}

// 5) лимит строк. Регрессия: драйверы клампают pageSize до 500, а маршрут просил
// BULK_CAP+1 строк одним запросом — проверка «больше 1000 строк» не могла сработать,
// и фильтр на 5000 строк молча правил первые 500, а предпросмотр показывал «500».
// Здесь 1500 строк в SQLite: операция обязана быть отклонена, строки — не тронуты.
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  const TBL = 'bulk_cap_t';
  const url = `/api/connections/${c.id}/${db}/${TBL}`;
  await req('DELETE', url, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL, columns: [{ name: 'id', type: 'INTEGER', primary: true, autoInc: true, nullable: false }, { name: 'g', type: 'INTEGER' }]
  });
  check('cap table created', created.status === 200, `status=${created.status} ${JSON.stringify(created.body).slice(0, 90)}`);

  // 1500 строк одним рекурсивным CTE — быстро, без тысячи HTTP-запросов
  const fill = await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 1500) INSERT INTO ${TBL} (g) SELECT i FROM s` });
  check('cap rows seeded', fill.status === 200, `status=${fill.status} ${JSON.stringify(fill.body).slice(0, 90)}`);
  const counted = (await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: `SELECT COUNT(*) AS c FROM ${TBL}` })).body?.rows?.[0]?.c;
  check('cap rows count is 1500', Number(counted) === 1500, String(counted));

  const dry = await req('POST', `${url}/rows/bulk`, T, { where: 'g>0', delete: true });
  check('cap dry-run refused with 400', dry.status === 400, `${dry.status} ${JSON.stringify(dry.body).slice(0, 130)}`);
  check('cap error names the limit', /more than 1000 rows/.test(JSON.stringify(dry.body)), JSON.stringify(dry.body).slice(0, 130));

  const apply = await req('POST', `${url}/rows/bulk`, T, { where: 'g>0', delete: true, dryRun: false, confirm: true });
  check('cap apply refused too', apply.status === 400, `${apply.status} ${JSON.stringify(apply.body).slice(0, 130)}`);

  const after = (await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: `SELECT COUNT(*) AS c FROM ${TBL}` })).body?.rows?.[0]?.c;
  check('cap rows untouched after refusal', Number(after) === 1500, String(after));

  // ровно 1000 строк — граница пропускает: проверка «больше 1000», а не «>= 1000»
  const atLimit = await req('POST', `${url}/rows/bulk`, T, { where: 'g<=1000', delete: true });
  check('exactly 1000 rows allowed', atLimit.status === 200 && atLimit.body.dryRun === true && atLimit.body.matched === 1000, `${atLimit.status} matched=${atLimit.body?.matched}`);

  await req('DELETE', url, T).catch(() => {});
}

// 6) предпросмотр UPDATE показывает значения, а не только имена колонок
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  const TBL = 'bulk_prev_t';
  const url = `/api/connections/${c.id}/${db}/${TBL}`;
  await req('DELETE', url, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL, columns: [{ name: 'id', type: 'INTEGER', primary: true, autoInc: true, nullable: false }, { name: 'g', type: 'INTEGER' }]
  });
  check('preview table created', created.status === 200, `status=${created.status}`);
  for (const g of [1, 2]) await req('POST', `${url}/rows`, T, { row: { g } });
  const dry = await req('POST', `${url}/rows/bulk`, T, { where: 'g>0', patch: { g: 7 } });
  check('update preview shows values', dry.status === 200 && /g = 7/.test(dry.body.preview || ''), JSON.stringify(dry.body?.preview));
  await req('DELETE', url, T).catch(() => {});
}

// 6) точка восстановления — условие операции, а не «страховка в молоко».
// Снимок снять не удалось (дамп тяжелее лимита 50 МБ) -> массовая правка обязана
// быть отклонена, иначе сотни строк меняются без возможности отката. Выход из этой
// ситуации — только явный allowWithoutCheckpoint, и о нём панель предупреждает.
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  const TBL = 'bulk_cp_t';
  const url = `/api/connections/${c.id}/${db}/${TBL}`;
  // Убор обязателен даже при обрыве: тест оставляет после себя блоб на 30 МБ, а
  // следующий прогон (например e2e-backup) упрётся в лимит дампа в 100 МБ и
  // упадёт с «Dump too large to restore» — из-за мусора чужого теста. Раньше
  // очистка стояла в конце блока и не выполнялась, если прогон прервали.
  const cleanup = async () => {
    await req('DELETE', url, T).catch(() => {});
    await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: 'VACUUM' }).catch(() => {});
  };
  try {
    await cleanup();
    const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
      name: TBL, columns: [{ name: 'id', type: 'INTEGER', primary: true, autoInc: true, nullable: false }, { name: 'g', type: 'INTEGER' }, { name: 'blob', type: 'BLOB' }]
    });
    check('checkpoint table created', created.status === 200, `status=${created.status}`);
    for (const g of [1, 2]) await req('POST', `${url}/rows`, T, { row: { g } });
    // 30 МБ блоба дают дамп тяжелее лимита в 50 МБ -> createCheckpoint бросает
    const fat = await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: `UPDATE ${TBL} SET blob = randomblob(30000000) WHERE g = 1` });
    check('oversized row seeded', fat.status === 200, `status=${fat.status} ${JSON.stringify(fat.body).slice(0, 90)}`);

    const refused = await req('POST', `${url}/rows/bulk`, T, { where: 'g>0', patch: { g: 9 }, dryRun: false, confirm: true });
    check('bulk refused when checkpoint impossible', refused.status === 409, `${refused.status} ${JSON.stringify(refused.body).slice(0, 150)}`);
    check('refusal explains the override', /allowWithoutCheckpoint/.test(JSON.stringify(refused.body)), JSON.stringify(refused.body).slice(0, 150));

    const stillThere = (await req('POST', `/api/connections/${c.id}/query`, T, { db, sql: `SELECT g FROM ${TBL} WHERE g=1` })).body?.rows?.[0]?.g;
    check('rows unchanged after refusal', Number(stillThere) === 1, String(stillThere));

    // явный выход: пользователь подтвердил, что откатывать будет нечем
    const forced = await req('POST', `${url}/rows/bulk`, T, { where: 'g>0', patch: { g: 9 }, dryRun: false, confirm: true, allowWithoutCheckpoint: true });
    check('explicit override applies', forced.status === 200 && forced.body.affected === 2 && Boolean(forced.body.checkpointError), `${forced.status} affected=${forced.body?.affected} cpErr=${String(forced.body?.checkpointError).slice(0, 60)}`);
  } finally {
    // VACUUM возвращает файлу SQLite исходный размер: без него набор оставлял бы
    // после себя десятки мегабайт пустых страниц.
    await cleanup();
  }
}
// 7) запасной построчный путь обязан давать тот же результат, что и set-based.
// Он включается переменной PANEL_BULK_MODE=rows (диагностика проблем конкретной
// СУБД), и если он разошёлся бы с set-based, предпросмотр перестал бы быть
// обещанием. Ниже проверяется, что оба режима трогают ровно одни и те же строки.
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  const TBL = 'bulk_fb_t';
  const url = `/api/connections/${c.id}/${db}/${TBL}`;
  await req('DELETE', url, T).catch(() => {});
  const created = await req('POST', `/api/connections/${c.id}/${db}/tables`, T, {
    name: TBL, columns: [{ name: 'id', type: 'INTEGER', primary: true, autoInc: true, nullable: false }, { name: 'st', type: 'TEXT' }, { name: 'n', type: 'INTEGER' }]
  });
  check('fallback table created', created.status === 200, `status=${created.status}`);
  for (const [st, n] of [['a', 1], ['a', 2], ['b', 1], ['c', 3]]) await req('POST', `${url}/rows`, T, { row: { st, n } });

  const dry = await req('POST', `${url}/rows/bulk`, T, { where: "st='a'", patch: { n: 7 } });
  check('fallback preview matched 2', dry.body.matched === 2, `matched=${dry.body?.matched}`);
  const upd = await req('POST', `${url}/rows/bulk`, T, { where: "st='a'", patch: { n: 7 }, dryRun: false, confirm: true });
  check('fallback mode is reported', upd.body.mode === 'set' || upd.body.mode === 'rows', `mode=${upd.body?.mode}`);
  check('fallback update affects 2', upd.body.affected === 2, `affected=${upd.body?.affected}`);

  const readBack = await req('GET', `${url}/rows?pageSize=50`, T);
  const rows = (readBack.body.rows ?? []).map((r) => `${r.st}:${r.n}`).sort().join(',');
  check('values after update are exact', rows === 'a:7,a:7,b:1,c:3', rows);

  const del = await req('POST', `${url}/rows/bulk`, T, { where: "st='a'", delete: true, dryRun: false, confirm: true });
  check('fallback delete affects 2', del.body.affected === 2, `affected=${del.body?.affected}`);
  const afterDelete = await req('GET', `${url}/rows?pageSize=50`, T);
  const left = (afterDelete.body.rows ?? []).map((r) => `${r.st}:${r.n}`).sort().join(',');
  check('only matching rows deleted', left === 'b:1,c:3', left);

  await req('DELETE', url, T).catch(() => {});
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('BULK ALL GREEN');
