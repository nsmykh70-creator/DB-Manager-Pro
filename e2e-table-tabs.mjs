// Проверка вкладок карточки таблицы и окна правки колонки: именно эти места
// дольше всего оставались русскими, потому что подписи лежали в массивах и
// тернарниках, а проверка зашитого текста их не видела.
//
// Запуск:  node e2e-table-tabs.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
// Проверка ровно того, на что указал пользователь: вкладки карточки таблицы и
// окно правки колонки в английском режиме.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9340;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'cdp-tabs-'));
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
  // Открываем первое подключение и первую таблицу.
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^e2e-(?!redis|oracle)/i.test((x.innerText||'').trim())); if (b) b.click(); return 1; })()`);
  await sleep(4500);
  const opened2 = await ev(`(() => {
    const b = [...document.querySelectorAll('td button')].find(x => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (x.innerText || '').trim().length > 0;
    });
    if (!b) return { ok: false, кнопки: [...document.querySelectorAll('td button')].map(x => (x.innerText||'').trim()).slice(0, 8) };
    b.click();
    return { ok: true, имя: (b.innerText || '').trim() };
  })()`);
  check('таблица открыта', opened2?.ok === true, JSON.stringify(opened2?.имя ?? opened2?.кнопки ?? ''));
  await sleep(4000);

  const tabs = await ev(`(() => {
    const want = ['Structure','Indexes','Relations','Privileges','Triggers','Data preview','SQL'];
    const body = document.body.innerText || '';
    return { есть: want.filter(w => body.includes(w)), нет: want.filter(w => !body.includes(w)) };
  })()`);
  check('вкладки карточки переведены', (tabs?.есть?.length ?? 0) === 7, `нет: ${JSON.stringify(tabs?.нет)}`);

  // Null / Default / Extra совпадают в русском и английском, поэтому в список
  // русских заголовков не входят.
  const headers = await ev(`(() => {
    const body = document.body.innerText || '';
    const rus = ['Структура','Индексы','Связи','Привилегии','Триггеры','Предпросмотр данных','Имя','Да','Нет'];
    return rus.filter(w => new RegExp('(^|\\\\W)' + w + '(\\\\W|$)').test(body));
  })()`);
  check('в карточке нет русских заголовков', (headers?.length ?? 0) === 0, `осталось: ${JSON.stringify(headers)}`);

  // Открываем окно правки колонки: клик по значению в колонке Name.
  await ev(`(() => {
    const b = [...document.querySelectorAll('button[title="Name"], button[title*="Name"]')][0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(2500);
  const modal = await ev(`(() => {
    const modal = [...document.querySelectorAll('div.fixed.inset-0')].find(el => /Edit field|Add new field/.test(el.innerText || ''));
    if (!modal) return { нашли: false };
    const body = modal.innerText;
    const rus = ['Редактировать поле','Добавить новое поле','СУБД диалект','Тип данных','типов','Разрешить пустоту','Нет (NOT NULL)','Да (NULL)','По умолчанию','Предпросмотр определения колонки','Дополнительно (с сервера'];
    return { нашли: true, русские: rus.filter(w => body.includes(w)), текст: body.slice(0, 160) };
  })()`);
  check('окно правки колонки открылось', modal?.нашли === true);
  check('в окне правки нет русских надписей', (modal?.русские?.length ?? 0) === 0, `осталось: ${JSON.stringify(modal?.русские)}`);

  // Да/Нет в колонке Null.
  const yesNo = await ev(`(() => {
    const body = document.body.innerText || '';
    return { естьYes: /Yes/.test(body), естьНет: /(^|\\W)Нет(\\W|$)/.test(body) };
  })()`);
  check('Да/Нет переведено на Yes/No', yesNo?.естьYes === true && yesNo?.естьНет === false,
    `Yes=${yesNo?.естьYes} Нет=${yesNo?.естьНет}`);
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