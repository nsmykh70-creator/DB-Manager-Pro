// E2E тумблеров типов СУБД в настройках.
//
// Проверяем три вещи, которые ломаются по-разному:
//   1. API: PUT /api/settings сохраняет enabledKinds и отсекает мусор;
//   2. пустой список и отсутствие поля значат «все типы включены» — иначе
//      панель, обновлённая после этой настройки, молча спрятала бы всё;
//   3. не-админ не может переключать (403), а админ может.
//
// Браузерную часть (панели действительно скрывают группы) проверяет
// e2e-browser: там тумблеры щёлкаются вживую.
//
// В конце настройка возвращается к «все включены», чтобы не сломать другие
// наборы.
//
// Запуск:  node e2e-kinds.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const API = process.env.E2E_API || 'http://127.0.0.1:3002';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EDITOR_PASSWORD = process.env.E2E_EDITOR_PASSWORD || 'editorpass123';

const ALL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'];

if (!ADMIN_PASSWORD) {
  console.log('SKIP e2e-kinds | не задан ADMIN_PASSWORD: для проверки настроек нужен вход админа');
  process.exit(0);
}

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

const login = await req('POST', '/api/auth/login', null, { username: ADMIN_USER, password: ADMIN_PASSWORD });
if (login.status !== 200) {
  console.log(`FAIL вход админа не удался | ${login.status}`);
  process.exit(1);
}
const token = login.body.token;

// Исходные настройки — вернём их в конце, чтобы набор был идемпотентным.
const original = (await req('GET', '/api/settings', token)).body;
console.log(`исходные enabledKinds: ${JSON.stringify(original.enabledKinds)}`);
// Приводим стенд к «все включены»: проверки ниже не должны зависеть от того,
// что оставил предыдущий прогон.
await req('PUT', '/api/settings', token, { ...original, enabledKinds: [...ALL] });

try {
  // 1. Настройка, записанная до появления этой функции (без enabledKinds),
  //    должна означать «все типы включены» — иначе обновлённая панель молча
  //    спрятала бы все подключения.
  const noField = { ...original };
  delete noField.enabledKinds;
  const withoutField = await req('PUT', '/api/settings', token, noField);
  check('без поля enabledKinds включаются все типы',
    Array.isArray(withoutField.body.enabledKinds) && withoutField.body.enabledKinds.length === ALL.length,
    `получено: ${JSON.stringify(withoutField.body.enabledKinds)}`);

  // 2. Сохранение подмножества идёт в порядке ALL, а не в порядке запроса.
  // Неизвестным считаем тип, которого нет и не будет: 'oracle' стал настоящим,
  // поэтому раньше он годился как «мусор», а теперь это полноценный тип.
  const subset = ['redis', 'mysql', 'mssql', 'redis'];
  const saved = await req('PUT', '/api/settings', token, { ...original, enabledKinds: subset });
  check('сохраняются только известные типы без дублей',
    JSON.stringify(saved.body.enabledKinds) === JSON.stringify(['mysql', 'redis']),
    `получено: ${JSON.stringify(saved.body.enabledKinds)}`);

  const reread = await req('GET', '/api/settings', token);
  check('настройка перечитывается с сервера',
    JSON.stringify(reread.body.enabledKinds) === JSON.stringify(['mysql', 'redis']),
    `получено: ${JSON.stringify(reread.body.enabledKinds)}`);

  // 3. postgresql из фронта нормализуется в postgres — иначе фильтр боковых
  //    панелей молча ничего не спрятал бы.
  const normalized = await req('PUT', '/api/settings', token, { ...original, enabledKinds: ['postgresql', 'mongodb'] });
  check('postgresql нормализуется в postgres',
    JSON.stringify(normalized.body.enabledKinds) === JSON.stringify(['postgres', 'mongodb']),
    `получено: ${JSON.stringify(normalized.body.enabledKinds)}`);

  // 4. Пустой массив — осознанное «всё выключено»: сервер хранит как есть,
  //    а фронт трактует пустой список как «все включены» (см. engineKinds.ts).
  const empty = await req('PUT', '/api/settings', token, { ...original, enabledKinds: [] });
  check('пустой список сохраняется как есть', Array.isArray(empty.body.enabledKinds) && empty.body.enabledKinds.length === 0,
    `получено: ${JSON.stringify(empty.body.enabledKinds)}`);

  // 5. Мусор и не-массив не ломают ответ.
  const junk = await req('PUT', '/api/settings', token, { ...original, enabledKinds: 'mysql' });
  check('не-массив приводится к полному списку', Array.isArray(junk.body.enabledKinds) && junk.body.enabledKinds.length === ALL.length,
    `получено: ${JSON.stringify(junk.body.enabledKinds)}`);

  // 6. Права: переключать может только админ.
  const editorLogin = await req('POST', '/api/auth/login', null, { username: 'e2e_editor', password: EDITOR_PASSWORD });
  if (editorLogin.status !== 200) {
    console.log('SKIP проверка прав | не удалось войти как e2e_editor (сначала npm run seed:e2e-users)');
  } else {
    const denied = await req('PUT', '/api/settings', editorLogin.body.token, { ...original, enabledKinds: ['mysql'] });
    check('не-админ не может переключать типы', denied.status === 403, `статус ${denied.status}`);
    const anon = await req('PUT', '/api/settings', null, { ...original, enabledKinds: ['mysql'] });
    check('без токена настройка недоступна', anon.status === 401, `статус ${anon.status}`);
  }
} catch (e) {
  console.log('FAIL прервано | ' + e.message);
  results.push(false);
} finally {
  // Возвращаем настройку: иначе следующий набор увидит панель без типов.
  const restore = await req('PUT', '/api/settings', token, { ...original, enabledKinds: original.enabledKinds ?? [...ALL] });
  console.log(`настройка возвращена: ${JSON.stringify(restore.body.enabledKinds)}`);
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nE2E KINDS: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nE2E KINDS ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);