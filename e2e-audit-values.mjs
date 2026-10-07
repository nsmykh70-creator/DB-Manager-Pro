// e2e-audit-values.mjs — аудит правок строк содержит значения (before/after)
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
const mysql = conns.find((c) => c.name === 'e2e-mysql');
const TBL = 'audit_vals';
const url = `/api/connections/${mysql.id}/demo/${TBL}/rows`;

await req('DELETE', `/api/connections/${mysql.id}/demo/${TBL}`, T).catch(() => {});
await req('POST', `/api/connections/${mysql.id}/demo/tables`, T, {
  name: TBL, columns: [{ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }, { name: 'note', type: 'TEXT' }]
});

// insert: в аудите появляется добавленная строка
const ins = await req('POST', url, T, { row: { note: 'first' } });
check('insert ok', ins.status === 200, JSON.stringify(ins.body).slice(0, 60));
const row = ((await req('GET', `/api/connections/${mysql.id}/demo/${TBL}/rows?page=1&pageSize=5`, T)).body.rows ?? [])[0];
const filter = { id: row.id };

const auditOf = async (action) =>
  ((await req('GET', `/api/audit?connId=${mysql.id}&limit=80`, T)).body ?? []).find((a) => a.action === action);

const insAudit = await auditOf('row.insert');
check('insert audit has values', !!insAudit?.values?.after && insAudit.values.after.note === 'first', JSON.stringify(insAudit?.values).slice(0, 120));

// update: before и after
await req('PATCH', url, T, { filter, patch: { note: 'second' } });
const updAudit = await auditOf('row.update');
check('update audit has before', updAudit?.values?.before?.note === 'first', JSON.stringify(updAudit?.values?.before).slice(0, 100));
check('update audit has after', updAudit?.values?.after?.note === 'second', JSON.stringify(updAudit?.values?.after).slice(0, 100));
check('update audit keeps patch', JSON.stringify(updAudit?.values?.patch ?? {}) === JSON.stringify({ note: 'second' }), JSON.stringify(updAudit?.values?.patch));

// delete: удалённая строка
await req('DELETE', url, T, { filter });
const delAudit = await auditOf('row.delete');
check('delete audit has removed row', delAudit?.values?.before?.note === 'second', JSON.stringify(delAudit?.values?.before).slice(0, 100));

// обрезка: длинное значение не раздувает запись
await req('POST', url, T, { row: { note: 'x'.repeat(5000) } });
const longRow = ((await req('GET', `/api/connections/${mysql.id}/demo/${TBL}/rows?page=1&pageSize=5`, T)).body.rows ?? [])[0];
const longAudit = (await auditOf('row.insert'));
const stored = JSON.stringify(longAudit?.values ?? null);
check('long value is clipped', stored.length < 2000, `stored=${stored.length}`);
check('clipped audit says truncated or is short', stored.length < 2000, stored.slice(0, 80));
await req('DELETE', url, T, { filter: { id: longRow.id } }).catch(() => {});

// сырой valuesJson наружу не отдаётся, readonly по-прежнему не видит аудит
const raw = JSON.stringify((await req('GET', `/api/audit?connId=${mysql.id}&limit=5`, T)).body);
check('valuesJson not exposed', !raw.includes('valuesJson'), '');
check('readonly cannot read audit', (await req('GET', '/api/audit?limit=5', ro)).status === 403);
check('audit requires connId-less call ok', (await req('GET', '/api/audit?limit=5', T)).status === 200);

await req('DELETE', `/api/connections/${mysql.id}/demo/${TBL}`, T).catch(() => {});

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('AUDIT VALUES ALL GREEN');
