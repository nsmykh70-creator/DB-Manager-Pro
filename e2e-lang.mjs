// E2E локализации: надписи, зашитые в коде, не переключаются вместе с языком.
// Проверка через API этого не видит — интерфейс она не исполняет, а именно
// интерфейс показывает пользователю «Подключения» вместо «Connections».
//
// Набор проверяет оба направления:
//   - в русском режиме зашитые надписи на месте (значит, мы не вырезали их
//     из интерфейса вместе с переводом);
//   - после выбора английского русских надписей не осталось, английские есть.
//
// Так поймается и регресс «забыли обернуть в t()», и поломка самого
// переключателя языка.
//
// Управляем Chrome через DevTools Protocol: в Node есть встроенный WebSocket,
// поэтому ни puppeteer, ни playwright ставить не нужно. Если Chrome не найден —
// набор пропускает себя, а не падает.
//
// Запуск:  node e2e-lang.mjs        (нужен ADMIN_PASSWORD, как у остальных)
// Требования: поднятый стенд (docker compose up -d).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const USER = process.env.E2E_USER ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = Number(process.env.E2E_CDP_PORT ?? 9334);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_PATH ?? ''
].filter(Boolean);

if (!PASSWORD) {
  console.log('SKIP e2e-lang | не задан ADMIN_PASSWORD: для входа в интерфейс нужен пароль');
  process.exit(0);
}
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) {
  console.log('SKIP e2e-lang | не найден Chrome: негде проверять интерфейс');
  process.exit(0);
}

// Надписи, которые раньше были зашиты в JSX и потому не переключались.
// Проверяем их в двух режимах: русском (подпись должна быть на месте) и
// английском (русской подписи быть не должно, английская должна быть).
const WAS_RUSSIAN = [
  'Подключения', 'Новое подключение', 'Модели проекта', 'Обновить', 'Назад',
  'Пользователь', 'Пароль', 'Название', 'Скрыть', 'Повторить', 'Сохранить', 'Отмена'
];
const ENGLISH_MARKERS = /Connections|New connection|Project models|Refresh|Back|Password|Save|Cancel/;

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-lang-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const evaluate = async expression =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session))
      .result?.result?.value;

  const words = JSON.stringify(WAS_RUSSIAN);
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
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(user, ${JSON.stringify(USER)});
    set(pass, ${JSON.stringify(PASSWORD)});
    const form = pass.closest('form');
    if (form) form.requestSubmit();
    else pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  if (!loggedIn) throw new Error('не нашли поля входа');
  await sleep(5000);

  // По умолчанию интерфейс английский — проверяем это первым делом, иначе
  // «русские надписи ушли» прошла бы просто потому, что их и не было.
  const initial = await evaluate(`(() => {
    const body = document.body.innerText || '';
    return {
      russian: ${words}.filter(w => body.includes(w)),
      english: new RegExp(${JSON.stringify(ENGLISH_MARKERS.source)}).test(body)
    };
  })()`);
  check('по умолчанию английский', initial?.english === true && (initial?.russian?.length ?? 0) === 0,
    `русских подписей: ${(initial?.russian ?? []).join(', ') || 'нет'}`);

  const opened = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Language|Язык/i.test(x.getAttribute('title') || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(800);
  const picked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^(Русский|Russian)$/i.test((x.innerText || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('язык переключается на русский', opened === true && picked === true);
  await sleep(1500);

  const after = await evaluate(`(() => {
    const body = document.body.innerText || '';
    return {
      left: ${words}.filter(w => body.includes(w)),
      english: new RegExp(${JSON.stringify(ENGLISH_MARKERS.source)}).test(body)
    };
  })()`);
  check('после переключения надписи на русском', (after?.left?.length ?? 0) >= 3,
    `найдено: ${(after?.left ?? []).join(', ')}`);
  check('английские надписи ушли вместе с языком', after?.english === false);

  // Выбор должен пережить перезагрузку, иначе язык слетает каждый раз.
  await send('Page.reload', {}, session);
  await sleep(4000);
  const afterReload = await evaluate(`(() => {
    const body = document.body.innerText || '';
    return { russian: ${words}.filter(w => body.includes(w)) };
  })()`);
  check('выбор языка переживает перезагрузку', (afterReload?.russian?.length ?? 0) >= 3,
    `найдено: ${(afterReload?.russian ?? []).join(', ')}`);
} catch (e) {
  console.log('FAIL прервано | ' + e.message);
  results.push(false);
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль мог остаться заблокированным */ }
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nE2E LANG: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nE2E LANG ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);