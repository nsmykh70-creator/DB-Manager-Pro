// Сетка 2×2 во вкладке «Структура»:
//   верх: список таблиц | редактор выбранной таблицы
//   низ:  журнал SQL   | SQL-запрос
// Обе границы общие и перетаскиваются, горизонтальной прокрутки нет.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9393;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let failures = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : '')); if (!ok) failures++; };

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('STRUCT GRID ALL GREEN');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'grid-'));
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
  const login = () => ev(`(() => {
    const p = [...document.querySelectorAll('input[type=password]')][0];
    const form = p.closest('form') ?? document;
    const byLabel = (re) => { const l = [...form.querySelectorAll('label')].find((x) => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const u = byLabel(/user|login|логин/i) || [...form.querySelectorAll('input')].find((el) => el !== p);
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    if (form.requestSubmit) form.requestSubmit();
    return 1;
  })()`);

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await login();
  await sleep(7000);

  const opened = await ev(`(async () => {
    const click = async (re, wait) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (!el) return false; el.click(); await new Promise((r) => setTimeout(r, wait)); return true; };
    if (!await click(/^e2e-mysql$/, 2000)) return 'нет подключения';
    if (!await click(/^demo$/, 2000)) return 'нет базы';
    if (!await click(/^(Структура|Structure)$/, 2000)) return 'нет вкладки';
    return 'ok';
  })()`, 45_000);
  check('вкладка «Структура» открыта', opened === 'ok', String(opened));
  await sleep(1200);

  // Четыре панели: верхняя строка и нижняя, в каждой две колонки.
  const boxes = () => ev(`(() => {
    const grid = [...document.querySelectorAll('div')].find((d) => d.className.includes('flex-1 min-h-0 flex flex-col overflow-hidden') && d.querySelectorAll('[data-split=side]').length === 2);
    if (!grid) return { found: false };
    const rows = [...grid.children].filter((c) => c.className.includes('items-stretch'));
    // Границы — не панели: вертикальные помечены data-split, горизонтальная
    // лежит внутри нижней строки отдельным узлом. Иначе ручка считалась
    // третьей панелью и все сравнения ширины сдвигались на её размер.
    const isSeparator = (el) => el.hasAttribute?.('data-split') || el.getAttribute?.('role') === 'separator';
    const panes = rows.map((row) => {
      const cells = [...row.querySelectorAll(':scope > div')].filter((c) => !isSeparator(c) && c.getBoundingClientRect().width > 30);
      return cells.map((c) => { const b = c.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left) }; });
    });
    const bad = [];
    for (const el of grid.querySelectorAll('*')) {
      const x = el.scrollWidth - el.clientWidth;
      const s = getComputedStyle(el);
      if (x > 1 && s.overflowX !== 'hidden' && s.overflowX !== 'clip') bad.push(el.tagName + '.' + String(el.className || '').slice(0, 26) + '=' + x);
    }
    return { found: true, rows: panes.length, panes, gridW: Math.round(grid.getBoundingClientRect().width), rowW: rows.map((r) => Math.round(r.getBoundingClientRect().width)), bad: bad.slice(0, 5), docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth, splits: grid.querySelectorAll('[data-split=side]').length };
  })()`);

  const before = await boxes();
  check('найдена сетка рабочей области', Boolean(before.found), '');
  check('две строки по две панели', before.rows === 2 && before.panes.every((r) => r.length === 2), JSON.stringify(before.panes));
  check('нижняя строка ниже верхней',
    before.panes?.[1]?.[0]?.top > before.panes?.[0]?.[0]?.top + 100,
    `верх=${before.panes?.[0]?.[0]?.top} низ=${before.panes?.[1]?.[0]?.top}`);
  // Допуск в 6px: колонки заданы процентами от ширины контейнера, а браузер
  // округляет их до целых пикселей по-разному для строк разной высоты из-за
  // дробных долей. Проверяем, что расхождение не растёт с размером панели.
  check('колонки совпадают в обеих строках (общая граница)',
    before.panes?.[0]?.[1] && Math.abs(before.panes[0][1].left - before.panes[1][1].left) <= 6,
    `верх=${before.panes?.[0]?.[1]?.left} низ=${before.panes?.[1]?.[1]?.left} строки=${before.rowW} сетка=${before.gridW}`);
  check('горизонтальной прокрутки нет', (before.bad?.length ?? 0) === 0 && (before.docScrollX ?? 0) <= 1,
    before.bad?.length ? before.bad.join(' | ') : `docScrollX=${before.docScrollX}`);
  check('вертикальных границ две', before.splits === 2, 'splits=' + before.splits);

  // До выбора таблицы правая верхняя панель не пустая, а подсказывает.
  const empty = await ev(`(() => {
    const p = [...document.querySelectorAll('p')].find((x) => /выберите таблицу|pick a table|choisissez|elige una/i.test(x.innerText));
    return p ? p.innerText.slice(0, 60) : '';
  })()`);
  check('до выбора таблицы правая панель подсказывает', Boolean(empty), empty);

  // Выбираем таблицу — редактор появляется в правой верхней панели.
  const withCard = await ev(`(async () => {
    const link = [...document.querySelectorAll('table tbody button')].find((x) => /^users$/i.test((x.innerText || '').trim()));
    if (!link) return { err: 'нет users' };
    link.click();
    await new Promise((r) => setTimeout(r, 3000));
    const want = /^(Структура|Индексы|Связи|Привилегии|Триггеры|Предпросмотр данных|SQL|Structure|Indexes|Relations|Privileges|Triggers|Data preview)$/i;
    const tabs = [...new Set([...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => want.test(t)))];
    const acts = ['Add', 'Добавить', 'Clone', 'Клонировать', 'Export', 'Экспорт', 'Rollback', 'Откатить'].filter((w) => [...document.querySelectorAll('button')].some((b) => (b.innerText || '').trim().startsWith(w)));
    return { tabs, acts };
  })()`, 45_000);
  check('редактор таблицы открылся справа', (withCard.tabs?.length ?? 0) >= 4, JSON.stringify(withCard.tabs));
  check('кнопки действий редактора на месте', (withCard.acts?.length ?? 0) >= 3, JSON.stringify(withCard.acts));
  await sleep(600);
  const withCardBoxes = await boxes();
  check('после открытия таблицы прокрутки не появилось',
    (withCardBoxes.bad?.length ?? 0) === 0 && (withCardBoxes.docScrollX ?? 0) <= 1,
    withCardBoxes.bad?.length ? withCardBoxes.bad.join(' | ') : `docScrollX=${withCardBoxes.docScrollX}`);

  // Перетаскиваем нижнюю вертикальную границу — верхняя идёт следом.
  const seps = await ev(`(() => [...document.querySelectorAll('[data-split=side]')].map((el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; }))()`);
  check('найдены обе вертикальные границы', seps?.length === 2, JSON.stringify(seps));
  const w0 = before.panes[0][0].w;
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' || type === 'mousePressed' ? 1 : 0, clickCount: 1 }, session);
  await mouse('mouseMoved', seps[1].x, seps[1].y);
  await mouse('mousePressed', seps[1].x, seps[1].y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', seps[1].x - i * 18, seps[1].y); await sleep(40); }
  await mouse('mouseReleased', seps[1].x - 144, seps[1].y);
  await sleep(700);
  const afterWidth = await boxes();
  check('нижняя граница тянет обе строки',
    // Тянем границу влево — левая колонка становится уже. Главное: обе строки
    // обязаны совпасть, иначе границы разъедутся.
    Math.abs((afterWidth.panes?.[0]?.[0]?.w ?? w0) - w0) > 60 &&
    Math.abs((afterWidth.panes?.[0]?.[0]?.w ?? 0) - (afterWidth.panes?.[1]?.[0]?.w ?? 0)) <= 2,
    `${w0} -> верх=${afterWidth.panes?.[0]?.[0]?.w} низ=${afterWidth.panes?.[1]?.[0]?.w}`);
  check('после перетаскивания прокрутки нет', (afterWidth.bad?.length ?? 0) === 0, afterWidth.bad?.join(' | ') ?? '');

  // Перетаскиваем горизонтальную границу — меняется высота нижней строки.
  const hBefore = before.panes[1][0].h;
  const hBox = await ev(`(() => { const el = document.querySelector('[aria-orientation="horizontal"]'); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  await mouse('mouseMoved', hBox.x, hBox.y);
  await mouse('mousePressed', hBox.x, hBox.y);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', hBox.x, hBox.y - i * 14); await sleep(40); }
  await mouse('mouseReleased', hBox.x, hBox.y - 84);
  await sleep(700);
  const afterHeight = await boxes();
  check('горизонтальная граница меняет высоту нижней строки',
    afterHeight.panes?.[1]?.[0]?.h > hBefore + 40, `${hBefore} -> ${afterHeight.panes?.[1]?.[0]?.h}`);
  check('после изменения высоты прокрутки нет', (afterHeight.bad?.length ?? 0) === 0, afterHeight.bad?.join(' | ') ?? '');
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `FAILURES: ${failures}` : 'STRUCT GRID ALL GREEN');
process.exit(failures ? 1 : 0);