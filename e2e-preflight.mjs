// Преflight перед e2e-прогоном: убедиться, что стенд отвечает, и не начинать
// наборы, если frontend или backend перезапускаются.
//
// Раньше при гонке «пересобрал контейнеры и сразу запустил e2e:all» набор падал
// с невнятным `TypeError: fetch failed` и ECONNREFUSED на :3001 — выглядело как
// падение приложения, хотя приложение было живо, просто ещё не поднялось.
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const API = process.env.E2E_API ?? 'http://127.0.0.1:3002';
const ATTEMPTS = 40;
const WAIT_MS = 750;

async function ping(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r.ok || r.status === 401 ? r.status : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let frontend = null;
let backend = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  frontend ??= await ping(BASE + '/');
  backend ??= await ping(API + '/api/status');
  if (frontend && backend) {
    console.log(`E2E PREFLIGHT OK (frontend ${frontend}, backend ${backend}, попыток ${attempt})`);
    // Без process.exit(): на Windows явный выход во время teardown сокета даёт
    // «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)» из libuv, и
    // оболочка показывает ошибку при успешном прогоне.
    process.exitCode = 0;
    break;
  }
  if (attempt % 8 === 0) console.log(`  ждём стенд (попытка ${attempt}): frontend=${frontend ?? 'нет'}, backend=${backend ?? 'нет'}`);
  await new Promise((r) => setTimeout(r, WAIT_MS));
}

if (frontend && backend) {
  // успех
} else {
  console.error([
    '',
    'E2E PREFLIGHT FAILED: стенд не отвечает.',
    `  frontend ${BASE} — ${frontend ?? 'не отвечает'}`,
    `  backend  ${API} — ${backend ?? 'не отвечает'}`,
    '  Поднимите стенд (docker compose up -d) и убедитесь, что контейнеры не перезапускаются:',
    '  пересборка контейнеров во время прогона рвёт соединения наборов.',
    ''
  ].join('\n'));
  process.exitCode = 1;
}
