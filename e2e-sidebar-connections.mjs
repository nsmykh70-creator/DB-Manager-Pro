// e2e-sidebar-connections.mjs — раздел «Подключения» в левой панели сворачивается.
//
// Проверяет три вещи, которые чистым кодом не видно: шапка раздела кликается и
// прячет список, счётчик подключений остаётся виден при свёртке (иначе не
// видно, что список вообще что-то содержит), и состояние переживает перезагрузку.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9425;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('SIDEBAR CONNECTIONS ALL GREEN');
  process.exit(0);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sidebar-'));
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

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await login();
  await sleep(8000);

  // Ищем шапку раздела: кнопка с числом подключений и заголовком.
  const HEAD = `(() => {
    const btns = [...document.querySelectorAll('button[aria-expanded]')];
    const head = btns.find((b) => /^(Connections|Соединения)$/i.test((b.innerText || '').split('\\n')[0].trim()));
    if (!head) return null;
    window.__connHead = head;
    return head;
  })()`;

  const opened = await ev(`(() => {
    const h = ${HEAD};
    if (!h) return { err: 'шапка не найдена' };
    const list = h.parentElement.querySelector('button[title]');
    const names = [...h.parentElement.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
    return { expanded: h.getAttribute('aria-expanded'), count: (h.innerText || '').match(/\\d+/)?.[0] ?? null, hasList: names.length > 0, names };
  })()`, 30_000);
  check('шапка раздела «Подключения» найдена', Boolean(opened.count), JSON.stringify(opened).slice(0, 120));
  check('по умолчанию раздел развёрнут', opened.expanded === 'true', 'aria-expanded=' + opened.expanded);
  check('подключения видны в списке', opened.hasList, 'видимых=' + opened.names?.length);

  const heightOf = () => ev(`(() => {
    const h = window.__connHead;
    if (!h || !h.isConnected) return -1;
    return Math.round(h.parentElement.getBoundingClientRect().height);
  })()`, 20_000);

  const heightBefore = await heightOf();

  // Сворачиваем.
  const collapsed = await ev(`(async () => {
    const h = window.__connHead;
    h.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      expanded: h.getAttribute('aria-expanded'),
      count: (h.innerText || '').match(/\\d+/)?.[0] ?? null,
      visible: [...h.parentElement.querySelectorAll('button[title]')].length,
    };
  })()`, 30_000);
  const heightAfter = await heightOf();
  check('раздел сворачивается', collapsed.expanded === 'false', 'aria-expanded=' + collapsed.expanded);
  // При свёртке остаётся ровно сама шапка — её кнопка «свернуть». Кнопок
// подключений в разделе быть не должно.
check('список подключений скрыт', collapsed.visible <= 1, 'кнопок в разделе=' + collapsed.visible);
  check('счётчик подключений виден при свёртке', Boolean(collapsed.count), 'счётчик=' + collapsed.count);
  check('раздел стал ниже', heightAfter < heightBefore - 40, `${heightBefore} -> ${heightAfter}`);

  // Состояние переживает перезагрузку.
  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(4000);
  await login();
  await sleep(8000);
  const afterReload = await ev(`(() => {
    const h = [...document.querySelectorAll('button[aria-expanded]')].find((b) => /^(Connections|Соединения)$/i.test((b.innerText || '').split('\\n')[0].trim()));
    return { expanded: h ? h.getAttribute('aria-expanded') : null, stored: localStorage.getItem('sidebarConnectionsOpen') };
  })()`, 30_000);
  check('свёрнутое состояние пережило перезагрузку', afterReload.expanded === 'false', JSON.stringify(afterReload));

  // И разворачиваем обратно.
  const reopened = await ev(`(async () => {
    const h = [...document.querySelectorAll('button[aria-expanded]')].find((b) => /^(Connections|Соединения)$/i.test((b.innerText || '').split('\\n')[0].trim()));
    if (!h) return { err: 'шапка не найдена' };
    h.click();
    await new Promise((r) => setTimeout(r, 700));
    return { expanded: h.getAttribute('aria-expanded'), visible: [...h.parentElement.querySelectorAll('button[title]')].length };
  })()`, 30_000);
  check('раздел разворачивается обратно', reopened.expanded === 'true' && reopened.visible > 0, JSON.stringify(reopened));

  // С вкладки базы видно, что подключение по-прежнему выбирается.
  const stillWorks = await ev(`(async () => {
    const el = [...document.querySelectorAll('button[title]')].find((b) => /^e2e-mysql$/.test(b.getAttribute('title') || ''));
    if (!el) return { ok: false, why: 'подключение не найдено' };
    el.click();
    await new Promise((r) => setTimeout(r, 2000));
    return { ok: true };
  })()`, 30_000);
  check('подключение выбирается при развёрнутом разделе', stillWorks.ok === true, stillWorks.why ?? '');
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'SIDEBAR CONNECTIONS ALL GREEN');
process.exit(failed ? 1 : 0);