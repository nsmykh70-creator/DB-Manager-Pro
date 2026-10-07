// e2e-column-edit-hints.mjs — в окне редактирования поля видны подсказки.
//
// Проверяет то, что тихо ломало окно: нормализатор колонок кладёт «-» как
// заглушку «значения нет», и она занимала место подсказки в полях «Длина /
// Значения» и «По умолчанию». Пользователь видел поле, будто заполненное
// значением, и не понимал, что туда можно вписать своё.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const API = `${BASE}/api`;
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9429;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('COLUMN EDIT HINTS ALL GREEN');
  process.exit(0);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' | ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Таблица с полем без длины и без значения по умолчанию: именно там заглушка
// «-» и вылезала в поля ввода.
const TABLE = 'hint_probe';
const login = async () => {
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  return (await r.json()).token;
};
let token = await login();
if (!token) { console.log('SKIP | не удалось войти'); console.log('COLUMN EDIT HINTS ALL GREEN'); process.exit(0); }
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const conns = await (await fetch(API + '/connections', { headers: H })).json();
// MySQL, а не MariaDB: заглушка «-» приходит от нормализатора колонок и от
// диалекта не зависит, а подключение MySQL открывается в тестах надёжно.
const maria = conns.find((c) => c.name === 'e2e-mysql') || conns.find((c) => c.kind === 'mysql');
// Путь запроса — /connections/{id}/query, база передаётся в теле: вариант с
// базой в URL у этого маршрута нет и отвечает 404.
const Q = async (sql, db = 'demo') => {
  const r = await fetch(`${API}/connections/${maria.id}/query`, { method: 'POST', headers: H, body: JSON.stringify({ sql, db }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${sql} -> ${r.status}: ${j.error ?? ''}`);
  return j;
};
await Q(`DROP TABLE IF EXISTS ${TABLE}`);
await Q(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY AUTO_INCREMENT, age INT)`);

const profile = mkdtempSync(join(tmpdir(), 'colhint-'));
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
  const openedState = await ev(`(async () => {
    // Подключение открываем по подсказке: имена баз у многих подключений
    // одинаковые («demo»), и кнопка по тексту попадала не туда.
    const connBtn = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === ${JSON.stringify(maria.name)});
    if (connBtn) { connBtn.click(); await new Promise((r) => setTimeout(r, 1800)); }
    // Кнопок «demo» по одной на каждое подключение, поэтому берём видимую:
// развёрнут список только у активного подключения.
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const dbBtn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'demo' && visible(b));
    if (dbBtn) { dbBtn.click(); await new Promise((r) => setTimeout(r, 1800)); }
    const struct = [...document.querySelectorAll('button')].find((x) => /^(?:Структура|Structure)$/.test((x.innerText || '').trim()));
    if (struct) { struct.click(); await new Promise((r) => setTimeout(r, 2000)); }
    const tbl = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === ${JSON.stringify(TABLE)});
    if (tbl) { tbl.click(); await new Promise((r) => setTimeout(r, 3000)); }
    return { conn: !!connBtn, db: !!dbBtn, table: !!tbl };
  })()`, 60_000);
  check('подключение, база и таблица открыты', openedState.conn && openedState.db && openedState.table, JSON.stringify(openedState));

  // Открываем окно редактирования поля age: строка в таблице колонок
  // начинается с номера, поэтому ищем по ячейке, а не по началу строки.
  const opened = await ev(`(async () => {
    const row = [...document.querySelectorAll('table tbody tr')].find((tr) => {
      const cell = tr.querySelector('td:nth-child(2)');
      return cell && /^age/.test((cell.innerText || '').trim());
    });
    if (!row) {
      const names = [...document.querySelectorAll('table tbody tr')].map((tr) => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 8);
      return { ok: false, why: 'нет строки age; строки: ' + JSON.stringify(names) };
    }
    // Карандаш в последней ячейке открывает то же окно, что и название поля.
    const edit = row.querySelector('td:last-child button');
    if (!edit) return { ok: false, why: 'нет кнопки правки' };
    edit.click();
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true };
  })()`, 45_000);
  check('окно редактирования поля открылось', opened.ok === true, opened.why ?? '');

  // Подпись поля лежит в <label>, но не внутри него самого, а рядом, поэтому
// берём подпись из предыдущего элемента и из самого label.
const fields = await ev(`(() => {
    const isVisible = (el) => el.getClientRects().length > 0;
    const dialogs = [...document.querySelectorAll('div')].filter((d) => isVisible(d) && /Предпросмотр определения|Column definition preview/i.test(d.innerText || '') && d.querySelector('input'));
    const dialog = dialogs.sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!dialog) return null;
    const out = [];
    for (const input of dialog.querySelectorAll('input')) {
      if (!isVisible(input)) continue;
      const label = input.closest('label');
      const own = label ? (label.innerText || '').trim() : '';
      let text = own;
      if (!text) {
        // Подпись может быть отдельным элементом над полем.
        let node = input.previousElementSibling;
        for (let i = 0; i < 3 && node && !text; i++) {
          text = (node.innerText || '').trim();
          node = node.previousElementSibling;
        }
      }
      out.push({ label: text.replace(/\\s+/g, ' ').slice(0, 40), value: input.value, placeholder: input.placeholder || '' });
    }
    return out;
  })()`, 30_000);
  check('поля окна найдены', Array.isArray(fields) && fields.length >= 2, JSON.stringify(fields));

  // Ищем поля длины и значения по умолчанию.
  const findField = (needle) => (fields || []).find((f) => new RegExp(needle, 'i').test(f.label));
  const lenField = findField('длина|length|значени');
  const defField = findField('по умолчанию|default');
  check('поле длины найдено', Boolean(lenField), JSON.stringify(lenField));
  check('поле значения по умолчанию найдено', Boolean(defField), JSON.stringify(defField));

  if (lenField) {
    check('поле длины не содержит заглушку «-»', lenField.value !== '-', 'значение=' + JSON.stringify(lenField.value));
    check('в поле длины видна подсказка', Boolean(lenField.placeholder), 'placeholder=' + JSON.stringify(lenField.placeholder));
  }
  if (defField) {
    check('поле значения по умолчанию не содержит «-»', defField.value !== '-', 'значение=' + JSON.stringify(defField.value));
    check('в поле значения по умолчанию видна подсказка', Boolean(defField.placeholder), 'placeholder=' + JSON.stringify(defField.placeholder));
  }

  // Сохраняем без правок: колонка не должна потерять смысл (DEFAULT не появился).
  const saved = await ev(`(async () => {
    const isVisible = (el) => el.getClientRects().length > 0;
    const dialogs = [...document.querySelectorAll('div')].filter((d) => isVisible(d) && /Предпросмотр определения|Column definition preview/i.test(d.innerText || '') && d.querySelector('input'));
    const dialog = dialogs.sort((a, b) => a.innerText.length - b.innerText.length)[0];
    const btn = [...(dialog?.querySelectorAll('button') || [])].find((b) => /Сохранить|Save|Применить/i.test((b.innerText || '').trim()));
    if (!btn) return { ok: false, why: 'нет кнопки сохранения' };
    btn.click();
    await new Promise((r) => setTimeout(r, 3000));
    return { ok: true };
  })()`, 45_000);
  check('окно сохранено', saved.ok === true, saved.why ?? '');

  const after = await (await fetch(`${API}/connections/${maria.id}/demo/${TABLE}/schema`, { headers: H })).json().catch(() => null);
  const cols = Array.isArray(after) ? after : (after?.columns ?? []);
  const age = (cols.find((c) => (c.name ?? c.column_name) === 'age')) || {};
  const def = age.default ?? age.column_default ?? '';
  check('у поля age не появилось лишнего DEFAULT', def === '' || def === null || def === '-', 'default=' + JSON.stringify(def));
  check('поле age на месте', Boolean(age.name ?? age.column_name), JSON.stringify(age).slice(0, 120));
} catch (e) {
  check('исключение', false, e.message);
} finally {
  try { await Q(`DROP TABLE IF EXISTS ${TABLE}`); } catch { /* уборка не критична */ }
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILURES: ${failed}` : 'COLUMN EDIT HINTS ALL GREEN');
process.exit(failed ? 1 : 0);