// Браузерная проверка тумблеров типов СУБД: щёлкаем тумблер, смотрим, что
// группа подключений этого типа исчезла из боковой панели, и возвращаем всё
// обратно.
//
// API-часть (сохранение, нормализация, права) проверяет e2e-kinds; здесь
// важно другое — что переключатель действительно влияет на отрисовку.
//
// Запуск:  node e2e-kinds-browser.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const USER = process.env.E2E_USER ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = Number(process.env.E2E_CDP_PORT ?? 9335);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_PATH ?? ''
].filter(Boolean);

if (!PASSWORD) {
  console.log('SKIP e2e-kinds-browser | не задан ADMIN_PASSWORD: нужен вход в интерфейс');
  process.exit(0);
}
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) {
  console.log('SKIP e2e-kinds-browser | не найден Chrome: негде проверять интерфейс');
  process.exit(0);
}

const ALL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'];
// Заголовок группы в боковой панели — это ПРОДУКТОВОЕ название («MySQL»),
// а не идентификатор типа из API («mysql»), поэтому сравниваем по названиям.
const ALL_LABELS = ['MySQL', 'MariaDB', 'PostgreSQL', 'SQLite', 'MongoDB', 'Redis', 'Oracle'];
const API = process.env.E2E_API ?? 'http://127.0.0.1:3002';

async function api(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers, body: payload });
  return r.json().catch(() => ({}));
}
const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Состояние стенда приводим к «все типы включены» и запоминаем исходное:
// иначе прогон, оборванный на середине, оставил бы панель без типа, и следующий
// набор упал бы не из-за своих ошибок.
const session0 = await api('POST', '/api/auth/login', null, { username: USER, password: PASSWORD });
const adminToken = session0.token;
if (!adminToken) {
  console.log('SKIP e2e-kinds-browser | не удалось войти админом');
  process.exit(0);
}
const originalKinds = (await api('GET', '/api/settings', adminToken)).enabledKinds ?? [...ALL];
await api('PUT', '/api/settings', adminToken, { ...(await api('GET', '/api/settings', adminToken)), enabledKinds: [...ALL] });
console.log(`исходные enabledKinds: ${JSON.stringify(originalKinds)} → для прогона: все`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-kinds-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'
], { stdio: 'ignore' });

let ws;
try {
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* Chrome ещё не слушает порт */ }
    await sleep(500);
  }
  if (!wsUrl) throw new Error('Chrome не поднялся');

  ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP не ответил')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, session) =>
    new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: session })); });

  const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);
  // Без exceptionDetails ошибка внутри страницы выглядит как «вернулось
  // undefined» — тогда непонятно, чинить выражение или интерфейс.
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (res.result?.exceptionDetails) {
      const d = res.result.exceptionDetails;
      throw new Error('ошибка в странице: ' + (d.exception?.description ?? d.text));
    }
    return res.result?.result?.value;
  };

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);

  const loggedIn = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('label')];
    const byLabel = re => {
      const l = labels.find(x => re.test(x.innerText || ''));
      return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null;
    };
    const user = byLabel(/пользователь|логин|user|name/i);
    const pass = byLabel(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
    if (!user || !pass) return false;
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(user, ${JSON.stringify(USER)});
    set(pass, ${JSON.stringify(PASSWORD)});
    const form = pass.closest('form');
    if (form) form.requestSubmit();
    return true;
  })()`);
  if (!loggedIn) throw new Error('не нашли поля входа');
  await sleep(5000);

  // Открываем настройки: кнопка с иконкой шестерёнки в шапке.
  const opened = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const b = buttons.find(x => /settings|настрой/i.test(x.getAttribute('title') || ''))
      || buttons.find(x => /settings|настрой/i.test((x.innerText || '').trim()));
    if (!b) return { ok: false, есть: buttons.map(x => x.getAttribute('title') || '').filter(Boolean).slice(0, 20) };
    b.click();
    return { ok: true };
  })()`);
  check('настройки открываются', opened?.ok === true,
    opened?.ok === false ? `кнопки: ${JSON.stringify(opened?.есть)}` : '');
  await sleep(2500);

  // Находим тумблеры: это кнопки с role="switch".
  const toggles = await evaluate(`(() => {
    const sw = [...document.querySelectorAll('[role="switch"]')];
    return { всего: sw.length, подписи: sw.map(x => x.getAttribute('aria-label')), включено: sw.map(x => x.getAttribute('aria-checked')) };
  })()`);
  check('тумблеры типов БД на месте', (toggles?.всего ?? 0) === ALL.length,
    `найдено: ${toggles?.всего} → ${JSON.stringify(toggles?.подписи)}`);
  check('по умолчанию все типы включены', (toggles?.включено ?? []).every(v => v === 'true'),
    JSON.stringify(toggles?.включено));

  // Группы подключений в боковой панели до переключения. Проверяем именно
  // заголовки групп (span.font-medium с именем СУБД): слово «Redis» ещё есть в
  // подписи активного подключения, и по всему body судить нельзя.
  const groupHeaders = `(() => [...document.querySelectorAll('span.font-medium')]
    .map(x => (x.innerText || '').trim())
    .filter(t => new RegExp('^(' + ${JSON.stringify(ALL_LABELS)}.join('|') + ')$').test(t)))`;

  const before = await evaluate(groupHeaders + `()`);
  check('все группы типов видны до переключения', (before?.length ?? 0) === ALL_LABELS.length,
    `групп: ${JSON.stringify(before)}`);

  // Выключаем Redis и сохраняем.
  const toggled = await evaluate(`(() => {
    const sw = [...document.querySelectorAll('[role="switch"]')];
    const redis = sw.find(x => /redis/i.test(x.getAttribute('aria-label') || ''));
    if (!redis) return { ok: false };
    redis.click();
    return { ok: true, состояние: redis.getAttribute('aria-checked') };
  })()`);
  check('тумблер переключается', toggled?.ok === true, `aria-checked=${toggled?.состояние}`);
  await sleep(400);

  const saved = await evaluate(`(() => {
    // Кнопка «Сохранить» есть и в основном интерфейсе, поэтому ищем её внутри
    // окна настроек: тумблеры типов БД бывают только здесь.
    const modal = [...document.querySelectorAll('div.fixed.inset-0')].find(el => el.querySelector('[role="switch"]'));
    if (!modal) return { ok: false, почему: 'окно настроек не найдено' };
    const b = [...modal.querySelectorAll('button')].find(x => /save|сохранить|保存|enregistrer|guardar|speichern/i.test((x.innerText || '').trim()));
    if (!b) return { ok: false, почему: 'кнопка сохранения не найдена' };
    b.click();
    return { ok: true };
  })()`);
  check('настройки сохраняются', saved?.ok === true);
  await sleep(2500);

  const after = await evaluate(groupHeaders + `()`);
  check('выключенный тип исчез из боковой панели', !(after ?? []).includes('Redis'),
    `групп после: ${JSON.stringify(after)}`);
  check('включённые типы остались', ['MySQL', 'SQLite'].every(k => (after ?? []).includes(k)));

  // Возвращаем Redis через интерфейс — это и есть проверка обратного пути.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /settings|настрой/i.test(x.getAttribute('title') || '') || /settings|настрой/i.test((x.innerText || '').trim()));
    if (b) b.click();
    return 1;
  })()`);
  await sleep(2000);
  await evaluate(`(() => {
    const sw = [...document.querySelectorAll('[role="switch"]')];
    const redis = sw.find(x => /redis/i.test(x.getAttribute('aria-label') || ''));
    if (redis) redis.click();
    return 1;
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const modal = [...document.querySelectorAll('div.fixed.inset-0')].find(el => el.querySelector('[role="switch"]'));
    const b = modal && [...modal.querySelectorAll('button')].find(x => /save|сохранить|保存|enregistrer|guardar|speichern/i.test((x.innerText || '').trim()));
    if (b) b.click();
    return 1;
  })()`);
  await sleep(2500);
  const restored = await evaluate(groupHeaders + `()`);
  check('настройка возвращена интерфейсом', (restored ?? []).length === ALL_LABELS.length, `групп: ${JSON.stringify(restored)}`);
} catch (e) {
  console.log('FAIL прервано | ' + e.message);
  results.push(false);
} finally {
  // Возврат через API: он срабатывает даже если прогон упал на середине, иначе
  // панель осталась бы без типа и следующий набор падал бы из-за чужой ошибки.
  try {
    const current = await api('GET', '/api/settings', adminToken);
    await api('PUT', '/api/settings', adminToken, { ...current, enabledKinds: originalKinds });
    console.log(`настройка возвращена через API: ${JSON.stringify(originalKinds)}`);
  } catch (e) {
    console.log('FAIL не удалось вернуть настройку | ' + e.message);
    results.push(false);
  }
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль мог остаться заблокированным */ }
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nE2E KINDS BROWSER: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nE2E KINDS BROWSER ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);