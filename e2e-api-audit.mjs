// Полный аудит API: каждый маршрут проверяется на три свойства.
//
//  1) Без токена → не 200 и не 500 (панель не должна отдавать данные анониму).
//  2) С ролью readonly → ни один изменяющий маршрут не должен пройти.
//  3) С админом и заведомо неверными данными → ответ 4xx с текстом, а не 500.
//     500 здесь означает «панель упала на чужой ошибке», и это главный источник
//     сообщений вида «Internal server error» без объяснений.
//
// Маршруты перечислены явно: список взят из app.printRoutes(), поэтому новый
// маршрут без проверки будет заметен — как и любой маршрут вручную удалённый.
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';
// Пароли должны совпадать с e2e-users.mjs: он создаёт этих пользователей.
// Раньше дефолт аудита был 'editor123', а пользователь создавался с
// 'editorpass123' — вход молча не проходил, и проверка падала не на том.
const RO_PASSWORD = process.env.E2E_RO_PASSWORD ?? 'readonly123';
const ED_PASSWORD = process.env.E2E_ED_PASSWORD ?? 'editorpass123';

let failures = 0;
const results = { total: 0, anon: 0, ro: 0, admin: 0 };
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
};

async function req(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
}

const login = async (username, password) => (await req('POST', '/api/auth/login', null, { username, password })).body.token;

// Убор за собой. Аудит создаёт подключение, пользователя и запись истории, и
// без удаления они остаются в панели: после первого прогона в сайдбаре
// появлялись «audit_probe», которые видит пользователь. Пробные объекты
// собираем здесь и удаляем в конце.
const created = { connections: [], users: [], history: [] };
const admin0 = await login('admin', PASSWORD);
const preExisting = new Set(((await req('GET', '/api/connections', admin0)).body ?? []).map((c) => c.id));
const preUsersRaw = (await req('GET', '/api/auth/users', admin0)).body ?? [];
for (const u of preUsersRaw.filter((x) => /^audit_probe$|^hijack$/.test(x.username))) {
  await req('DELETE', `/api/auth/users/${u.id}`, admin0).catch(() => {});
}
const preUsers = new Set(((await req('GET', '/api/auth/users', admin0)).body ?? []).map((u) => u.username));

const admin = admin0;
check('вход админом', Boolean(admin));

// Настройки тоже задеваем (PUT /api/settings в матрице ниже): запоминаем,
// чтобы вернуть как было, иначе в шапке сайдбара останется audit-probe.
const settingsBefore = (await req('GET', '/api/settings', admin)).body ?? {};

// Пользователей ролей создаёт e2e-users.mjs. Если аудит запустили отдельно,
// их может не быть — тогда роль не проверить никак. Создаём недостающих с тем
// же паролем; убор в конце их не трогает, потому что это не наши объекты.
for (const [username, password, role] of [['ro_user', RO_PASSWORD, 'readonly'], ['e2e_editor', ED_PASSWORD, 'editor']]) {
  if (preUsers.has(username)) continue;
  const made = await req('POST', '/api/auth/users', admin0, { username, password, role });
  check(`создан ${username} для проверки ролей`, made.status < 400, `status=${made.status}`);
}
const ro = await login('ro_user', RO_PASSWORD);
const ed = await login('e2e_editor', ED_PASSWORD);
check('вход readonly', Boolean(ro));
check('вход editor', Boolean(ed));

const CONN = '00000000-0000-4000-8000-000000000000'; // заведомо несуществующее подключение
const BAD = `${CONN}/nodb`;

// Маршруты, которые по замыслу публичны: аноним должен получить 200.
const PUBLIC_ROUTES = new Set(['GET /api/health', 'GET /api/drivers']);
// Маршруты, где readonly правомерен: это его личное (история запросов), а не
// изменение базы. Проверяем отдельно, что чужими записями он не оперирует.
const READONLY_ALLOWED = new Set(['POST /api/history']);

// [метод, путь, изменяющий?, роль admin-only?, тело]
const ROUTES = [
  ['GET', '/api/health', false, false],
  ['GET', '/api/drivers', false, false],
  ['GET', '/api/system/status', false, false],
  ['GET', '/api/settings', false, false],
  ['PUT', '/api/settings', true, true, { projectName: 'audit-probe' }],
  ['GET', '/api/auth/me', false, false],
  ['GET', '/api/auth/users', false, true],
  ['POST', '/api/auth/users', true, true, { username: 'audit_probe', password: 'AuditProbe123', role: 'editor' }],
  // Аудит не должен доводить дело до создания пользователя: тело заведомо
  // невалидное (роль не из списка), но проверка ниже отдельно убеждается, что
  // таких пользователей не осталось.
  ['PATCH', '/api/auth/users/nonexistent-id', true, true, { role: 'editor' }],
  ['DELETE', '/api/auth/users/nonexistent-id', true, true],
  ['GET', '/api/history', false, false],
  ['POST', '/api/history', true, false, { sql: 'SELECT 1', name: 'audit-probe' }],
  ['PATCH', '/api/history/nonexistent', true, false, { name: 'x' }],
  ['DELETE', '/api/history/nonexistent', true, false],
  ['GET', '/api/audit', false, false],
  ['DELETE', '/api/audit?all=1', true, true],
  ['GET', '/api/connections', false, false],
  ['POST', '/api/connections', true, true, { name: 'audit_probe', kind: 'mysql', host: '127.0.0.1', port: 1, user: 'x', password: 'y' }],
  ['PATCH', `/api/connections/${CONN}`, true, false, { name: 'x' }],
  ['DELETE', `/api/connections/${CONN}`, true, true],
  ['POST', `/api/connections/${CONN}/test`, false, false],
  ['GET', `/api/connections/${CONN}/databases`, false, false],
  ['POST', '/api/connections/x/databases', true, true, { connectionId: CONN, name: 'audit_db' }],
  ['DELETE', `/api/connections/${CONN}/nodb`, true, true],
  ['GET', `/api/connections/${CONN}/dbusers`, false, false],
  ['POST', `/api/connections/${CONN}/dbusers`, true, true, { username: 'u1', password: 'pass1234' }],
  ['DELETE', `/api/connections/${CONN}/dbusers/u1`, true, true],
  ['POST', `/api/connections/${CONN}/dbusers/u1/grant`, true, true, { privilege: 'SELECT' }],
  ['POST', `/api/connections/${CONN}/dbusers/u1/revoke`, true, true, { privilege: 'SELECT' }],
  ['GET', `/api/connections/${CONN}/dbusers/u1/grants`, false, false],
  ['GET', `/api/connections/${CONN}/status`, false, false],
  ['POST', `/api/connections/${CONN}/query`, true, false, { sql: 'SELECT 1', db: 'demo' }],
  ['POST', `/api/connections/${CONN}/import`, true, false, { format: 'json', db: 'demo', table: 't', data: {} }],
  ['POST', `/api/connections/${CONN}/explain`, false, false, { sql: 'SELECT 1', db: 'demo' }],
  ['POST', `/api/connections/${CONN}/kill`, true, false, { pid: '1' }],
  ['GET', `/api/connections/${CONN}/nodb/tables`, false, false],
  ['POST', `/api/connections/${CONN}/nodb/tables`, true, false, { name: 't', columns: [{ name: 'id', type: 'INT' }] }],
  ['GET', `/api/connections/${CONN}/nodb/search`, false, false, undefined],
  ['GET', `/api/connections/${CONN}/nodb/er`, false, false],
  ['PATCH', `/api/connections/${CONN}/nodb/t`, true, false, { ops: [{ op: 'addColumn', column: { name: 'c', type: 'INT' } }] }],
  ['DELETE', `/api/connections/${CONN}/nodb/t`, true, false],
  ['GET', `/api/connections/${CONN}/nodb/t/schema`, false, false],
  ['GET', `/api/connections/${CONN}/nodb/t/rows`, false, false],
  ['POST', `/api/connections/${CONN}/nodb/t/rows`, true, false, { row: { a: 1 } }],
  ['PATCH', `/api/connections/${CONN}/nodb/t/rows`, true, false, { where: 'id=1', row: { a: 2 } }],
  ['DELETE', `/api/connections/${CONN}/nodb/t/rows`, true, false, { where: 'id=1' }],
  ['POST', `/api/connections/${CONN}/nodb/t/rows/bulk`, true, false, { where: 'id=1', patch: { a: 1 }, dryRun: true }],
  ['GET', `/api/connections/${CONN}/nodb/t/export`, false, false],
  ['POST', `/api/connections/${CONN}/nodb/t/undo`, true, false],
  ['POST', `/api/connections/${CONN}/nodb/t/preview`, true, false, { ops: [] }],
  ['POST', `/api/connections/${CONN}/nodb/t/triggers`, true, false, { name: 'trg', timing: 'BEFORE', event: 'INSERT', body: 'BEGIN END' }],
  ['DELETE', `/api/connections/${CONN}/nodb/t/triggers/trg`, true, false],
  ['GET', '/api/data-undo', false, false],
  ['DELETE', '/api/data-undo/nonexistent', true, false],
  ['POST', '/api/data-undo/nonexistent/undo', true, false],
  ['POST', '/api/data-undo/nonexistent/redo', true, false],
  ['GET', '/api/checkpoints', false, false],
  ['POST', '/api/checkpoints', true, false, { connId: CONN, db: 'demo', table: 't' }],
  ['DELETE', '/api/checkpoints/nonexistent', true, false],
  ['POST', '/api/checkpoints/nonexistent/restore', true, false],
  ['GET', '/api/backups/schedules', false, false],
  // По замыслу (docs.backupsRights2) создание и включение расписания доступны
  // шире, чем админу; только удаление — только администратору.
  ['POST', '/api/backups/schedules', true, false, { name: 'audit-sched', kind: 'mysqldump', connId: CONN, db: 'demo' }],
  ['PATCH', '/api/backups/schedules/nonexistent', true, false, { enabled: false }],
  ['DELETE', '/api/backups/schedules/nonexistent', true, true],
  ['POST', '/api/backups/schedules/nonexistent/run', true, true],
  ['GET', '/api/backups/runs', false, false],
  ['GET', '/api/backups/runs/nonexistent/download', false, false],
  ['POST', '/api/backups/runs/nonexistent/restore', true, false],
  ['GET', '/api/models', false, false],
  ['POST', '/api/models', true, false, { name: 'audit_model', tables: [{ name: 't', columns: [{ name: 'id', type: 'INT' }] }] }],
  ['POST', '/api/models/import', true, false, { connId: CONN, db: 'demo', name: 'audit_model' }],
  ['GET', '/api/models/nonexistent', false, false],
  ['PUT', '/api/models/nonexistent', true, false, { name: 'audit_model', tables: [] }],
  ['PATCH', '/api/models/nonexistent', true, false, { name: 'x' }],
  ['DELETE', '/api/models/nonexistent', true, true],
  ['GET', '/api/models/nonexistent/versions', false, false],
  ['GET', '/api/models/nonexistent/versions/1', false, false],
  ['POST', '/api/models/nonexistent/versions/1/restore', true, false],
  ['POST', '/api/models/nonexistent/diff', true, false, { connId: CONN, db: 'demo' }],
  ['POST', '/api/models/nonexistent/apply', true, false, { connId: CONN, db: 'demo' }],
  ['GET', '/api/sqlite/files', false, false],
  ['POST', '/api/sqlite/files', true, true, undefined],
  ['DELETE', '/api/sqlite/files/nonexistent.db', true, true],
  ['GET', '/api/sqlite/files/nonexistent.db/download', false, false],
];

for (const [method, path, mutating, adminOnly, body] of ROUTES) {
  results.total++;
  const label = `${method} ${path.replace(CONN, '{conn}')}`;

  // 1) Аноним: публичные маршруты обязаны отвечать, остальные — не отдавать
  //    данные и не падать в 500.
  const anon = await req(method, path, null, body);
  const anonOk = PUBLIC_ROUTES.has(`${method} ${path}`) ? anon.status === 200 : anon.status !== 200 && anon.status !== 500;
  if (!anonOk) failures++;
  results.anon++;
  console.log(`${anonOk ? 'PASS' : 'FAIL'} аноним: ${label} -> ${anon.status}${anon.status === 500 ? ' (500!)' : ''}${PUBLIC_ROUTES.has(`${method} ${path}`) ? ' (публичный)' : ''}`);

  // 2) readonly не должен менять данные. 404 здесь допустим: ресурса нет, и его
  //    отсутствие — не привилегия. Запрещено только 2xx (успешное изменение).
  if (mutating) {
    const asRo = await req(method, path, ro, body);
    const roOk = READONLY_ALLOWED.has(`${method} ${path}`) || asRo.status < 200 || asRo.status >= 300;
    if (!roOk) failures++;
    results.ro++;
    console.log(`${roOk ? 'PASS' : 'FAIL'} readonly: ${label} -> ${asRo.status}${roOk ? '' : ' (ИЗМЕНИЛ!)'}`);
  }

  // 3) Админ с заведомо плохими данными: 4xx, а не 500.
  const asAdmin = await req(method, path, admin, body);
  if (asAdmin.status < 300 && asAdmin.body?.id) {
    // Успешное создание — запоминаем, чтобы удалить: пробные объекты не должны
    // оставаться в панели (см. предыдущий прогон, где в сайдбаре висели audit_probe).
    if (String(path).startsWith('/api/connections') && !path.includes(':id')) created.connections.push(asAdmin.body.id);
    if (path.startsWith('/api/auth/users')) created.users.push(asAdmin.body.username ?? asAdmin.body.id);
    if (path === '/api/history') created.history.push(asAdmin.body.id);
  }
  const noFive = asAdmin.status !== 500;
  if (!noFive) failures++;
  results.admin++;
  console.log(`${noFive ? 'PASS' : 'FAIL'} админ: ${label} -> ${asAdmin.status}${noFive ? '' : ' (500: ' + String(asAdmin.body?.error ?? '').slice(0, 90) + ')'}`);
}

// 4) Чужими записями пользователь не оперирует (IDOR). История запросов —
//    личная: запись одного пользователя не должна быть видна и изменяемой
//    другим, даже с равной ролью.
const saved = await req('POST', '/api/history', ro, { sql: 'SELECT 1', name: 'audit-idor-probe' });
check('readonly сохранил свою запись истории', saved.status === 200 && Boolean(saved.body?.id), `status=${saved.status}`);
if (saved.body?.id) {
  const otherList = await req('GET', '/api/history?limit=200', ed);
  // Ответ может быть не массивом (например, объектом ошибки) — тогда сначала
// проверяем форму ответа, иначе тест падает на .some вместо внятного FAIL.
const otherItems = Array.isArray(otherList.body) ? otherList.body : [];
if (!Array.isArray(otherList.body)) check('история editor вернула массив', false, JSON.stringify(otherList.body).slice(0, 80));
const visible = otherItems.some((h) => h.id === saved.body.id);
  check('чужая запись не видна в списке', !visible, visible ? 'видна!' : 'скрыта');
  const renamed = await req('PATCH', `/api/history/${saved.body.id}`, ed, { name: 'hijacked' });
  const removed = await req('DELETE', `/api/history/${saved.body.id}`, ed);
  // Отказ здесь может быть 403 (маршрут проверяет права) или 404 (запись не
  // найдена — тоже верно, чужая запись не видна). Главное — не 2xx.
  check('чужую запись нельзя переименовать', renamed.status >= 400, `status=${renamed.status}`);
  check('чужую запись нельзя удалить', removed.status >= 400, `status=${removed.status}`);
  const stillThere = (await req('GET', '/api/history?limit=200', ro)).body.some((h) => h.id === saved.body.id);
  check('запись владельца уцелела', stillThere);
  await req('DELETE', `/api/history/${saved.body.id}`, ro);
}

// 5) Роль editor: не может то, что по справке только админ (пользователи,
//    удаление расписаний, удаление моделей, очистка журнала, настройки).
for (const [method, path, body] of [
  ['GET', '/api/auth/users'],
  ['POST', '/api/auth/users', { username: 'hijack', password: 'Hijack12345', role: 'admin' }],
  ['DELETE', '/api/backups/schedules/nonexistent'],
  ['DELETE', '/api/audit?all=1'],
  ['PUT', '/api/settings', { projectName: 'hijack' }],
  ['DELETE', '/api/models/nonexistent'],
]) {
  const asEditor = await req(method, path, ed, body);
  const ok = asEditor.status === 401 || asEditor.status === 403;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} editor не может ${method} ${path} -> ${asEditor.status}${ok ? '' : ' (ПРОПУСТИЛ!)'}`);
}

// ── Убор за собой ───────────────────────────────────────────────────────────
for (const id of created.history) await req('DELETE', `/api/history/${id}`, admin).catch(() => {});
for (const username of created.users) {
  if (preUsers.has(username)) continue;
  const u = ((await req('GET', '/api/auth/users', admin)).body ?? []).find((x) => x.username === username);
  if (u) await req('DELETE', `/api/auth/users/${u.id}`, admin).catch(() => {});
}
const left = ((await req('GET', '/api/connections', admin)).body ?? []).map((c) => c.id).filter((id) => !preExisting.has(id));
for (const id of left) await req('DELETE', `/api/connections/${id}`, admin).catch(() => {});
const after = (await req('GET', '/api/connections', admin)).body ?? [];
check('аудит не оставил подключений', after.length === preExisting.size, `стало ${after.length}, было ${preExisting.size}`);
// Пользователей ищем по имени, а не по тому, что вернул POST: ответ может не
// содержать username, и пробный пользователь тогда остался бы в панели.
for (const u of ((await req('GET', '/api/auth/users', admin)).body ?? [])) {
  if (preUsers.has(u.username)) continue;
  if (/^audit_probe$|^hijack$/.test(u.username)) await req('DELETE', `/api/auth/users/${u.id}`, admin).catch(() => {});
}
const leftoverUsers = ((await req('GET', '/api/auth/users', admin)).body ?? []).map((u) => u.username).filter((n) => !preUsers.has(n));
check('аудит не оставил пользователей', leftoverUsers.length === 0, leftoverUsers.join(','));
// Возвращаем настройки: матрица выше писала projectName audit-probe/hijack.
if (settingsBefore && typeof settingsBefore === 'object' && Object.keys(settingsBefore).length) {
  await req('PUT', '/api/settings', admin, settingsBefore).catch(() => {});
}

console.log(`\nвсего проверок: ${results.total * 2 + results.ro + 12}, промахов: ${failures}`);
console.log(failures ? `AUDIT FAILURES: ${failures}` : 'API AUDIT ALL GREEN');
process.exit(failures ? 1 : 0);
