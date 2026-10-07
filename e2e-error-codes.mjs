// e2e-error-codes.mjs — машинные коды ошибок в ответах API.
//
// Зачем: интерфейс переводит сообщение по коду, а не по английскому тексту
// (текст серверов меняется между версиями). Если код перестанет приходить или
// придёт с опечаткой, интерфейс молча покажет английский фразу — и это будет
// выглядеть как «сломалась локализация», хотя сломалась отправка кода. Поэтому
// коды проверяются отдельно.
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
const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
const mysql = byName['e2e-mysql'];

// 1. Нулевая дата в DDL: MySQL 8.4 отвергает её, панель — обязана сказать код.
const zeroTable = 'errcode_zero_probe';
await req('DELETE', `/api/connections/${mysql.id}/demo/${zeroTable}`, T);
const wp = `CREATE TABLE \`${zeroTable}\` (\n  \`post_date\` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',\n  PRIMARY KEY (\`post_date\`)\n) ENGINE=InnoDB;`;
const zero = await req('POST', `/api/connections/${mysql.id}/query`, T, { sql: wp, db: 'demo' });
check('нулевая дата: код zero_date', zero.status === 400 && zero.body.code === 'zero_date',
  `status=${zero.status} code=${zero.body.code}`);
check('нулевая дата: сервер объяснил причину', /NO_ZERO_DATE/.test(String(zero.body.error ?? '')),
  String(zero.body.error ?? '').slice(0, 80));

// 2. Нет такой таблицы.
const missing = await req('POST', `/api/connections/${mysql.id}/query`, T, { sql: 'SELECT * FROM definitely_absent_table', db: 'demo' });
check('нет таблицы: код table_not_found', missing.status === 400 && missing.body.code === 'table_not_found',
  `status=${missing.status} code=${missing.body.code}`);

// 3. EXPLAIN только для чтения.
const explain = await req('POST', `/api/connections/${mysql.id}/explain`, T, { db: 'demo', sql: 'CREATE TABLE `zz` (`id` int)' });
check('explain: код explain_readonly', explain.status === 400 && explain.body.code === 'explain_readonly',
  `status=${explain.status} code=${explain.body.code}`);

// 4. Недопустимое имя.
const badName = await req('POST', `/api/connections/${mysql.id}/demo/tables`, T, { name: 'bad name', columns: [{ name: 'id', type: 'INT' }] });
check('имя с пробелом: код bad_identifier', badName.status === 400 && badName.body.code === 'bad_identifier',
  `status=${badName.status} code=${badName.body.code}`);

// 5. Тот же код в моделях: правило имён там было отдельной копией.
const badModel = await req('POST', '/api/models', T, {
  name: 'errcode_probe', dbKind: 'mysql',
  tables: [{ name: 'bad name', columns: [{ name: 'id', type: 'INT' }] }],
});
check('модель с недопустимым именем: код bad_identifier',
  badModel.status === 400 && badModel.body.code === 'bad_identifier',
  `status=${badModel.status} code=${badModel.body.code}`);

// 6. Код есть, но текст сервера остаётся английским: журналы и API его читают.
check('текст ошибки остаётся английским', /^[A-Za-z0-9]/.test(String(zero.body.error ?? '')),
  String(zero.body.error ?? '').slice(0, 60));

// 7. Отказ по «только чтение» тоже должен нести код: раньше 24 проверки в
//    десяти файлах писали английский текст каждая своя, и интерфейс не знал,
//    что переводить. Соединение помечаем read-only, проверяем и возвращаем как было.
const mysqlConn = (await req('GET', '/api/connections', T)).body.find((c) => c.name === 'e2e-mysql');
const before = mysqlConn.readOnly;
const patched = await req('PATCH', `/api/connections/${mysqlConn.id}`, T, { readOnly: true });
check('соединение переведено в read-only', patched.status === 200, `status=${patched.status} ${JSON.stringify(patched.body).slice(0, 90)}`);
if (patched.status === 200) {
  for (const [what, method, path, body] of [
    ['создание таблицы', 'POST', `/api/connections/${mysqlConn.id}/demo/tables`, { name: 'ro_probe', columns: [{ name: 'id', type: 'INT' }] }],
    ['изменение схемы', 'PATCH', `/api/connections/${mysqlConn.id}/demo/users`, { ops: [{ op: 'addColumn', column: { name: 'ro_col', type: 'INT' } }] }],
    ['запрос', 'POST', `/api/connections/${mysqlConn.id}/query`, { sql: 'CREATE TABLE ro_probe2 (id int)', db: 'demo' }],
  ]) {
    const res = await req(method, path, T, body);
    check(`read-only: ${what} → код read_only_connection`,
      res.status === 403 && res.body.code === 'read_only_connection',
      `status=${res.status} code=${res.body.code}`);
  }
  await req('PATCH', `/api/connections/${mysqlConn.id}`, T, { readOnly: Boolean(before) });
  const restored = (await req('GET', '/api/connections', T)).body.find((c) => c.id === mysqlConn.id);
  check('соединение возвращено в исходный режим', Boolean(restored.readOnly) === Boolean(before), `readOnly=${restored.readOnly}`);
}

// 8. Отказ отката DDL тоже должен нести код. Без него интерфейс показывал
//    пользователю английский текст сервера («The last package changed columns
//    …») прямо в блоке «DDL применён» — на любом языке интерфейса.
const undoTable = 'errcode_undo_probe';
await req('DELETE', `/api/connections/${mysql.id}/demo/${undoTable}`, T);
const created = await req('POST', `/api/connections/${mysql.id}/demo/tables`, T, {
  name: undoTable, columns: [{ name: 'id', type: 'INT', primary: true }],
});
if (created.status < 400) {
  const altered = await req('PATCH', `/api/connections/${mysql.id}/demo/${undoTable}`, T, {
    ops: [{ op: 'addColumn', column: { name: 'note', type: 'VARCHAR(20)' } }],
  });
  check('DDL применён — есть снимок для отката', altered.status < 400, `status=${altered.status}`);
  const undo = await req('POST', `/api/connections/${mysql.id}/demo/${undoTable}/undo`, T);
  check('откат структурного DDL: код undo_structural',
    undo.status === 409 && undo.body.code === 'undo_structural',
    `status=${undo.status} code=${undo.body.code}`);
  check('откат приносит DDL до изменения для ручного восстановления',
    typeof undo.body.ddlBefore === 'string' && /CREATE TABLE/i.test(String(undo.body.ddlBefore)),
    String(undo.body.ddlBefore).slice(0, 60));
  check('текст отката остаётся английским для журнала',
    /^[A-Za-z]/.test(String(undo.body.error ?? '')), String(undo.body.error ?? '').slice(0, 60));
} else {
  check('таблица для проверки отката создана', false, `status=${created.status}`);
}
await req('DELETE', `/api/connections/${mysql.id}/demo/${undoTable}`, T);

await req('DELETE', `/api/connections/${mysql.id}/demo/${zeroTable}`, T);

console.log(failures ? `FAILURES: ${failures}` : 'ERROR CODES ALL GREEN');
process.exit(failures ? 1 : 0);
