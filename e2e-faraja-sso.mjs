// E2E: SSO-билеты Faraja (POST /api/auth/sso -> POST /api/auth/sso/exchange).
// Требует поднятый backend с FARAJA_SSO_SECRET (читается из backend/.env,
// перекрывается env FARAJA_SSO_SECRET). Без секрета проверяется только 404
// и тест завершается как SKIP-OK (SSO выключено штатно).
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3001';

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const { readFileSync, existsSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const here = dirname(fileURLToPath(import.meta.url));
let secret = (process.env.FARAJA_SSO_SECRET ?? '').trim();
if (!secret) {
  const p = join(here, 'backend', '.env');
  if (existsSync(p)) {
    for (const raw of readFileSync(p, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('FARAJA_SSO_SECRET=')) secret = line.slice('FARAJA_SSO_SECRET='.length).trim();
    }
  }
}
// ADMIN_USER для позитивного кейса (билет привязан к существующему юзеру).
let adminUser = (process.env.ADMIN_USER ?? '').trim();
if (!adminUser) {
  const p = join(here, 'backend', '.env');
  if (existsSync(p)) {
    for (const raw of readFileSync(p, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('ADMIN_USER=')) adminUser = line.slice('ADMIN_USER='.length).trim();
    }
  }
}
adminUser ||= 'admin';

if (!secret) {
  const r = await post('/api/auth/sso', { secret: 'x', username: adminUser });
  if (r.status !== 404) throw new Error(`SSO без секрета должен отвечать 404, а не ${r.status}`);
  console.log('E2E FARAJA-SSO SKIP-OK (FARAJA_SSO_SECRET не задан: SSO выключено, /sso -> 404)');
  process.exitCode = 0;
} else {
  // 1. Чужой секрет неотличим от отсутствующего маршрута.
  const wrong = await post('/api/auth/sso', { secret: 'wrong-secret', username: adminUser });
  if (wrong.status !== 404) throw new Error(`SSO с чужим секретом: ждали 404, получили ${wrong.status}`);
  // 2. Выпуск билета.
  const issued = await post('/api/auth/sso', { secret, username: adminUser });
  if (issued.status !== 200 || !issued.body.ticket) {
    throw new Error(`SSO выпуск: ждали 200+ticket, получили ${issued.status}: ${JSON.stringify(issued.body)}`);
  }
  // 3. Обмен билета на JWT.
  const ex = await post('/api/auth/sso/exchange', { ticket: issued.body.ticket });
  if (ex.status !== 200 || (!ex.body.token && !ex.body.tempToken)) {
    throw new Error(`SSO обмен: ждали 200+token, получили ${ex.status}: ${JSON.stringify(ex.body)}`);
  }
  if (ex.body.token) {
    const me = await fetch(BASE + '/api/auth/me', { headers: { authorization: `Bearer ${ex.body.token}` } });
    if (!me.ok) throw new Error(`SSO me: ждали 200, получили ${me.status}`);
  }
  // 4. Билет одноразовый: повторный обмен уже 401.
  const reuse = await post('/api/auth/sso/exchange', { ticket: issued.body.ticket });
  if (reuse.status !== 401) throw new Error(`SSO повтор: ждали 401, получили ${reuse.status}`);
  console.log('E2E FARAJA-SSO OK (wrong-secret 404, issue 200, exchange 200, reuse 401)');
}
