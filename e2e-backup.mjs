// E2E бэкапов: schedule, run, restore, retention, RBAC.
const BASE = 'http://localhost:3001';
let failures = 0;

async function req(method, path, token, body, raw) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 200)}`);
  }
  return raw ? r.text() : r.json().catch(() => ({}));
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;
const conns = await req('GET', '/api/connections', T);
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
const sq = byName['e2e-sqlite'];
const my = byName['e2e-mysql'];

// выделенная таблица чтобы не мусорить
for (const c of [sq, my]) {
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS bk_t' }).catch(() => {});
}
await req('POST', `/api/connections/${sq.id}/query`, T, { sql: 'CREATE TABLE bk_t(id INTEGER PRIMARY KEY, v TEXT)' });
await req('POST', `/api/connections/${my.id}/query`, T, { sql: 'CREATE TABLE bk_t(id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(50))' });
await req('POST', `/api/connections/${sq.id}/import`, T, { format: 'json', db: 'main', table: 'bk_t', data: JSON.stringify([{ v: 'a' }, { v: 'b' }]) });
await req('POST', `/api/connections/${my.id}/import`, T, { format: 'json', db: 'demo', table: 'bk_t', data: JSON.stringify([{ v: 'a' }, { v: 'b' }]) });

// schedule sqlite
const sch = await req('POST', '/api/backups/schedules', T, { connId: sq.id, db: 'main', format: 'sql', intervalMin: 1440, keepLast: 2 });
check('sched create', !!sch.id && sch.nextRunAt > Date.now(), sch.id);
const run1 = await req('POST', `/api/backups/schedules/${sch.id}/run`, T);
check('run ok', run1.ok === 1 && run1.bytes > 0 && run1.tables >= 1, JSON.stringify(run1));

// restore: удалить 1 строку, восстановить, проверить возврат (2 дамп-строки поверх 1 оставшейся = 3)
await req('POST', `/api/connections/${sq.id}/query`, T, { sql: `DELETE FROM bk_t WHERE v='a'` });
const cnt1 = await req('POST', `/api/connections/${sq.id}/query`, T, { sql: 'SELECT COUNT(*) AS c FROM bk_t' });
check('pre-restore count', cnt1.rows[0].c === 1, JSON.stringify(cnt1.rows));
const runs = await req('GET', `/api/backups/runs?scheduleId=${sch.id}`, T);
const rest = await req('POST', `/api/backups/runs/${runs[0].id}/restore`, T);
check('restore', rest.tables >= 1, JSON.stringify(rest));
const cnt2 = await req('POST', `/api/connections/${sq.id}/query`, T, { sql: `SELECT COUNT(*) AS c FROM bk_t WHERE v IN ('a','b')` });
check('post-restore rows', cnt2.rows[0].c === 2, JSON.stringify(cnt2.rows));

// retention keepLast=2: ещё 2 запуска -> останется 2
await req('POST', `/api/backups/schedules/${sch.id}/run`, T);
await req('POST', `/api/backups/schedules/${sch.id}/run`, T);
const runs2 = await req('GET', `/api/backups/runs?scheduleId=${sch.id}`, T);
check('retention', runs2.length === 2, `got=${runs2.length}`);

// download
const dl = await req('GET', `/api/backups/runs/${runs2[0].id}/download`, T, undefined, true);
check('download', dl.includes('INSERT INTO') && dl.includes('bk_t'), `len=${dl.length}`);

// mysql schedule быстрый прогон
const schm = await req('POST', '/api/backups/schedules', T, { connId: my.id, db: 'demo', format: 'sql', intervalMin: 60, keepLast: 2 });
const runm = await req('POST', `/api/backups/schedules/${schm.id}/run`, T);
check('mysql run', runm.ok === 1 && runm.bytes > 0, JSON.stringify(runm));

// mongo только json: sql должен отклониться
try {
  await req('POST', '/api/backups/schedules', T, { connId: byName['e2e-mongo'].id, db: 'demo', format: 'sql', intervalMin: 60, keepLast: 2 });
  check('mongo sql rejected', false);
} catch { check('mongo sql rejected', true); }

// readonly заблокирован
const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
try {
  const RH = `Bearer ${ro.token}`;
  const r = await fetch(BASE + '/api/backups/schedules', { method: 'POST', headers: { 'content-type': 'application/json', authorization: RH }, body: JSON.stringify({ connId: sq.id, db: 'main', format: 'sql', intervalMin: 60, keepLast: 2 }) });
  check('ro blocked', r.status === 403, `status=${r.status}`);
} catch (e) { check('ro blocked', false, String(e)); }

// meta.db: снять копию, увидеть в списке, восстановить, сервер жив после замены
const meta0 = await req('POST', '/api/backups/meta', T, {});
check('meta snapshot', typeof meta0.file === 'string' && meta0.bytes > 0, `${meta0.file} ${meta0.bytes}b`);
const metaList = await req('GET', '/api/backups/meta', T);
check('meta listed', metaList.some((x) => x.file === meta0.file), `n=${metaList.length}`);
const restored = await req('POST', `/api/backups/meta/${meta0.file}/restore`, T);
check('meta restored', restored.ok === true, JSON.stringify(restored).slice(0, 80));
const alive = await req('GET', '/api/health', null).catch(() => null);
check('server alive after meta restore', alive !== null, '');
try {
  await req('DELETE', `/api/backups/meta/${meta0.file}/restore`, T);
  check('meta restore path is POST-only', false);
} catch { check('meta restore path is POST-only', true); }

// cleanup
await req('DELETE', `/api/backups/schedules/${sch.id}`, T);
await req('DELETE', `/api/backups/schedules/${schm.id}`, T);
await req('POST', `/api/connections/${sq.id}/query`, T, { sql: 'DROP TABLE bk_t' });
await req('POST', `/api/connections/${my.id}/query`, T, { sql: 'DROP TABLE bk_t' });
const gone = await req('GET', '/api/backups/schedules', T);
check('sched deleted', !gone.some((x) => x.id === sch.id || x.id === schm.id), `left=${gone.length}`);

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('BACKUP ALL GREEN');
