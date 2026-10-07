// E2E DB users: list/create/drop + validation + RBAC.
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

async function cycle(key, c, expectUser) {
  const list1 = await req('GET', `/api/connections/${c.id}/dbusers`, T);
  if (key === 'mongo') check(`${key} list`, Array.isArray(list1), `found ${list1.map((u)=>u.username).join(',')}`);
  else check(`${key} list`, Array.isArray(list1) && list1.some((u) => u.username === expectUser), `found ${list1.map((u)=>u.username).join(',')}`);
  const tmp = 'e2e_' + key + '_' + Math.floor(Math.random()*10000);
  await req('POST', `/api/connections/${c.id}/dbusers`, T, { username: tmp, password: 'Password123', db: c.kind==='mongodb'?'demo':undefined });
  const list2 = await req('GET', `/api/connections/${c.id}/dbusers`, T);
  check(`${key} create`, list2.some((u)=>u.username===tmp), tmp);
  // duplicate should fail (already exists)
  try { await req('POST', `/api/connections/${c.id}/dbusers`, T, { username: tmp, password: 'Password123' }); check(`${key} dup`, false); } catch(e){ check(`${key} dup`, e.status===500 || e.status===400, `status=${e.status}`); }
  // bad name
  try { await req('POST', `/api/connections/${c.id}/dbusers`, T, { username: 'a`b', password: 'Password123' }); check(`${key} bad name`, false); } catch(e){ check(`${key} bad name`, e.status===400, `status=${e.status}`); }
  // short pw
  try { await req('POST', `/api/connections/${c.id}/dbusers`, T, { username: tmp+'2', password: 'short' }); check(`${key} short pw`, false); } catch(e){ check(`${key} short pw`, e.status===400, `status=${e.status}`); }
  // drop
  const q = c.kind==='mongodb' ? `?db=demo` : '';
  await req('DELETE', `/api/connections/${c.id}/dbusers/${tmp}${q}`, T);
  const list3 = await req('GET', `/api/connections/${c.id}/dbusers`, T);
  check(`${key} drop`, !list3.some((u)=>u.username===tmp), '');
}

await cycle('mysql', byName['e2e-mysql'], 'root');
await cycle('maria', byName['e2e-maria'], 'root');
await cycle('pg', byName['e2e-pg'], 'root');
await cycle('mongo', byName['e2e-mongo'], 'demo');

// sqlite
{
  const c = byName['e2e-sqlite'];
  const l = await req('GET', `/api/connections/${c.id}/dbusers`, T);
  check('sqlite list empty', Array.isArray(l) && l.length===0, `len=${l.length}`);
  try { await req('POST', `/api/connections/${c.id}/dbusers`, T, { username: 'x', password: 'Password123' }); check('sqlite create rejected', false); } catch(e){ check('sqlite create rejected', e.status===400, `status=${e.status}`); }
}

// RBAC: readonly blocked, editor blocked
{
  const ro = await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' });
  const RH = ro.token;
  try { await req('POST', `/api/connections/${byName['e2e-mysql'].id}/dbusers`, RH, { username: 'ro_test', password: 'Password123' }); check('ro blocked', false); } catch(e){ check('ro blocked', e.status===403, `status=${e.status}`); }
  // editor: create a temp editor user if not exists, test blocked
  // ensure editor user exists
  try { await req('POST', '/api/auth/users', T, { username: 'e2e_editor', password: 'editorpass123', role: 'editor' }); } catch{}
  const ed = await req('POST', '/api/auth/login', null, { username: 'e2e_editor', password: 'editorpass123' });
  try { await req('POST', `/api/connections/${byName['e2e-mysql'].id}/dbusers`, ed.token, { username: 'ed_test', password: 'Password123' }); check('editor blocked', false); } catch(e){ check('editor blocked', e.status===403, `status=${e.status}`); }
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('DBUSERS ALL GREEN');
