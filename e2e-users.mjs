// Idempotent E2E fixtures: the non-admin panel users that several suites
// (audit, backup, dbusers, design, grants, history, poolkill, rows) log in as.
// Without this, `npm run e2e:all` only works against a meta.db that already
// has them — on a fresh META_PATH (CI) every one of those suites 401s.
// Requires: backend up, REQUIRE_AUTH=1, admin credentials from ADMIN_USER/ADMIN_PASSWORD.
const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const FIXTURES = [
  { username: 'ro_user', password: 'readonly123', role: 'readonly' },
  { username: 'e2e_editor', password: 'editorpass123', role: 'editor' }
];

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
  return j;
}

const login = await req('POST', '/api/auth/login', null, { username: ADMIN_USER, password: ADMIN_PASSWORD });
const T = login.token;
const existing = new Set((await req('GET', '/api/auth/users', T)).map((u) => u.username));

let created = 0;
for (const f of FIXTURES) {
  if (existing.has(f.username)) { console.log(`have  ${f.username} (${f.role})`); continue; }
  await req('POST', '/api/auth/users', T, f);
  console.log(`made  ${f.username} (${f.role})`);
  created++;
}

// Prove the fixtures can actually authenticate — this is the failure mode the
// suites hit, so catching it here beats failing eight suites later.
for (const f of FIXTURES) {
  const r = await req('POST', '/api/auth/login', null, { username: f.username, password: f.password });
  if (r.user?.role !== f.role) throw new Error(`${f.username} has role ${r.user?.role}, expected ${f.role}`);
}
console.log(`E2E USERS OK (${created} created, ${FIXTURES.length} verified)`);
