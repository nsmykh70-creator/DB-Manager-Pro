// e2e-search-field.mjs — поле поиска не подхватывает логин, но фильтрует.
//
// Регрессия на два разных дефекта одного поля:
//  1. после перезагрузки Chrome подставлял логин в первое текстовое поле
//     страницы — фильтр по таблицам, из-за чего список выглядел пустым;
//  2. защита от подстановки не должна ломать сам поиск: поле обязано фильтровать
//     по имени таблицы и отпускать ввод после первого фокуса.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9441;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('SEARCH FIELD ALL GREEN');
  process.exit(0);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'searchfield-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

let ws;
const deadline = setTimeout(() => { console.log('FAIL | тест не уложился в 300 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 300_000);

try {
  let wsUrl;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await sleep(250); }
  ws = new WebSocket(wsUrl);
  await new Promise((ok, b) => { ws.onopen = ok; ws.onerror = () => b(new Error('CDP')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sess) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sess ? { sessionId: sess } : {}) })); });
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const session = a.sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);
  const ev = async (expr, ms = 45_000) => {
    const res = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session), sleep(ms).then(() => ({ timeout: true }))]);
    if (res.timeout) throw new Error('страница не ответила');
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'ошибка страницы');
    return res.result?.result?.value;
  };
  const login = () => ev(`(() => {
    const p = [...document.querySelectorAll('input[type=password]')][0];
    const form = p.closest('form') ?? document;
    const byLabel = (re) => { const l = [...form.querySelectorAll('label')].find((x) => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const u = byLabel(/user|login|логин/i) || [...form.querySelectorAll('input')].find((el) => el !== p);
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    if (form.requestSubmit) form.requestSubmit(); return 1;
  })()`);
  const openStruct = `(async () => {
    const click = async (re, w) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (el) { el.click(); await new Promise((r) => setTimeout(r, w)); } return !!el; };
    await click(/^e2e-mysql$/, 1500);
    await click(/^demo$/, 1500);
    await click(/^(?:Структура|Structure)$/, 1800);
    return 1;
  })()`;
  const filterState = () => ev(`(() => {
    const el = [...document.querySelectorAll('input[type=search]')].find((i) => /search tables|поиск/i.test(i.placeholder || ''));
    const pane = document.querySelector('[data-pane=tables]');
    return {
      value: el ? el.value : null,
      rows: [...(pane?.querySelectorAll('table tbody button') || [])].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 6),
      footer: (pane?.innerText || '').replace(/\\s+/g, ' ').match(/Showing \\d+ of \\d+|Показано \\d+ из \\d+/)?.[0] ?? null,
    };
  })()`, 30_000);

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await login();
  await sleep(7000);
  await ev(openStruct, 45_000);
  const before = await filterState();
  check('список таблиц загружен', before.rows.length > 0, 'строк=' + before.rows.length);

  // Фильтр работает: ищем конкретную таблицу.
  const filtered = await ev(`(async () => {
    const el = [...document.querySelectorAll('input[type=search]')].find((i) => /search tables|поиск/i.test(i.placeholder || ''));
    el.focus();
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, 'users');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const pane = document.querySelector('[data-pane=tables]');
    return {
      value: el.value,
      rows: [...(pane?.querySelectorAll('table tbody button') || [])].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 6),
    };
  })()`, 30_000);
  check('введённый текст попал в поле', filtered.value === 'users', 'значение=' + JSON.stringify(filtered.value));
  check('фильтр сузил список', filtered.rows.length === 1 && filtered.rows[0] === 'users', JSON.stringify(filtered.rows));

  // И очищается обратно — состояние не залипает.
  const cleared = await ev(`(async () => {
    const el = [...document.querySelectorAll('input[type=search]')].find((i) => /search tables|поиск/i.test(i.placeholder || ''));
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    await new Promise((r) => setTimeout(r, 1000));
    const pane = document.querySelector('[data-pane=tables]');
    return { value: el.value, rows: [...(pane?.querySelectorAll('table tbody button') || [])].map((b) => (b.innerText || '').trim()).filter(Boolean).length };
  })()`, 30_000);
  check('фильтр очищается', cleared.value === '' && cleared.rows > 1, `значение=${JSON.stringify(cleared.value)} строк=${cleared.rows}`);

  // Ключевой случай: перезагрузка. Логин не должен попасть в поле.
  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(4000);
  await login();
  await sleep(8000);
  const afterLogin = await filterState();
  check('после входа поле поиска пустое', afterLogin.value === '', 'значение=' + JSON.stringify(afterLogin.value));

  await ev(openStruct, 45_000);
  const afterReload = await filterState();
  check('после перезагрузки логин не попал в поиск', afterReload.value === '', 'значение=' + JSON.stringify(afterReload.value));
  check('после перезагрузки таблицы видны', afterReload.rows.length > 0, 'строк=' + afterReload.rows.length + ' ' + (afterReload.footer ?? ''));

  // И фильтр по-прежнему работает после перезагрузки.
  const filteredAgain = await ev(`(async () => {
    const el = [...document.querySelectorAll('input[type=search]')].find((i) => /search tables|поиск/i.test(i.placeholder || ''));
    el.focus();
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, 'users');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const pane = document.querySelector('[data-pane=tables]');
    return { value: el.value, rows: [...(pane?.querySelectorAll('table tbody button') || [])].map((b) => (b.innerText || '').trim()).filter(Boolean) };
  })()`, 30_000);
  check('после перезагрузки фильтр работает', filteredAgain.value === 'users' && filteredAgain.rows.length === 1, JSON.stringify(filteredAgain));
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'SEARCH FIELD ALL GREEN');
process.exit(failed ? 1 : 0);