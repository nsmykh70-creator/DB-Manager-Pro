// Проверка того, о чём сообщил пользователь: в «Расширенном редакторе SQL» после
// вставки большого запроса кнопки уезжали вниз и становились не видны.
//
// Запуск:  node e2e-sql-editor.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
//
// Проверяем геометрию, а не текст: кнопка должна целиком попадать в окно
// браузера и в область самой вкладки, а область редак��ора — прокручиваться.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9346;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'cdp-sql-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

let ws;
const deadline = setTimeout(() => { console.log('FAIL | тест не уложился в 240 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 240_000);

try {
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
  await send('Runtime.enable', {}, session); await send('Page.enable', {}, session);
  const ev = async (expr, ms = 30_000) => {
    const res = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session), sleep(ms).then(() => ({ timeout: true }))]);
    if (res.timeout) throw new Error('evaluate не ответил за ' + ms + ' мс');
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'ошибка страницы');
    return res.result?.result?.value;
  };

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);
  await ev(`(() => {
    const L = [...document.querySelectorAll('label')];
    const by = re => { const l = L.find(x => re.test(x.innerText || '')); return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null; };
    const u = by(/user|name|\\u043f\\u043e\\u043b\\u044c\\u0437\\u043e\\u0432/i), p = by(/pass|\\u043f\\u0430\\u0440\\u043e\\u043b\\u044c/i) || [...document.querySelectorAll('input[type=password]')][0];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    const f = p.closest('form'); if (f) f.requestSubmit(); return 1;
  })()`);
  await sleep(6000);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^e2e-(?!redis|oracle)/i.test((x.innerText||'').trim())); if (b) b.click(); return 1; })()`);
  await sleep(5000);

  // Вкладка «SQL» верхнего уровня (заголовок «Расширенный редактор SQL» стоит
  // уже внутри неё).
  const tab = await ev(`(() => {
    const all = [...document.querySelectorAll('button')];
    const b = all.find(x => (x.innerText || '').trim() === 'SQL');
    if (!b) return { ok: false, вкладки: all.map(x => (x.innerText||'').trim()).filter(Boolean).slice(0, 16) };
    b.click(); return { ok: true };
  })()`);
  check('вкладка «SQL» открыта', tab?.ok === true, JSON.stringify(tab?.вкладки ?? ''));
  await sleep(2500);

  const titled = await ev(`(() => {
    const re = /expanded sql editor|\\u0440\\u0430\\u0441\\u0448\\u0438\\u0440\\u0435\\u043d\\u043d\\u044b\\u0439 \\u0440\\u0435\\u0434\\u0430\\u043a\\u0442\\u043e\\u0440 sql|erweiterter sql-editor|editor sql amplifiers?/i;
    const el = [...document.querySelectorAll('span, h1, h2, h3, div')].find(x => re.test((x.innerText || '').trim()));
    return { ok: Boolean(el), текст: el ? (el.innerText || '').trim().slice(0, 40) : null };
  })()`);
  check('внутри есть заголовок расширенного редактора', titled?.ok === true, JSON.stringify(titled?.текст ?? ''));

  // Замер геометрии до вставки и после большого запроса.
  const measure = () => ev(`(() => {
    // Именно расширенный редактор: он лежит в тёмном контейнере вкладки.
    const dark = [...document.querySelectorAll('div[class*="1e1e1e"]')].pop();
    const editor = dark ? [...dark.querySelectorAll('div.relative.overflow-auto')].pop() : null;
    const bar = editor?.parentElement?.nextElementSibling;
    const runBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.getBoundingClientRect().width > 0) : null;
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) }; };
    return {
      экран: { w: innerWidth, h: innerHeight },
      редактор: box(editor),
      редакторПрокручивается: editor ? editor.scrollHeight > editor.clientHeight + 1 : null,
      панельКнопок: box(bar),
      кнопкаЗапуска: box(runBtn),
      панельВидна: bar ? bar.scrollHeight <= bar.clientHeight + 1 : null,
    };
  })()`);

  const small = await measure();
  check('редактор и кнопки найдены', Boolean(small?.редактор && small?.кнопкаЗапуска), JSON.stringify(small));
  check('кнопка запуска видна в окне (до вставки)',
    small?.кнопкаЗапуска && small.кнопкаЗапуска.bottom <= small.экран.h && small.кнопкаЗапуска.top >= 0,
    JSON.stringify({ btn: small?.кнопкаЗапуска, экран: small?.экран }));

  // Большой запрос: 400 строк SELECT с UNION ALL.
  await ev(`(() => {
    const dark = [...document.querySelectorAll('div[class*="1e1e1e"]')].pop();
    const editor = dark ? [...dark.querySelectorAll('div.relative.overflow-auto')].pop() : null;
    const ta = editor?.querySelector('textarea');
    if (!ta) return 'нет textarea';
    const rows = [];
    for (let i = 0; i < 400; i++) rows.push("SELECT " + i + " AS n, 'строка " + i + "' AS note");
    const big = rows.join(' UNION ALL ');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
    setter.call(ta, big);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return big.length;
  })()`);
  await sleep(2500);

  const big = await measure();
  check('после большого запроса кнопка запуска всё ещё в окне',
    big?.кнопкаЗапуска && big.кнопкаЗапуска.bottom <= big.экран.h && big.кнопкаЗапуска.top >= 0,
    JSON.stringify({ btn: big?.кнопкаЗапуска, экран: big?.экран }));
  check('кнопка запуска не перекрыта и целиком в своей панели',
    big?.панельКнопок && big.кнопкаЗапуска.bottom <= big.панельКнопок.bottom + 1
      && big.кнопкаЗапуска.top >= big.панельКнопок.top - 1,
    JSON.stringify({ btn: big?.кнопкаЗапуска, панель: big?.панельКнопок }));
  check('область редактора прокручивается по вертикали', big?.редакторПрокручивается === true,
    JSON.stringify({ редактор: big?.редактор, экран: big?.экран }));
  check('высота редактора не выросла бесконтрольно',
    big?.редактор && small?.редактор && big.редактор.h <= small.редактор.h + 4,
    `${small?.редактор?.h} -> ${big?.редактор?.h}`);

  check('панель кнопок не обрезана', big?.панельВидна === true, JSON.stringify({ панель: big?.панельКнопок, экран: big?.экран }));

  // Прокрутка внутри редактора должна работать: дергаем scrollTop.
  const scrolled = await ev(`(() => {
    const dark = [...document.querySelectorAll('div[class*="1e1e1e"]')].pop();
    const editor = dark ? [...dark.querySelectorAll('div.relative.overflow-auto')].pop() : null;
    if (!editor) return null;
    editor.scrollTop = editor.scrollHeight;
    return { scrollTop: Math.round(editor.scrollTop), scrollHeight: editor.scrollHeight, clientHeight: editor.clientHeight };
  })()`);
  check('прокрутка редактора работает', Number(scrolled?.scrollTop) > 0, JSON.stringify(scrolled));

  const failed = results.filter(x => !x).length;
  clearTimeout(deadline);
  console.log(failed ? `FAILURES: ${failed}` : 'SQL EDITOR ALL GREEN');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log('FAIL | ' + (e?.message ?? e));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
