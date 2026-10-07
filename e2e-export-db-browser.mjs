// e2e-export-db-browser.mjs — вкладка «Экспорт» в настоящем браузере.
//
// API-часть проверяет формат файла, но не проверяет, что выбор «вся база»
// вообще есть в интерфейсе и что кнопка действительно качает файл. Раньше на
// вкладке «Экспорт» был только список таблиц, а заголовок обещал экспорт базы.
//
// Запуск: node e2e-export-db-browser.mjs     (нужен ADMIN_PASSWORD)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const API = `${BASE}/api`;
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9351;
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

const profile = mkdtempSync(join(tmpdir(), 'expdb-'));
const downloads = mkdtempSync(join(tmpdir(), 'expdb-dl-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', `--download-default-directory=${downloads}`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

let ws;
const deadline = setTimeout(() => { console.log('FAIL | тест не уложился в 240 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 240_000);

try {
  TOKEN = (await api('POST', '/auth/login', { username: 'admin', password: PASSWORD })).token;
  const conn = (await api('GET', '/connections')).find(c => c.name === 'e2e-mysql');

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

  // Открываем нужное подключение и базу, затем вкладку «Экспорт».
  const opened = await ev(`(async () => {
    const clickText = (sel, re) => { const el = [...document.querySelectorAll(sel)].find(x => re.test((x.innerText || '').trim())); if (el) { el.click(); return true; } return false; };
    clickText('button', new RegExp('^' + ${JSON.stringify(conn.name)} + '$'));
    await new Promise(r => setTimeout(r, 1200));
    const dbOk = clickText('*', /^demo$/) || clickText('button', /^demo$/);
    await new Promise(r => setTimeout(r, 1200));
    const tabs = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim());
    const expTab = tabs.findIndex(x => /Экспорт|Export/i.test(x));
    if (expTab >= 0) [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === [...document.querySelectorAll('button')].map(x => (x.innerText || '').trim()).find(y => /Экспорт|Export/i.test(y))).click();
    await new Promise(r => setTimeout(r, 800));
    const selects = [...document.querySelectorAll('select')];
    return { dbOk, expTab, selectCount: selects.length, labels: [...document.querySelectorAll('label')].map(l => (l.innerText || '').trim()).slice(0, 40) };
  })()`, 45_000);
  check('вкладка «Экспорт» открылась', opened.expTab >= 0, `индекс вкладки=${opened.expTab}`);
  check('на вкладке есть выбор таблицы и формата', opened.selectCount >= 2, `select=${opened.selectCount}`);

  // Пункт «вся база» должен быть в списке и выбран по умолчанию.
  const scope = await ev(`(() => {
    const selects = [...document.querySelectorAll('select')];
    const s = selects.find(x => [...x.options].some(o => /Вся база|whole database|ganze Datenbank|Toute la base|Toda la base|整个数据库/i.test(o.textContent)));
    if (!s) return { found: false, options: selects.map(x => [...x.options].slice(0, 3).map(o => o.textContent)) };
    const opt = [...s.options].find(o => /Вся база|whole database|ganze Datenbank|Toute la base|Toda la base|整个数据库/i.test(o.textContent));
    return { found: true, value: s.value, isAll: s.value === opt.value, label: opt.textContent, optionCount: s.options.length, hint: !!document.querySelector('p') && [...document.querySelectorAll('p')].some(p => /внешним ключам|foreign keys|Fremdschlüsseln|clés étrangères|claves foráneas|外键/i.test(p.innerText)) };
  })()`, 30_000);
  check('в списке есть пункт «вся база»', scope.found, scope.found ? scope.label : JSON.stringify(scope.options));
  check('по умолчанию выбрана вся база', Boolean(scope.isAll), scope.found ? `value=${scope.value}` : '');
  check('видно пояснение про порядок по внешним ключам', Boolean(scope.hint), '');
  check('в списке есть обычные таблицы', scope.found && scope.optionCount > 2, `пунктов=${scope.optionCount}`);

  // Файл в headless Chrome качается ненадёжно (нужен setDownloadBehavior), и
  // падение скачивания ничего не говорит о коде. Поэтому перехватываем blob и
  // имя файла прямо в странице — это и есть то, что делает обработчик экспорта.
  await ev(`(() => {
    window.__dl = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__lastBlob = blob; return orig(blob); };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push({ name: this.download, href: String(this.href || '') }); };
    return 1;
  })()`);
  const clicked = await ev(`(() => {
    const sels = [...document.querySelectorAll('select')];
    const fmt = sels.find(x => [...x.options].some(o => /csv|json|sql/i.test(o.value)));
    fmt.value = 'json'; fmt.dispatchEvent(new Event('change', { bubbles: true }));
    // Кнопка экспорта — та, что лежит в том же блоке, что и выбор формата.
    // Ищем по тексту в этом блоке: в панели есть и «Экспорт» для массовой
    // выгрузки, который умеет не то.
    const panel = fmt.closest('div.space-y-4') || fmt.parentElement.parentElement;
    const btn = [...panel.querySelectorAll('button')].pop();
    if (!btn) return { ok: false, buttons: [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(-12) };
    btn.click();
    return { ok: true, text: btn.innerText.trim() };
  })()`, 30_000);
  check('кнопка экспорта найдена и нажата', Boolean(clicked.ok), clicked.ok ? clicked.text : JSON.stringify(clicked.buttons));
  await sleep(6000);

  const dl = await ev(`(async () => {
    const rec = window.__dl[0];
    if (!rec || !window.__lastBlob) return { none: true };
    const text = await window.__lastBlob.text();
    return { name: rec.name, size: window.__lastBlob.size, type: window.__lastBlob.type, head: text.slice(0, 120), tables: (text.match(/"([^"\\\\]+)":\\s*\\[/g) || []).length };
  })()`, 30_000);
  check('обработчик отдал файл с именем базы', Boolean(dl.name) && /^demo\.json$/.test(dl.name), String(dl.name));
  check('файл пришёл как вложение с правильным типом', Boolean(dl.type) && /json/.test(dl.type), String(dl.type));
  check('в файле несколько таблиц, а не одна', (dl.tables ?? 0) >= 2, `таблиц=${dl.tables} байт=${dl.size}`);

  // Табличный режим должен остаться рабочим: выбираем конкретную таблицу.
  await ev(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Вся база|whole database/i.test(o.textContent)));
    if (!s) return 0;
    const opt = [...s.options].find(o => /^users$/i.test(o.value)) ?? [...s.options][1];
    s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  })()`);
  await sleep(600);
  const tableMode = await ev(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Вся база|whole database/i.test(o.textContent)));
    return { value: s?.value, hintGone: !([...document.querySelectorAll('p')].some(p => /foreign keys|Fremdschlüsseln|clés étrangères|外键/i.test(p.innerText))) };
  })()`);
  check('можно выбрать одну таблицу', Boolean(tableMode.value) && tableMode.value !== '__all__', `value=${tableMode.value}`);
  check('пояснение про внешние ключи скрыто для таблицы', Boolean(tableMode.hintGone), '');
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true }); } catch {}
}

const failed = results.filter(x => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'EXPORT DB BROWSER ALL GREEN');
process.exit(failed ? 1 : 0);