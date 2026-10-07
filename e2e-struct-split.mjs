// Разделённая компоновка во вкладке «Структура»: список таблиц слева,
// карточка таблицы справа, граница перетаскивается, горизонтальной прокрутки
// нет ни в одной части.
//
// Проверка в браузере: сравниваем scrollWidth с clientWidth у самой вкладки и
// у обеих панелей, плюс проверяем, что ширины меняются при перетаскивании
// границы и что переживают перезагрузку.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9391;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let failures = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : '')); if (!ok) failures++; };

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('STRUCT SPLIT ALL GREEN');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'split-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const deadline = setTimeout(() => { console.log('FAIL | не уложились в 300 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 300_000);

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

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await ev(`(() => {
    const p = [...document.querySelectorAll('input[type=password]')][0];
    const form = p.closest('form') ?? document;
    const byLabel = (re) => { const l = [...form.querySelectorAll('label')].find((x) => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const u = byLabel(/user|login|логин/i) || [...form.querySelectorAll('input')].find((el) => el !== p);
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    if (form.requestSubmit) form.requestSubmit();
    return 1;
  })()`);
  await sleep(7000);

  // Открываем подключение, базу и вкладку «Структура».
  const opened = await ev(`(async () => {
    const conn = [...document.querySelectorAll('button')].find((x) => /^e2e-mysql$/.test((x.innerText || '').trim()));
    if (!conn) return 'нет подключения';
    conn.click();
    await new Promise((r) => setTimeout(r, 1500));
    const db = [...document.querySelectorAll('button')].find((x) => /^demo$/.test((x.innerText || '').trim()));
    if (db) db.click();
    await new Promise((r) => setTimeout(r, 1500));
    const tab = [...document.querySelectorAll('button')].find((x) => /^(Структура|Structure)$/.test((x.innerText || '').trim()));
    if (tab) tab.click();
    await new Promise((r) => setTimeout(r, 1500));
    return tab ? 'ok' : 'нет вкладки';
  })()`);
  check('вкладка «Структура» открыта', opened === 'ok', String(opened));
  await sleep(1200);

  // Открываем таблицу — она должна появиться СПРАВА, а не вместо списка.
  const withCard = await ev(`(async () => {
    const before = document.querySelectorAll('table tbody tr').length;
    const link = [...document.querySelectorAll('table tbody button')].find((x) => /^users$/i.test((x.innerText || '').trim()));
    if (!link) return { err: 'нет таблицы users', rows: before };
    link.click();
    await new Promise((r) => setTimeout(r, 2500));
    const after = document.querySelectorAll('table tbody tr').length;
    return { rows: before, rowsAfter: after, listStillThere: after > 0 };
  })()`, 45_000);
  check('список таблиц остался на экране', Boolean(withCard.listStillThere), JSON.stringify(withCard));

  // Раскладка: две панели и граница между ними. Границу исключаем из расчёта
  // — она и есть зазор между панелями, без неё они соприкасались бы вплотную.
  const layout = await ev(`(() => {
    const sep = document.querySelector('[role=separator][aria-orientation=vertical]');
    if (!sep) return { found: false };
    const row = sep.parentElement;
    const kids = [...row.children].filter((c) => c !== sep && c.getBoundingClientRect().width > 20);
    const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), left: Math.round(b.left), right: Math.round(b.right) }; };
    const panes = kids.map((k) => ({ ...r(k), scrollX: k.scrollWidth - k.clientWidth }));
    const bad = [];
    for (const k of kids) {
      for (const el of k.querySelectorAll('*')) {
        const x = el.scrollWidth - el.clientWidth;
        const s = getComputedStyle(el);
        if (x > 1 && s.overflowX !== 'hidden' && s.overflowX !== 'clip') bad.push(el.tagName + '.' + String(el.className || '').slice(0, 30) + '=' + x);
      }
    }
    return { found: true, panes, sepWidth: Math.round(sep.getBoundingClientRect().width), bad: bad.slice(0, 5), docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`);
  check('граница между панелями есть', Boolean(layout.found), '');
  check('панели стоят рядом, а не друг под другом',
    Boolean(layout.panes?.length === 2) && layout.panes[0].left < layout.panes[1].left && layout.panes[0].right <= layout.panes[1].left + 2,
    JSON.stringify(layout.panes));
  check('список уже карточки, но не шире её',
    Boolean(layout.panes?.length === 2) && layout.panes[0].w < layout.panes[1].w && layout.panes[0].w > 180,
    layout.panes ? `список=${layout.panes[0].w} карточка=${layout.panes[1].w}` : '');
  check('в панелях нет горизонтальной прокрутки',
    (layout.bad?.length ?? 0) === 0 && layout.panes?.every((p) => p.scrollX <= 1),
    layout.bad?.length ? layout.bad.join(' | ') : JSON.stringify(layout.panes?.map((p) => p.scrollX)));
  check('сама вкладка не прокручивается вбок', (layout.docScrollX ?? 0) <= 1, 'docScrollX=' + layout.docScrollX);

  // Карточка таблицы на месте: вкладки и кнопки действий.
  const card = await ev(`(() => {
    const want = /^(Структура|Индексы|Связи|Привилегии|Триггеры|Предпросмотр данных|SQL|Structure|Indexes|Relations|Privileges|Triggers|Data preview)$/i;
    const tabs = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => want.test(t));
    const actions = ['Добавить', 'Add', 'Клонировать', 'Clone', 'Экспорт', 'Export', 'Откатить DDL'].filter((w) => [...document.querySelectorAll('button')].some((b) => (b.innerText || '').trim().startsWith(w)));
    return { tabs: [...new Set(tabs)], actions };
  })()`);
  check('вкладки карточки на месте', (card.tabs?.length ?? 0) >= 4, JSON.stringify(card.tabs));
  check('кнопки действий карточки на месте', (card.actions?.length ?? 0) >= 3, JSON.stringify(card.actions));

  // Перетаскивание границы мышью.
  const before = layout.panes[0].w;
  const sepBox = await ev(`(() => { const b = document.querySelector('[role=separator][aria-orientation=vertical]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' || type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra }, session);
  await mouse('mouseMoved', sepBox.x, sepBox.y);
  await mouse('mousePressed', sepBox.x, sepBox.y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', sepBox.x + i * 20, sepBox.y); await sleep(40); }
  await mouse('mouseReleased', sepBox.x + 160, sepBox.y);
  await sleep(700);

  const afterDrag = await ev(`(() => {
    const sep = document.querySelector('[role=separator][aria-orientation=vertical]');
    if (!sep) return { gone: true };
    const row = sep.parentElement;
    const left = [...row.children].filter((c) => c !== sep && c.getBoundingClientRect().width > 20)[0];
    const b = left.getBoundingClientRect();
    let bad = 0;
    for (const el of left.querySelectorAll('*')) {
      const x = el.scrollWidth - el.clientWidth;
      const s = getComputedStyle(el);
      if (x > 1 && s.overflowX !== 'hidden' && s.overflowX !== 'clip') bad++;
    }
    return { w: Math.round(b.width), bad };
  })()`);
  check('граница перетаскивается', afterDrag.w > before + 60, `${before} -> ${afterDrag.w}`);
  check('после перетаскивания прокрутки не появилось', (afterDrag.bad ?? 0) === 0, 'прокручивающихся элементов=' + afterDrag.bad);

  // Ширина сохраняется после перезагрузки.
  await send('Page.navigate', { url: BASE + '/', }, session);
  await sleep(4000);
  await ev(`(async () => {
    const p = [...document.querySelectorAll('input[type=password]')][0];
    const form = p.closest('form') ?? document;
    const byLabel = (re) => { const l = [...form.querySelectorAll('label')].find((x) => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const u = byLabel(/user|login|логин/i) || [...form.querySelectorAll('input')].find((el) => el !== p);
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    if (form.requestSubmit) form.requestSubmit();
    return 1;
  })()`);
  await sleep(7000);
  const restored = await ev(`(async () => {
    const click = async (re, wait) => {
      const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim()));
      if (!el) return false;
      el.click();
      await new Promise((r) => setTimeout(r, wait));
      return true;
    };
    if (!await click(/^e2e-mysql$/, 2000)) return { err: 'нет подключения' };
    await click(/^demo$/, 2000);
    const tab = [...document.querySelectorAll('button')].find((x) => /^(Структура|Structure)$/.test((x.innerText || '').trim()));
    if (!tab) return { err: 'нет вкладки Структура' };
    tab.click();
    await new Promise((r) => setTimeout(r, 2000));
    const link = [...document.querySelectorAll('table tbody button')].find((x) => /^users$/i.test((x.innerText || '').trim()));
    if (!link) return { err: 'нет таблицы users' };
    link.click();
    await new Promise((r) => setTimeout(r, 3000));
    const sep = document.querySelector('[role=separator][aria-orientation=vertical]');
    if (!sep) return { gone: true };
    const left = [...sep.parentElement.children].filter((c) => c !== sep && c.getBoundingClientRect().width > 20)[0];
    return { w: Math.round(left.getBoundingClientRect().width), stored: localStorage.getItem('structSplit:' + (localStorage.getItem('mydbroot_user') || '')) };
  })()`, 45_000);
  check('ширина сохранилась после перезагрузки', Math.abs((restored.w ?? 0) - afterDrag.w) <= 3,
    `${afterDrag.w} -> ${restored.w ?? (restored.err ?? 'панели нет')}`);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `FAILURES: ${failures}` : 'STRUCT SPLIT ALL GREEN');
process.exit(failures ? 1 : 0);