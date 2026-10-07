// Проверка того, о чём сообщил пользователь: после «Клонировать» новая таблица
// появлялась в списке только после перезагрузки страницы.
//
// Запуск:  node e2e-clone-table.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд (docker compose up -d).
//
// Проверяем не текст кнопок, а признаки, которые нельзя подделать:
//  * страница не перезагружалась (метка на window осталась цела);
//  * после клона панель реально сходила за /tables;
//  * имя клона есть в тексте страницы, и таблица создана в базе.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const API = `${BASE}/api`;
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9342;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));
if (!PASSWORD || !CHROME) { console.log('SKIP | нет Chrome или ADMIN_PASSWORD'); process.exit(0); }

const SRC = 'clonesrc_probe';
const CLONE = 'users_clone_probe';
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Чистка и проверка «создана ли таблица» — обычными запросами от node, где уже
// доказано, что fetch возвращается (in-page fetch однажды подвешивал evaluate).
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
const connAndDbs = async () => {
  const conns = await api('GET', '/connections');
  const conn = conns.find(c => c.name === 'e2e-mysql') ?? conns.find(c => /mysql|mariadb/i.test(c.kind));
  const dbs = await api('GET', `/connections/${conn.id}/databases`);
  return { conn, dbs };
};
const dropClone = async () => {
  const { conn, dbs } = await connAndDbs();
  for (const db of dbs) {
    for (const t of [CLONE, SRC]) {
      await fetch(`${API}/connections/${conn.id}/${encodeURIComponent(db)}/${t}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` },
      }).catch(() => {});
    }
  }
};
/**
 * Таблицу-источник создаём сами: раньше тест клонировал `users` из сида, и любая
 * проверка, которая трогала сид, обнуляла его — тест падал не из-за своей логики.
 */
const makeSrc = async () => {
  const { conn, dbs } = await connAndDbs();
  for (const db of dbs) {
    await api('POST', `/connections/${conn.id}/${encodeURIComponent(db)}/tables`, {
      name: SRC,
      columns: [{ name: 'id', type: 'INT', primary: true, autoInc: true }, { name: 'title', type: 'VARCHAR(50)' }],
    }).catch(() => {});
  }
};

const profile = mkdtempSync(join(tmpdir(), 'cdp-clone-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

let ws;
const deadline = setTimeout(() => {
  console.log('FAIL | тест не уложился в 240 секунд');
  try { chrome.kill(); } catch {}
  process.exit(1);
}, 240_000);

try {
  TOKEN = (await api('POST', '/auth/login', { username: 'admin', password: PASSWORD })).token;
  await dropClone();
  await makeSrc();

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
  // evaluate с таймаутом: зависшая страница не должна молчать до конца прогона
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
  // window.prompt блокирует поток страницы: подменяем сразу после входа.
  await ev(`(() => { window.prompt = () => ${JSON.stringify(CLONE)}; return 1; })()`);

  const picked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^e2e-mysql$/i.test((x.innerText || '').trim()));
    if (!b) return { ok: false, есть: [...document.querySelectorAll('button')].map(x => (x.innerText||'').trim()).filter(Boolean).slice(0, 12) };
    b.click(); return { ok: true };
  })()`);
  check('подключение e2e-mysql выбрано', picked?.ok === true, JSON.stringify(picked?.есть ?? ''));
  await sleep(5000);

  // Считаем обращения панели к списку таблиц и запоминаем метку «страница жива».
  await ev(`(() => {
    window.__alive = 'page-1';
    window.__tablesCalls = 0;
    const orig = window.fetch.bind(window);
    window.fetch = (...a) => {
      const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
      if (/\\/tables(\\?|$)/.test(u)) window.__tablesCalls++;
      return orig(...a);
    };
    return 1;
  })()`);

  const opened = await ev(`(() => {
    const b = [...document.querySelectorAll('td button')].find(x => (x.innerText || '').trim() === ${JSON.stringify(SRC)});
    if (!b) return false; b.click(); return true;
  })()`);
  check('карточка исходной таблицы открыта', opened === true);
  await sleep(4000);

  const clicked = await ev(`(() => {
    // Заголовок кнопки — «Создать копию схемы и данных» / «Create a copy of the
    // schema and data»: слова «clone» в нём нет ни в одном языке.
    const b = [...document.querySelectorAll('button[title]')].find(x => /копию|copy/i.test(x.getAttribute('title') || ''));
    if (!b) return { ok: false, заголовки: [...document.querySelectorAll('button[title]')].map(x => x.getAttribute('title')).filter(Boolean).slice(-14) };
    b.click(); return { ok: true, заголовок: b.getAttribute('title') };
  })()`);
  check('кнопка «Клонировать» нажата', clicked?.ok === true, JSON.stringify(clicked?.заголовки ?? clicked?.заголовок ?? ''));
  await sleep(4500);

  // Назад к списку — кнопкой с именем базы в шапке карточки, без перезагрузки.
  const back = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && (x.innerText || '').trim() === 'demo';
    });
    if (!b) return false; b.click(); return true;
  })()`);
  check('возврат к списку кнопкой в карточке', back === true);
  await sleep(4000);

  const state = await ev(`(() => ({
    alive: window.__alive ?? null,
    tablesCalls: window.__tablesCalls ?? -1,
    естьКлон: (document.body.innerText || '').includes(${JSON.stringify(CLONE)}),
  }))()`);
  check('страница не перезагружалась', state?.alive === 'page-1', JSON.stringify(state));
  check('панель перечитала список таблиц после клона', Number(state?.tablesCalls) >= 1, `запросов /tables: ${state?.tablesCalls}`);
  check('клон виден на странице без перезагрузки', state?.естьКлон === true);

  const { conn, dbs } = await connAndDbs();
  let created = false;
  for (const db of dbs) {
    const names = await api('GET', `/connections/${conn.id}/${encodeURIComponent(db)}/tables`);
    if (Array.isArray(names) && names.includes(CLONE)) { created = true; break; }
  }
  check('клон действительно создан в базе', created);
  await dropClone();

  const failed = results.filter(x => !x).length;
  console.log(failed ? `FAILURES: ${failed}` : 'CLONE TABLE ALL GREEN');
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
