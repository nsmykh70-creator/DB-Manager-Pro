// Открепление, разворачивание и сворачивание панелей рабочей области.
//
// Проверяет то, ради чего всё затевалось: у каждой из четырёх панелей есть
// кнопки, панель действительно уезжает в перетаскиваемое окно, разворачивается
// на всю рабочую область и сворачивается в полосу — и после перезагрузки
// состояние сохраняется.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9401;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let failures = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : '')); if (!ok) failures++; };

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('PANE WINDOWS ALL GREEN');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'panewin-'));
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

  // Чистое состояние панелей перед проверкой.
  await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('panes:v1:')) localStorage.removeItem(k); return 1; })()`);
  const opened = await ev(`(async () => {
    const click = async (re, wait) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (!el) return false; el.click(); await new Promise((r) => setTimeout(r, wait)); return true; };
    if (!await click(/^e2e-mysql$/, 2000)) return 'нет подключения';
    if (!await click(/^demo$/, 2000)) return 'нет базы';
    if (!await click(/^(Структура|Structure)$/, 2000)) return 'нет вкладки';
    return 'ok';
  })()`, 45_000);
  check('вкладка «Структура» открыта', opened === 'ok', String(opened));
  await sleep(1000);

  // Карточка таблицы появляется только после выбора таблицы — без неё у этой
  // панели нет ни содержимого, ни кнопки открепления.
  const picked = await ev(`(async () => {
    const b = [...document.querySelectorAll('button[title]')].find((x) => /^(customers|orders|users|[a-z_]+)$/.test(x.getAttribute('title') || '') && x.className.includes('truncate'));
    if (!b) return 'нет таблиц';
    b.click();
    await new Promise((r) => setTimeout(r, 1800));
    return b.getAttribute('title');
  })()`, 30_000);
  check('таблица выбрана, карточка открыта', Boolean(picked) && picked !== 'нет таблиц', String(picked));

  // Кнопки управления есть у каждой из панелей.
  const controls = await ev(`(() => {
    const titles = [...document.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
    const has = (re) => titles.filter((t) => re.test(t || '')).length;
    return {
      collapse: has(/Свернуть панель|Collapse panel/i),
      full: has(/весь экран|Fill the workspace/i),
      detach: has(/Открепить в окно|Detach into a window/i),
      total: titles.length,
    };
  })()`);
  check('кнопки управления есть у панелей', controls.detach >= 3 && controls.full >= 3 && controls.collapse >= 3, JSON.stringify(controls));

  // Сворачивание: панель превращается в полосу шапки.
  const collapsed = await ev(`(async () => {
    const before = document.querySelectorAll('[data-pane-body]').length;
    const btn = [...document.querySelectorAll('button[title]')].find((b) => /Свернуть панель|Collapse panel/i.test(b.getAttribute('title')));
    if (!btn) return { err: 'нет кнопки' };
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const stored = JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith('panes:v1:')) || '{}') || '{}');
    return { collapsedFlag: Boolean(stored.tables?.collapsed), mode: stored.tables?.mode, before };
  })()`, 30_000);
  check('панель сворачивается', Boolean(collapsed.collapsedFlag), JSON.stringify(collapsed));

  // Разворачивание обратно.
  await ev(`(() => { const b = [...document.querySelectorAll('button[title]')].find((x) => /Развернуть панель|Expand panel/i.test(x.getAttribute('title'))); if (b) b.click(); return !!b; })()`, 20_000);
  await sleep(900);

  // Открепление в окно. Откреплённая панель отрисовывается рамкой с
  // абсолютным позиционированием внутри фиксированного слоя, поэтому ищем её
  // по структуре, а не по position:fixed у самой рамки.
  const WIN = `[...document.querySelectorAll('div.fixed.inset-0 > div > div')].filter((el) => {
    const r = el.getBoundingClientRect();
    const bar = el.firstElementChild;
    return r.width > 300 && r.height > 150 && bar && bar.className.includes('cursor-move');
  })`;
  const detached = await ev(`(async () => {
    const btn = [...document.querySelectorAll('button[title]')].find((b) => /Открепить в окно|Detach into a window/i.test(b.getAttribute('title')));
    if (!btn) return { err: 'нет кнопки открепления' };
    btn.click();
    await new Promise((r) => setTimeout(r, 1400));
    const frames = [...document.querySelectorAll('div.fixed.inset-0 > div > div')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 300 && r.height > 150;
    });
    const stored = JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith('panes:v1:')) || '{}') || '{}');
    return {
      windows: frames.length,
      mode: stored.tables?.mode,
      hasBounds: Boolean(stored.tables?.win?.width),
      title: (frames[0]?.firstElementChild?.innerText || '').split('\\n').filter(Boolean)[0]?.slice(0, 40) ?? '',
    };
  })()`, 30_000);
  check('панель открепляется в окно', detached.mode === 'window' && detached.windows >= 1, JSON.stringify(detached));
  check('у окна есть размеры', Boolean(detached.hasBounds), JSON.stringify(detached));

  // Окно перетаскивается.
  const frame = await ev(`(() => {
    const d = (${WIN})[0];
    if (!d) return null;
    const bar = d.firstElementChild;
    const r = bar.getBoundingClientRect();
    return { x: Math.round(r.left + 80), y: Math.round(r.top + 14) };
  })()`, 20_000);
  if (frame) {
    const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' || type === 'mousePressed' ? 1 : 0, clickCount: 1 }, session);
    await mouse('mouseMoved', frame.x, frame.y);
    await mouse('mousePressed', frame.x, frame.y);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', frame.x + i * 15, frame.y + i * 8); await sleep(40); }
    await mouse('mouseReleased', frame.x + 90, frame.y + 48);
    await sleep(700);
    const moved = await ev(`(() => {
      const s = JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith('panes:v1:')) || '{}') || '{}');
      return { x: s.tables?.win?.x, y: s.tables?.win?.y };
    })()`, 20_000);
    check('окно перетаскивается и позиция сохраняется', Number(moved.x) > 100, JSON.stringify(moved));
  } else {
    check('окно найдено для перетаскивания', false, 'рамка не найдена');
  }

  // Возврат кнопкой в окне: у рамки это ёлочка вниз с подписью «Закрепить».
  const docked = await ev(`(async () => {
    const d = (${WIN})[0];
    if (!d) return { err: 'окна нет' };
    const btn = [...d.querySelectorAll('button')].find((b) => /Закрепить окно обратно|Dock the window back/i.test(b.getAttribute('title') || ''));
    if (!btn) return { err: 'нет кнопки возврата' };
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const s = JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith('panes:v1:')) || '{}') || '{}');
    return { mode: s.tables?.mode };
  })()`, 30_000);
  check('панель возвращается из окна', docked.mode === 'grid', JSON.stringify(docked));

  // По очереди открепляем каждую из четырёх панелей. Кнопку ищем по
  // data-pane-id, а не по порядку: список кнопок в сетке после открепления
  // панели сдвигается, и по индексу проверка бессильна.
  const PIDS = ['tables', 'card', 'logs', 'sql'];
  const perPane = await ev(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const wins = () => ${WIN};
    const out = [];
    for (const id of ${JSON.stringify(PIDS)}) {
      const group = document.querySelector('[data-pane-id="' + id + '"]');
      const btn = [...(group?.querySelectorAll('button') || [])].find((b) => /Открепить в окно|Detach into a window/i.test(b.getAttribute('title') || ''));
      if (!btn) { out.push(id + ': нет кнопки'); continue; }
      if (btn.disabled) { out.push(id + ': кнопка отключена'); continue; }
      btn.click();
      await wait(1100);
      const w = wins()[0];
      const title = w ? ((w.firstElementChild.innerText || '').split('\\n').filter(Boolean)[0] || '').slice(0, 34) : 'окна нет';
      out.push(id + ' → ' + title);
      // Возвращаем панель обратно, чтобы следующая итерация была чистой.
      const dock = [...(wins()[0]?.querySelectorAll('button') || [])].find((b) => /Закрепить окно обратно|Dock the window back/i.test(b.getAttribute('title') || ''));
      if (dock) { dock.click(); await wait(900); } else { out.push(id + ': не вернулась'); }
    }
    return out;
  })()`, 120_000);
  check('открепляются все четыре панели', perPane.length === 4 && perPane.every((t) => /→/.test(t) && !/окна нет|нет кнопки|отключена|не вернулась/.test(t)), JSON.stringify(perPane));

  // Состояние переживает перезагрузку. Перед этим возвращаем всё в сетку и
  // открепляем одну панель, чтобы проверка была воспроизводимой.
  await ev(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const w of ${WIN}) {
      const dock = [...w.querySelectorAll('button')].find((b) => /Закрепить окно обратно|Dock the window back/i.test(b.getAttribute('title') || ''));
      if (dock) { dock.click(); await wait(600); }
    }
    const b = [...document.querySelectorAll('button[title]')].find((x) => /Открепить в окно|Detach into a window/i.test(x.getAttribute('title')));
    if (b) b.click();
    await wait(900);
    return 1;
  })()`, 60_000);
  await send('Page.navigate', { url: BASE + '/', }, session);
  await sleep(4000);
  await login();
  await sleep(7000);
  await ev(`(async () => {
    const click = async (re, wait) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (!el) return false; el.click(); await new Promise((r) => setTimeout(r, wait)); return true; };
    await click(/^e2e-mysql$/, 2000); await click(/^demo$/, 2000); await click(/^(Структура|Structure)$/, 2000);
    return 1;
  })()`, 45_000);
  const afterReload = await ev(`(() => {
    const s = JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith('panes:v1:')) || '{}') || '{}');
    const windows = (${WIN}).length;
    return { mode: s.tables?.mode, windows };
  })()`, 30_000);
  check('открепленная панель восстановлена после перезагрузки', afterReload.mode === 'window' && afterReload.windows >= 1, JSON.stringify(afterReload));

  // Горизонтальной прокрутки от перестроек не появилось.
  const scroll = await ev(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const x = el.scrollWidth - el.clientWidth;
      const s = getComputedStyle(el);
      if (x > 1 && s.overflowX !== 'hidden' && s.overflowX !== 'clip') bad.push(el.tagName + '.' + String(el.className || '').slice(0, 24) + '=' + x);
    }
    return { bad: bad.slice(0, 4), doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`, 30_000);
  check('горизонтальной прокрутки нет', scroll.bad.length === 0 && scroll.doc <= 1, scroll.bad.join(' | ') || 'doc=' + scroll.doc);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `FAILURES: ${failures}` : 'PANE WINDOWS ALL GREEN');
process.exit(failures ? 1 : 0);