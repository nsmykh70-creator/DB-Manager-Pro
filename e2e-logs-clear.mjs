// e2e-logs-clear.mjs — очистка журналов: права ролей, точечная и полная очистка
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? 'admin123';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

const adminLogin = await call('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD });
check('admin login', adminLogin.status === 200, 'status=' + adminLogin.status);
const token = adminLogin.body.token;
const roLogin = await call('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
const roToken = roLogin.body.token;
check('readonly user can log in', roLogin.status === 200 && !!roToken, 'status=' + roLogin.status);

const conns = (await call('GET', '/api/connections', token)).body;
const mysql = conns.find((c) => c.name === 'e2e-mysql');
const savedStamp = Date.now();

// наполняем журналы
await call('POST', `/api/connections/${mysql.id}/query`, token, { sql: 'SELECT 1 AS log_clear_probe' });
const auditBefore = (await call('GET', '/api/audit?limit=500', token)).body;
const histBefore = (await call('GET', `/api/history?connId=${mysql.id}&limit=200`, token)).body;
check('logs are not empty before clear', auditBefore.length > 0 && histBefore.length > 0, `audit=${auditBefore.length} hist=${histBefore.length}`);

// права
check('anonymous cannot clear audit', (await call('DELETE', '/api/audit?all=1')).status === 401);
check('readonly cannot clear audit', (await call('DELETE', '/api/audit?all=1', roToken)).status === 403);
check('readonly cannot clear all history', (await call('DELETE', '/api/history?scope=all', roToken)).status === 403);
check('readonly cannot clear saved history', (await call('DELETE', '/api/history?scope=saved', roToken)).status === 403);

// полная очистка админом
const clearedAudit = await call('DELETE', '/api/audit?all=1', token);
check('admin clears audit', clearedAudit.status === 200 && clearedAudit.body.deleted > 0, JSON.stringify(clearedAudit.body));
const auditAfter = (await call('GET', '/api/audit?limit=500', token)).body;
check(
  'audit keeps only the clear record',
  auditAfter.length === 1 && auditAfter[0].action === 'audit.clear',
  JSON.stringify(auditAfter.map((a) => a.action))
);

const clearedHist = await call('DELETE', '/api/history?scope=all', token);
check('admin clears all history', clearedHist.status === 200 && clearedHist.body.deleted > 0, JSON.stringify(clearedHist.body));
const histAfter = (await call('GET', `/api/history?connId=${mysql.id}`, token)).body;
check('history is empty', histAfter.length === 0, `left=${histAfter.length}`);

// рядовой чистит только свои записи
await call('POST', `/api/connections/${mysql.id}/query`, roToken, { sql: 'SELECT 2 AS mine_probe' });
const mine = await call('DELETE', '/api/history?scope=mine', roToken);
check('readonly clears own history', mine.status === 200 && mine.body.scope === 'mine', JSON.stringify(mine.body));
const left = (await call('GET', `/api/history?connId=${mysql.id}`, roToken)).body;
check('own history removed', left.every((h) => h.username !== 'ro_user'), `left=${left.length}`);

// сохранённые запросы стираются отдельно
// (журнал запросов per-user: GET /api/history всегда фильтрует по userId)
await call('POST', '/api/history', token, { connId: mysql.id, db: 'e2e_mysql', sql: `SELECT saved_probe_${savedStamp}`, name: 'saved-probe' });
const savedOnly = (await call('GET', `/api/history?connId=${mysql.id}&savedOnly=1&limit=50`, token)).body;
check('saved query listed for its owner', savedOnly.some((h) => h.name === 'saved-probe'), 'n=' + savedOnly.length);
const clearedSaved = await call('DELETE', '/api/history?scope=saved', token);
check('admin clears saved queries only', clearedSaved.status === 200 && clearedSaved.body.deleted > 0, JSON.stringify(clearedSaved.body));
check(
  'saved query gone',
  !(await call('GET', `/api/history?connId=${mysql.id}&savedOnly=1&limit=50`, token)).body.some((h) => h.name === 'saved-probe')
);

// изоляция журналов: список запросов виден только автору, очистка «all» — всем
await call('POST', '/api/history', token, { connId: mysql.id, sql: `SELECT private_${savedStamp}`, name: `private_${savedStamp}` });
const roSeesAdmin = (await call('GET', `/api/history?connId=${mysql.id}&limit=100`, roToken)).body;
check('query log is private per user', !roSeesAdmin.some((h) => h.username === 'admin'), 'rows=' + roSeesAdmin.length);

// очистка по конкретному подключению
await call('POST', `/api/connections/${mysql.id}/query`, token, { sql: 'SELECT 3 AS conn_scope_probe' });
const byConn = await call('DELETE', `/api/history?scope=all&connId=${mysql.id}`, token);
check('clear scoped to connection', byConn.status === 200, JSON.stringify(byConn.body));
check(
  'scoped history empty',
  (await call('GET', `/api/history?connId=${mysql.id}`, token)).body.length === 0
);

if (failures) {
  console.log(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log('E2E LOGS CLEAR: ALL GREEN');
