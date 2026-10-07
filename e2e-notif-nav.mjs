// Проверка того, о чём сообщил пользователь: в окне уведомления нужны кнопки
// «назад/вперёд», чтобы пролистывать список, а не закрывать и открывать каждое.
//
// Запуск:  node e2e-notif-nav.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
//
// Проверяем то, что пользователь видит: заголовок окна меняется, счётчик позиции
// меняется, на первом уведомлении «назад» отключена, а на последнем «вперёд».
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9344;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'cdp-notif-'));
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
    const u = by(/пользователь|логин|user|name/i), p = by(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(u, 'admin'); set(p, ${JSON.stringify(PASSWORD)});
    const f = p.closest('form'); if (f) f.requestSubmit(); return 1;
  })()`);
  await sleep(6000);
  // Английский режим: заголовки кнопок в нём английские и однозначные.
  await ev(`(() => { try { localStorage.setItem('mydbroot_lang', 'en'); } catch {} return 1; })()`);
  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(5000);

  // Открываем список уведомлений по кнопке-колокольчику.
  const openedList = await ev(`(() => {
    const b = document.querySelector('header button svg.lucide-bell')?.closest('button');
    if (!b) return { ok: false, кнопки: [...document.querySelectorAll('header button')].map(x => x.getAttribute('title') || (x.innerText||'').trim()).filter(Boolean).slice(0, 10) };
    b.click(); return { ok: true };
  })()`);
  check('список уведомлений открыт', openedList?.ok === true, JSON.stringify(openedList?.кнопки ?? ''));
  await sleep(3000);

  const listInfo = await ev(`(() => {
    // Строка уведомления — это div.p-3 с рамкой снизу, а не button: кнопки
    // внутри строки удаляют её, и клик по такой кнопке не открывает окно.
    const rows = [...document.querySelectorAll('div[class*="max-h-80"] div')].filter(x => {
      const r = x.getBoundingClientRect();
      return r.height > 20 && r.width > 0 && /border-b/.test(x.className || '');
    });
    return { всего: rows.length, пример: (rows[0]?.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) };
  })()`);
  check('в списке есть записи', Number(listInfo?.всего) > 1, JSON.stringify(listInfo));
  await sleep(500);

  // Открываем первое уведомление из списка.
  const openedDetail = await ev(`(() => {
    const rows = [...document.querySelectorAll('div[class*="max-h-80"] div')].filter(x => {
      const r = x.getBoundingClientRect();
      return r.height > 20 && r.width > 0 && /border-b/.test(x.className || '');
    });
    const b = rows[0];
    if (!b) return { ok: false };
    b.click(); return { ok: true, текст: (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) };
  })()`);
  check('окно уведомления открыто', openedDetail?.ok === true, JSON.stringify(openedDetail?.текст ?? ''));
  await sleep(2500);

  const read = () => ev(`(() => {
    // Окно уведомления — единственный fixed.inset-0 с заголовком h2; рядом
    // висит контейнер тостов, у него h2 нет.
    const modal = [...document.querySelectorAll('div.fixed.inset-0')].find(el => el.querySelector('h2'));
    if (!modal) return { окна: false };
    const h = modal.querySelector('h2');
    const pos = [...modal.querySelectorAll('span')].map(x => (x.innerText || '').trim()).find(x => /^\\d+\\s*\\/\\s*\\d+$/.test(x));
    const nav = [...modal.querySelectorAll('button[title]')].filter(b => /previous notification|next notification|предыдущее|следующее/i.test(b.getAttribute('title') || ''));
    return {
      окна: true, заголовок: (h?.innerText || '').trim(), позиция: pos ?? null,
      назад: nav[0] ? { есть: true, отключена: nav[0].disabled } : { есть: false },
      вперёд: nav[1] ? { есть: true, отключена: nav[1].disabled } : { есть: false },
    };
  })()`);

  const first = await read();
  check('в окне есть счётчик позиции', /\d+\s*\/\s*\d+/.test(String(first?.позиция ?? '')), JSON.stringify(first));
  check('кнопки «назад» и «вперёд» есть', first?.назад?.есть === true && first?.вперёд?.есть === true, JSON.stringify(first));
  check('на первом уведомлении «назад» отключена', first?.назад?.отключена === true, JSON.stringify(first));
  check('на первом уведомлении «вперёд» доступна', first?.вперёд?.отключена === false, JSON.stringify(first));

  const clickNav = which => ev(`(() => {
    const modal = [...document.querySelectorAll('div.fixed.inset-0')].find(el => el.querySelector('h2'));
    if (!modal) return false;
    const nav = [...modal.querySelectorAll('button[title]')].filter(b => /previous notification|next notification|предыдущее|следующее/i.test(b.getAttribute('title') || ''));
    const b = nav[${which}];
    if (!b || b.disabled) return false;
    b.click(); return true;
  })()`);

  await clickNav(1);
  await sleep(1500);
  const second = await read();
  // Листание проверяем по счётчику позиции, а не по заголовку: у записей
  // журнала заголовки одинаковые («query»), и сравнение заголовков ложно
  // падало, хотя переход к следующему уведомлению происходил.
  check('«вперёд» листает на следующее уведомление', String(second?.позиция) !== String(first?.позиция), `${first?.позиция} -> ${second?.позиция}`);
  check('«назад» снова доступна', second?.назад?.отключена === false, JSON.stringify(second));

  await clickNav(0);
  await sleep(1500);
  const back = await read();
  check('«назад» возвращает к первому', String(back?.позиция) === String(first?.позиция), `${second?.позиция} -> ${back?.позиция}`);

  // Стрелки клавиатуры делают то же самое.
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return 1; })()`);
  await sleep(1500);
  const viaKey = await read();
  check('стрелка вправо листает', String(viaKey?.позиция) === String(second?.позиция), JSON.stringify({ позиция: viaKey?.позиция, ждём: second?.позиция }));
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return 1; })()`);
  await sleep(1200);
  const viaKeyBack = await read();
  check('стрелка влево листает назад', String(viaKeyBack?.позиция) === String(first?.позиция), JSON.stringify({ позиция: viaKeyBack?.позиция, ждём: first?.позиция }));

  const failed = results.filter(x => !x).length;
  clearTimeout(deadline);
  console.log(failed ? `FAILURES: ${failed}` : 'NOTIF NAV ALL GREEN');
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
