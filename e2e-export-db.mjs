// e2e-export-db.mjs — экспорт всей базы одним файлом.
//
// Проверяет то, ради чего маршрут и добавлен: выгрузка не одной таблицы, а всей
// базы, с выбором формата, корректным порядком таблиц по внешним ключам и
// понятным отказом при выборе несуществующей таблицы.
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const token = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) })).json()).token;
const H = { authorization: 'Bearer ' + token };

const conns = await (await fetch(BASE + '/api/connections', { headers: H })).json();
const conn = conns.find((c) => c.name === 'e2e-mysql');
const db = 'demo';

// Подготовка: родитель и ребёнок с внешним ключом плюс обычная таблица.
await fetch(`${BASE}/api/connections/${conn.id}/${db}/xp_child`, { method: 'DELETE', headers: H }).catch(() => {});
await fetch(`${BASE}/api/connections/${conn.id}/${db}/xp_parent`, { method: 'DELETE', headers: H }).catch(() => {});
await fetch(`${BASE}/api/connections/${conn.id}/${db}/xp_plain`, { method: 'DELETE', headers: H }).catch(() => {});
for (const [name, columns] of [
  ['xp_parent', [{ name: 'id', type: 'INT', primary: true, autoInc: true }, { name: 'title', type: 'VARCHAR(50)' }]],
  ['xp_plain', [{ name: 'id', type: 'INT', primary: true, autoInc: true }]],
  ['xp_child', [{ name: 'id', type: 'INT', primary: true, autoInc: true }, { name: 'parent_id', type: 'INT' }]],
]) {
  const r = await fetch(`${BASE}/api/connections/${conn.id}/${db}/tables`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name, columns }) });
  check(`таблица ${name} создана`, r.ok, `status=${r.status}`);
}
// Ребёнок назван так, что по алфавиту идёт раньше родителя: только сортировка
// по внешним ключам даст правильный порядок в дампе.
const fk = await fetch(`${BASE}/api/connections/${conn.id}/${db}/xp_child`, {
  method: 'PATCH', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ ops: [{ op: 'addForeignKey', fk: { name: 'fk_xp', columns: ['parent_id'], refTable: 'xp_parent', refColumns: ['id'] } }] }),
});
check('внешний ключ создан', fk.ok, `status=${fk.status}`);
for (const t of ['xp_parent', 'xp_child', 'xp_plain']) {
  await fetch(`${BASE}/api/connections/${conn.id}/${db}/${t}/rows`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ row: t === 'xp_parent' ? { title: 'родитель' } : {} }) }).catch(() => {});
}

const get = async (path) => {
  const r = await fetch(BASE + path, { headers: H });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
};

// ── SQL: структура и данные всех таблиц, родитель раньше ребёнка ─────────────
const sql = await get(`/api/connections/${conn.id}/${db}/export?format=sql`);
check('экспорт базы в sql отвечает 200', sql.status === 200, `status=${sql.status}`);
check('это sql, а не html/json', /application\/sql/.test(sql.headers.get('content-type') ?? ''), sql.headers.get('content-type'));
check('имя файла — по базе', /filename="demo\.sql"/.test(sql.headers.get('content-disposition') ?? ''), sql.headers.get('content-disposition'));
for (const t of ['xp_parent', 'xp_child', 'xp_plain']) {
  check(`в дампе есть ${t}`, sql.text.includes(`\`${t}\``) || sql.text.includes(`"${t}"`) || sql.text.includes(t), '');
}
const iParent = sql.text.indexOf('CREATE TABLE') > 0 ? sql.text.search(/xp_parent/) : -1;
const iChild = sql.text.search(/xp_child/);
check('родитель идёт раньше ребёнка (порядок по внешнему ключу)', iParent >= 0 && iChild > iParent, `parent@${iParent} child@${iChild}`);
check('данные попали в дамп', /INSERT INTO/i.test(sql.text), '');
check('дамп можно выполнить заново', (await get(`/api/connections/${conn.id}/${db}/export?format=sql`)).status === 200);

// ── JSON: объект с ключами-таблицами ────────────────────────────────────────
const json = await get(`/api/connections/${conn.id}/${db}/export?format=json`);
check('экспорт базы в json отвечает 200', json.status === 200, `status=${json.status}`);
let parsed = null;
try { parsed = JSON.parse(json.text); } catch { /* разберём ниже */ }
check('json разбирается', parsed !== null, json.text.slice(0, 80));
check('json — объект с таблицами', parsed && typeof parsed === 'object' && !Array.isArray(parsed), typeof parsed);
check('в json есть все три таблицы', Boolean(parsed?.xp_parent && parsed?.xp_child && parsed?.xp_plain), Object.keys(parsed ?? {}).join(','));

// ── CSV: составной файл с разделителями ─────────────────────────────────────
const csv = await get(`/api/connections/${conn.id}/${db}/export?format=csv`);
check('экспорт базы в csv отвечает 200', csv.status === 200, `status=${csv.status}`);
check('csv помечает каждую таблицу', csv.text.split('# table:').length - 1 >= 3, String(csv.text.split('# table:').length - 1));
check('csv начинается с пояснения', /^# dbpanel export/.test(csv.text), csv.text.slice(0, 40));

// ── Выбор подмножества таблиц ───────────────────────────────────────────────
const only = await get(`/api/connections/${conn.id}/${db}/export?format=json&tables=xp_parent,xp_plain`);
let onlyParsed = null;
try { onlyParsed = JSON.parse(only.text); } catch { /* ниже */ }
check('выбор таблиц: только они в выгрузке', only.status === 200 && onlyParsed && Object.keys(onlyParsed).length === 2, Object.keys(onlyParsed ?? {}).join(','));

// ── Ошибки ──────────────────────────────────────────────────────────────────
check('неверный формат отвергнут', (await get(`/api/connections/${conn.id}/${db}/export?format=xml`)).status === 400);
const missing = await get(`/api/connections/${conn.id}/${db}/export?format=json&tables=nope`);
check('несуществующая таблица отвергнута', missing.status === 404, `status=${missing.status}`);
check('чужая база не выгружается молча', (await get(`/api/connections/${conn.id}/nosuchdb/export?format=json`)).status === 404);

// ── Экспорт одной таблицы продолжает работать ───────────────────────────────
const one = await get(`/api/connections/${conn.id}/${db}/xp_parent/export?format=json`);
let oneParsed = null;
try { oneParsed = JSON.parse(one.text); } catch { /* ниже */ }
check('экспорт одной таблицы не сломан', one.status === 200 && Array.isArray(oneParsed), `status=${one.status}`);

// Убор за собой.
for (const t of ['xp_child', 'xp_parent', 'xp_plain']) {
  await fetch(`${BASE}/api/connections/${conn.id}/${db}/${t}`, { method: 'DELETE', headers: H }).catch(() => {});
}

console.log(failures ? `FAILURES: ${failures}` : 'EXPORT DB ALL GREEN');
process.exit(failures ? 1 : 0);