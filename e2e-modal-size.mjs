// Модальные окна не должны занимать всю ширину экрана.
//
// Регрессия на max-w-full: класс, стоящий в className ПОСЛЕ max-w-<размер>,
// в Tailwind побеждает по порядку utility-классов, а max-w-full сортируется
// позже. Окно с max-w-3xl max-w-full оказывалось шириной во весь экран.
// Проверяем в браузере, что ограничение размера действительно применяется.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('.', import.meta.url));
let failures = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : '')); if (!ok) failures++; };

function readAll() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) out.push([p.replace(/^frontend[\\/]src[\\/]components[\\/]/, ''), readFileSync(p, 'utf8')]);
    }
  };
  walk(join(root, 'frontend/src/components'));
  return out;
}

// Статическая часть: в className не должно быть max-w-full после max-w-<размер>.
{
  const SIZED = /max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)\b/;
  let offenders = 0;
  for (const [file, text] of readAll()) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const sizedAt = l.search(SIZED);
      const fullAt = l.indexOf('max-w-full');
      if (sizedAt < 0 || fullAt < 0 || fullAt < sizedAt) return;
      offenders++;
      check(`${file}:${i + 1} max-w-full не перебивает размер окна`, false, l.trim().slice(0, 80));
    });
  }
  check('статически: max-w-full нигде не стоит после max-w-<размер>', offenders === 0, 'найдено: ' + offenders);
}

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9399;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | браузерная часть пропущена: ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('MODAL SIZE ALL GREEN');
  process.exit(failures ? 1 : 0);
}

const profile = mkdtempSync(join(tmpdir(), 'msize-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const deadline = setTimeout(() => { console.log('FAIL | не уложились в 300 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 300_000);
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
    const click = async (re, wait) => { const el = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim())); if (!el) return false; el.click(); await new Promise((r) => setTimeout(r, wait)); return true; };
    await click(/^e2e-mysql$/, 2000); await click(/^demo$/, 2000); await click(/^(Структура|Structure)$/, 2000);
    const link = [...document.querySelectorAll('table tbody button')].find((x) => /^users$/i.test((x.innerText || '').trim()));
    link?.click(); await new Promise((r) => setTimeout(r, 3000)); return 1;
  })()`, 45_000);

  // Мера в два шага: сначала открываем окно, потом отдельным вызовом снимаем
  // ширину. Один вызов с async-функцией внутри возвращал пустой объект —
  // потерялся результат вложенного await.
  const clickAndMeasure = async (openJs) => {
    await ev(`(() => { ${openJs} })()`, 30_000);
    await sleep(1400);
    const out = await ev(`(() => {
      const bd = [...document.querySelectorAll('div')].filter((d) => getComputedStyle(d).position === 'fixed' && d.getBoundingClientRect().width > 400).pop();
      if (!bd) return { err: 'окно не открылось' };
      const panel = [...bd.children].find((c) => c.getBoundingClientRect().width > 100);
      if (!panel) return { err: 'панель не найдена' };
      const b = panel.getBoundingClientRect();
      const out = { viewport: window.innerWidth, panelW: Math.round(b.width), maxWidth: getComputedStyle(panel).maxWidth };
      const close = [...panel.querySelectorAll('button')].find((x) => !x.innerText.trim() && x.querySelector('svg'));
      if (close) close.click();
      return out;
    })()`, 30_000);
    await sleep(800);
    return out ?? { err: 'нет ответа от страницы' };
  };

  const pencil = await clickAndMeasure(`const p = [...document.querySelectorAll('button')].find((b) => /lucide-pencil/i.test(b.innerHTML)); if (p) p.click();`);
  check('«Редактировать поле» не на всю ширину', Boolean(pencil.panelW) && pencil.panelW <= 800,
    pencil.err ?? `окно=${pencil.panelW}px из ${pencil.viewport}, max-width=${pencil.maxWidth}`);

  const settings = await clickAndMeasure(`const b = [...document.querySelectorAll('button')].find((x) => /^(Settings|Настройки)$/.test((x.innerText || '').trim())); if (b) b.click();`);
  check('«Настройки» не на всю ширину', Boolean(settings.panelW) && settings.panelW <= 1180,
    settings.err ?? `окно=${settings.panelW}px из ${settings.viewport}, max-width=${settings.maxWidth}`);

  const docs = await clickAndMeasure(`const b = [...document.querySelectorAll('button')].find((x) => /^(Documentation|Справка|Help)$/.test((x.innerText || '').trim())); if (b) b.click();`);
  check('«Справка» не на всю ширину', Boolean(docs.panelW) && docs.panelW <= 1180,
    docs.err ?? `окно=${docs.panelW}px из ${docs.viewport}, max-width=${docs.maxWidth}`);

  const models = await clickAndMeasure(`const b = [...document.querySelectorAll('button')].find((x) => /Project models|Модели/i.test((x.innerText || '').trim())); if (b) b.click();`);
  check('«Модели» не на всю ширину', Boolean(models.panelW) && models.panelW <= 1180,
    models.err ?? `окно=${models.panelW}px из ${models.viewport}, max-width=${models.maxWidth}`);
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `FAILURES: ${failures}` : 'MODAL SIZE ALL GREEN');
process.exit(failures ? 1 : 0);