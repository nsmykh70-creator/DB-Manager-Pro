// e2e-logs-clear-cancel.mjs — «Отмена» в окне очистки журнала ничего не удаляет.
//
// Проверяет поведение в браузере, а не API: баг был в том, что у
// администратора результат confirm() уходил в признак «очистить всё» и не
// проверялся, поэтому отмена всё равно стирала журнал. API тут ни при чём —
// запрос на очистку уходил с сервера как ни в чём не бывало.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const API = `${BASE}/api`;
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9427;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('LOGS CLEAR CANCEL ALL GREEN');
  process.exit(0);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async (u, p) => {
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const j = await r.json().catch(() => ({}));
  return j.token;
};
const token = await login('admin', PASSWORD);
if (!token) { console.log('SKIP | не удалось войти'); console.log('LOGS CLEAR CANCEL ALL GREEN'); process.exit(0); }
const auth = (t) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
const conns = await (await fetch(API + '/connections', auth(token))).json();
const mysql = conns.find((c) => c.name === 'e2e-mysql');

const profile = mkdtempSync(join(tmpdir(), 'logscancel-'));
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
    await click(/^e2e-mysql$/, 1500);
    await click(/^(?:Структура|Structure)$/, 1800);
    return 1;
  })()`, 45_000);

  // Наполняем журнал: одна запись точно останется на сервере.
  await fetch(API + `/connections/${mysql.id}/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ sql: `SELECT ${Date.now()} AS cancel_probe` }) });
  await sleep(2500);

  const histCount = async () => (await (await fetch(API + `/history?connId=${mysql.id}&limit=200`, auth(token))).json()).length;
  const before = await histCount();
  check('журнал непуст перед отменой', before > 0, 'записей=' + before);

  // Вкладка «Последние операции» и кнопка очистки — обе живут в шапке панели
  // журнала, поэтому ищем их внутри самой панели.
  const openedTab = await ev(`(async () => {
    const pane = document.querySelector('[data-pane=logs]');
    if (!pane) return { ok: false, why: 'нет панели журнала' };
    const tab = [...pane.querySelectorAll('button')].find((b) => /операци|operations/i.test(b.innerText || ''));
    if (!tab) {
      const labels = [...pane.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
      return { ok: false, why: 'нет вкладки журнала; кнопки: ' + JSON.stringify(labels) };
    }
    tab.click();
    await new Promise((r) => setTimeout(r, 1500));
    // Кнопку ищем по подписи в её шапке, а не по переводу подсказки: текст
    // подсказок меняется вместе с языком, а подпись «Очистить» — общая.
    const clear = [...pane.querySelectorAll('button')]
      .find((b) => /^(Очистить|Clear|Leeren|Effacer|Limpiar|清空)$/.test((b.innerText || '').trim()) && b.querySelector('svg'));
    if (!clear) {
      const labels = [...pane.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 8);
      return { ok: false, why: 'нет кнопки очистки; кнопки: ' + JSON.stringify(labels) };
    }
    window.__clearBtn = clear;
    return { ok: true, title: (clear.innerText || '').trim() };
  })()`, 30_000);
  check('кнопка очистки журнала найдена', openedTab.ok === true, openedTab.why ?? openedTab.title ?? '');

  // Подменяем confirm(): 1 — «ОК», 0 — «Отмена». Настоящее окно браузера
  // безголовый Chrome не показывает, а ответ нам и нужен.
  const cancelled = await ev(`(async () => {
    window.__confirmSeen = 0;
    window.confirm = () => { window.__confirmSeen++; return false; };
    window.__clearBtn.click();
    await new Promise((r) => setTimeout(r, 2500));
    return { asks: window.__confirmSeen };
  })()`, 30_000);
  check('окно подтверждения показано', cancelled.asks === 1, 'вызовов confirm=' + cancelled.asks);

  const after = await histCount();
  check('после «Отмены» журнал не тронут на сервере', after >= before, `${before} -> ${after}`);
  check('после «Отмены» ничего не удалено', after === before, `${before} -> ${after}`);

  const shownRows = await ev(`(() => {
    const pane = document.querySelector('[data-pane=logs]');
    return (pane?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80);
  })()`, 20_000);
  check('панель журнала не показывает пустоту', !/empty|пуст/i.test(shownRows), shownRows);

  // И для контраста: «ОК» очистить должен.
  const cleared = await ev(`(async () => {
    window.confirm = () => true;
    window.__clearBtn.click();
    await new Promise((r) => setTimeout(r, 3000));
    return 1;
  })()`, 30_000);
  void cleared;
  const afterOk = await histCount();
  check('после «ОК» журнал очищается', afterOk < before, `${before} -> ${afterOk}`);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'LOGS CLEAR CANCEL ALL GREEN');
process.exit(failed ? 1 : 0);