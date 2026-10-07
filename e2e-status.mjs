// E2E мониторинга: version/processlist/dbSizes по 4 СУБД.
const BASE = 'http://localhost:3001';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
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

async function cycle(key, c, want) {
  const s = await req('GET', `/api/connections/${c.id}/status`, T);
  check(`${key} version`, typeof s.version === 'string' && s.version.length > 2, s.version);
  check(`${key} dbsizes`, Array.isArray(s.dbSizes) && s.dbSizes.length > 0 && s.dbSizes.every((x) => typeof x.bytes === 'number'), JSON.stringify(s.dbSizes).slice(0, 120));
  check(`${key} proc`, Array.isArray(s.processlist), `n=${s.processlist.length}`);
  for (const [k, pred] of Object.entries(want)) check(`${key} ${k}`, pred(s), '');
}

await cycle('mysql', byName['e2e-mysql'], {
  demoDb: (s) => s.dbSizes.some((x) => x.db === 'demo' && x.bytes > 0),
  procCols: (s) => s.processlist.every((p) => p.id && p.command !== undefined),
  uptime: (s) => typeof s.uptimeSec === 'number' && s.uptimeSec > 0
});
await cycle('maria', byName['e2e-maria'], {
  demoDb: (s) => s.dbSizes.some((x) => x.db === 'demo')
});
await cycle('pg', byName['e2e-pg'], {
  demoDb: (s) => s.dbSizes.some((x) => x.db === 'demo' && x.bytes > 0)
});
await cycle('mongo', byName['e2e-mongo'], {
  demoDb: (s) => s.dbSizes.some((x) => x.db === 'demo'),
  uptime: (s) => typeof s.uptimeSec === 'number' && s.uptimeSec > 0
});
await cycle('sqlite', byName['e2e-sqlite'], {
  fileDb: (s) => s.dbSizes.some((x) => x.db === 'test.db' && x.bytes > 0),
  emptyProc: (s) => s.processlist.length === 0
});

// Недостижимый сервер — это 502, а не 500: иначе в консоли браузера ошибка
// выглядит как дефект панели, хотя это неверные настройки подключения.
{
  const dead = await req('POST', '/api/connections', T, {
    name: 'e2e-dead-host', kind: 'mysql', host: '127.0.0.1', port: 1, database: 'demo', user: 'root', password: 'x'
  });
  const status = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${T}` } });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  };
  const st = await status(`/api/connections/${dead.id}/status`);
  check('unreachable status is 502', st.status === 502, `status=${st.status}`);
  const du = await status(`/api/connections/${dead.id}/dbusers`);
  check('unreachable dbusers is 502', du.status === 502, `status=${du.status}`);
  // Текст 5xx намеренно обезличен обработчиком ошибок (никаких внутренних
  // сообщений драйвера в ответе) — поэтому проверяем только код ответа.
  check('unreachable body is generic', /internal server error/i.test(String(du.body.error ?? '')), String(du.body.error));
  await req('DELETE', `/api/connections/${dead.id}`, T);
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('STATUS ALL GREEN');
