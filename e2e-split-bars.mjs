import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9423;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP'); process.exit(0); }

const profile = mkdtempSync(join(tmpdir(), 'bars-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : '')); };
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
    if (res.timeout) throw new Error('таймаут');
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'ошибка');
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
    if (form.requestSubmit) form.requestSubmit(); return 1;
  })()`);
  await sleep(7000);
  await ev(`(async () => {
    const click = async (re, w) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (el) { el.click(); await new Promise((r) => setTimeout(r, w)); } return !!el; };
    await click(/^e2e-mysql$/, 1500); await click(/^demo$/, 1500); await click(/^(?:Структура|Structure)$/, 1800);
    return 1;
  })()`, 45_000);

  const bars = await ev(`(() => {
    const side = document.querySelector('[data-split=side]');
    const bottom = document.querySelector('[data-split=bottom]');
    const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.left), y: Math.round(r.top) }; };
    return { side: side ? box(side) : null, bottom: bottom ? box(bottom) : null, grips: [...document.querySelectorAll('[data-split=bottom] > div, [data-split=side] > div')].map(g => { const r = g.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }) };
  })()`, 30_000);
  check('обе полосы на месте', Boolean(bars.side && bars.bottom), JSON.stringify(bars));
  const same = bars.side && bars.bottom && Math.abs(bars.side.w - bars.bottom.h) <= 0.5;
  check('толщины полос равны', same, `ширина полосы=${bars.side?.w}px, высота полосы=${bars.bottom?.h}px`);

  // Полосу по высоте тянем вниз и проверяем, что нижний ряд стал выше.
  const drag = async (x, y, dy) => {
    const mouse = (type, px, py) => send('Input.dispatchMouseEvent', { type, x: px, y: py, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, session);
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x, y + (dy * i) / 6); await sleep(40); }
    await mouse('mouseReleased', x, y + dy);
    await sleep(500);
  };
  const rows = () => ev(`(() => {
    const panes = [...document.querySelectorAll('[data-pane]')].map((p) => { const r = p.getBoundingClientRect(); return { id: p.dataset.pane, top: Math.round(r.top), h: Math.round(r.height) }; });
    return panes.sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
  })()`, 30_000);

  // Тянем границу вниз: верхний ряд растёт, нижний — ужимается.
  const before = await rows();
  const target = bars.bottom ? { x: bars.bottom.x + Math.round(bars.bottom.w / 2), y: Math.round(bars.bottom.y + bars.bottom.h / 2) } : null;
  if (target) await drag(target.x, target.y, 70);
  const after = await rows();
  const bottomBefore = before.filter((p) => p.top > 500).map((p) => p.h);
  const bottomAfter = after.filter((p) => p.top > 500).map((p) => p.h);
  check('полоса высоты тянет границу вниз', bottomAfter.some((h, i) => bottomBefore[i] !== undefined && h < bottomBefore[i]),
    `высота нижнего ряда: ${bottomBefore.join(',')} -> ${bottomAfter.join(',')}`);

  // И обратно вверх: нижний ряд снова растёт.
  const bar2 = await ev(`(() => { const r = document.querySelector('[data-split=bottom]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, 20_000);
  await drag(bar2.x, bar2.y, -70);
  const after2 = await rows();
  const bottomBack = after2.filter((p) => p.top > 500).map((p) => p.h);
  check('полоса высоты тянет границу вверх', bottomBack.some((h, i) => bottomAfter[i] !== undefined && h > bottomAfter[i]),
    `высота нижнего ряда: ${bottomAfter.join(',')} -> ${bottomBack.join(',')}`);
  check('высота нижнего ряда вернулась', Math.abs((bottomBack[0] ?? 0) - (bottomBefore[0] ?? 0)) <= 2,
    `${bottomBefore[0]} -> ${bottomBack[0]}`);

  const scroll = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`, 20_000);
  check('горизонтальной прокрутки нет', scroll <= 1, 'doc=' + scroll);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = checks.filter((c) => !c).length;
console.log(failed ? `FAILURES: ${failed}` : 'SPLIT BARS ALL GREEN');
process.exit(failed ? 1 : 0);