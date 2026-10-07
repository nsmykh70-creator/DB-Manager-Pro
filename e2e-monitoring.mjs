// Проверка панелей мониторинга: подписи и формат чисел/дат должны
// соответствовать языку интерфейса, а не быть русскими при любом выборе.
//
// Запуск:  node e2e-monitoring.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
// Проверка панелей мониторинга: в английском режиме не должно остаться
// русских подписей, а числа и даты должны соответствовать языку интерфейса.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9341;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'cdp-mon-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let wsUrl;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await sleep(500); }
  ws = new WebSocket(wsUrl);
  await new Promise((ok, b) => { ws.onopen = ok; ws.onerror = () => b(new Error('CDP')); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, session) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: session })); });
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const session = a.sessionId;
  await send('Runtime.enable', {}, session); await send('Page.enable', {}, session);
  const ev = async expr => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session);
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
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^e2e-(?!redis|oracle)/i.test((x.innerText||'').trim())); if (b) b.click(); return 1; })()`);
  await sleep(4500);
  // Открываем вкладку мониторинга.
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^(Monitoring|Server monitoring)$/i.test((x.innerText||'').trim()))
      || [...document.querySelectorAll('button')].find(x => /мониторинг/i.test(x.innerText || ''));
    if (b) { b.click(); return 1; } return 0;
  })()`);
  await sleep(5000);

  const seen = await ev(`(() => {
    const body = document.body.innerText || '';
    const rus = ['В сети','Ошибка API','Обновление','Загрузка CPU','ОЗУ (RAM)','Запросы (QPS)','Соединения','Процессов','Всего'];
    return { русские: rus.filter(w => body.includes(w)), естьCpu: /CPU load/.test(body), естьRam: /Memory/.test(body) };
  })()`);
  check('в мониторинге нет русских подписей', (seen?.русские?.length ?? 0) === 0,
    `осталось: ${JSON.stringify(seen?.русские)}`);
  check('английские подписи на месте', seen?.естьCpu === true && seen?.естьRam === true);

  // Числа: в английском интерфейсе разделитель тысяч — запятая, не пробел.
  const num = await ev(`(() => {
    const body = document.body.innerText || '';
    const m = body.match(/Total: [\\d\\s,.\\u00a0]+/);
    return { фрагмент: m ? m[0] : null, естьПробел: /\\d\\s\\d{3}\\b/.test(body) };
  })()`);
  check('числа отформатированы по-английски', num?.фрагмент !== null && num?.естьПробел === false,
    `фрагмент: ${JSON.stringify(num?.фрагмент)}`);
} catch (e) {
  console.log('FAIL прервано | ' + e.message);
  results.push(false);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill(); await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const bad = results.filter(x => !x).length;
console.log(bad ? `\nПРОВАЛЕНО ${bad} из ${results.length}` : `\nВСЁ ЗЕЛЁНОЕ (${results.length})`);
process.exit(bad ? 1 : 0);