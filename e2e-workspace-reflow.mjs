// e2e-workspace-reflow.mjs — панели рабочей области следуют за её шириной.
//
// Проверяет то, что чистая геометрия проверить не может: панели в браузере
// растягиваются и сжимаются вместе с боковыми панелями приложения. Раньше
// та же проверка жила на вкладке «Панели»; вкладку убрали, а поведение
// осталось в «Структуре», поэтому проверка переехала туда вместе с ней.
// Баг был в том, что узел измерения ширины не был привязан к DOM, поэтому
// ширина оставалась стартовой и панели не реагировали на сворачивание сайдбаров.
//
// Запуск: node e2e-workspace-reflow.mjs     (нужен ADMIN_PASSWORD)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const API = `${BASE}/api`;
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9357;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let TOKEN = '';
const api = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
  return j;
};

const profile = mkdtempSync(join(tmpdir(), 'wsreflow-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

let ws;
const deadline = setTimeout(() => { console.log('FAIL | тест не уложился в 240 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 240_000);

try {
  TOKEN = (await api('POST', '/auth/login', { username: 'admin', password: PASSWORD })).token;
  const conn = (await api('GET', '/connections')).find(c => /^e2e-/.test(c.name) && c.kind === 'mysql');

  let wsUrl;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await sleep(250); }
  ws = new WebSocket(wsUrl);
  await new Promise((ok, b) => { ws.onopen = ok; ws.onerror = () => b(new Error('CDP')); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sess) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sess ? { sessionId: sess } : {}) })); });
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const session = a.sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);
  const ev = async (expr, ms = 30_000) => {
    const res = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session),
      sleep(ms).then(() => ({ timeout: true })),
    ]);
    if (res.timeout) throw new Error('evaluate не ответил за ' + ms + ' мс');
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'ошибка страницы');
    return res.result?.result?.value;
  };

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await ev(`(() => {
    const L = [...document.querySelectorAll('label')];
    const by = re => { const l = L.find(x => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const u = by(/пользователь|логин|user|name/i), p = by(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    const f = p.closest('form'); if (f) f.requestSubmit(); return 1;
  })()`);
  await sleep(6000);

  // Открываем подключение, базу и вкладку «Структура» — рабочую область.
  const opened = await ev(`(async () => {
    const clickText = (sel, re) => { const el = [...document.querySelectorAll(sel)].find(x => re.test((x.innerText || '').trim())); if (el) { el.click(); return true; } return false; };
    clickText('button', new RegExp('^' + ${JSON.stringify(conn.name)} + '$'));
    await new Promise(r => setTimeout(r, 1400));
    clickText('*', /^demo$/);
    await new Promise(r => setTimeout(r, 1400));
    const tab = [...document.querySelectorAll('button')].find(b => /^(Структура|Structure)$/.test((b.innerText || '').trim()));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 1800));
    return !!tab;
  })()`, 45_000);
  check('вкладка «Структура» открыта', Boolean(opened), '');

  // Снимаем геометрию панелей и ширину слоя сетки.
  const measure = () => ev(`(() => {
    const panes = [...document.querySelectorAll('[data-pane]')].map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.pane, w: Math.round(r.width), x: Math.round(r.left) };
    });
    const grid = document.querySelector('[data-pane]')?.closest('[data-workspace-grid]') ?? null;
    return { panes, gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0, body: Math.round(document.body.clientWidth) };
  })()`);

  const before = await measure();
  check('панели отрисованы в сетке', before.panes.length >= 3, `панелей=${before.panes.length}`);
  check('ширина слоя сетки измерена', before.gridWidth > 400, `${before.gridWidth}px`);

  // Сворачиваем левый сайдбар: рабочая область должна стать шире.
  const toggled = await ev(`(() => {
    const btn = [...document.querySelectorAll('header button')].find(b => /свернуть|collapse|收起|verkleiner/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
    if (!btn) {
      const alt = [...document.querySelectorAll('header button')].find(b => /панел|sidebar|seitenleiste/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
      if (alt) { alt.click(); return true; }
      return false;
    }
    btn.click();
    return true;
  })()`, 20_000);
  check('кнопка сворачивания боковой панели найдена', Boolean(toggled), '');
  await sleep(2500);

  const after = await measure();
  check('рабочая область стала шире после сворачивания', after.gridWidth > before.gridWidth + 30, `${before.gridWidth} -> ${after.gridWidth}`);
  const grew = after.panes.filter(p => {
    const was = before.panes.find(q => q.id === p.id);
    return was && p.w > was.w;
  });
  check('панели растянулись вместе с областью', grew.length >= 2,
    after.panes.map(p => `${p.id}:${before.panes.find(q => q.id === p.id)?.w}->${p.w}`).join(' '));
  check('панели не схлопнулись в ноль', after.panes.every(p => p.w > 40),
    after.panes.map(p => `${p.id}=${p.w}`).join(' '));

  // Возвращаем сайдбар: панели должны сжаться обратно.
  await ev(`(() => {
    const btn = [...document.querySelectorAll('header button')].find(b => /развернуть|expand|展开|erweitern/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
    if (btn) { btn.click(); return true; }
    return false;
  })()`, 20_000);
  await sleep(2500);
  const back = await measure();
  check('панели сжались обратно после разворачивания',
    back.panes.every(p => {
      const was = before.panes.find(q => q.id === p.id);
      return was && Math.abs(p.w - was.w) <= 2;
    }),
    back.panes.map(p => `${p.id}:${before.panes.find(q => q.id === p.id)?.w}->${p.w}`).join(' '));
  check('ширина области вернулась', Math.abs(back.gridWidth - before.gridWidth) <= 2, `${before.gridWidth} -> ${back.gridWidth}`);

  // Правая панель должна доходить до правого края области: иначе остаётся пустое поле.
  const reaches = back.panes.some(p => p.x + p.w >= back.gridWidth - 2);
  check('панель доходит до правого края области', reaches,
    `правый край=${Math.max(...back.panes.map(p => p.x + p.w))} область=${back.gridWidth}`);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter(x => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'WORKSPACE REFLOW ALL GREEN');
process.exit(failed ? 1 : 0);