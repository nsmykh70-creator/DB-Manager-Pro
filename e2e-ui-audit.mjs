// e2e-ui-audit.mjs — прогон по кнопкам интерфейса.
//
// Что делает: обходит основные экраны и нажимает каждую видимую кнопку, а
// после каждого нажатия собирает ошибки консоли и неудачные запросы. Кнопка
// считается здоровой, если нажатие не дало ни того, ни другого.
//
// Почему кнопки помечаются атрибутом, а не ищутся по индексу:
// индексы сдвигаются. Первое же открытое окно добавляет в DOM десятки кнопок,
// и клик по «индексу 7» после этого уходит не в ту кнопку. Каждой кнопке
// присваивается свой data-audit-id, и нажатие идёт по нему.
//
// Почему после каждого нажатия состояние сбрасывается: обход исследует
// интерфейс, а не выполняет сценарий. Открытые окна, меню и подтверждения
// закрываются, а если страница всё же уехала или зависла — она перезагружается
// и обход продолжается с начала области. Без этого одна сломанная кнопка
// обрушивала весь прогон, а отчёт о том, что «проверено 40 кнопок», ничего
// не значил: половина была нажата не туда.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9347;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));

const results = [];
const errorsByButton = new Map();
const notes = [];
const warnings = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | UI-аудит пропущен: ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('UI AUDIT ALL GREEN');
  process.exit(0);
}

// Кнопки, которые не нажимаем: разрывают сессию, удаляют стенд или уводят
// страницу. Подтверждения подменены на «отмена» (см. INSTRUMENT).
//
// Хранятся строками, а не объектами RegExp: список уходит в страницу через
// JSON.stringify, а RegExp сериализуется в {} — new RegExp({}) совпадает со
// всем, и обход молча пропускал каждую кнопку, рапортуя «ошибок нет».
const SKIP = [
  'log ?out|выход|sign out|log-out',
  'delete connection|удал.*подключ|trash-2',
  'download|скачать|импорт|экспорт|import|export',
  '^×$|^✕$|close|закрыть|cancel|отмена',
];

let ws;
let nextId = 0;
const pending = new Map();
const HARD_LIMIT_MS = 15 * 60 * 1000;
const deadline = setTimeout(() => {
  console.log('FAIL | не уложились в ' + Math.round(HARD_LIMIT_MS / 60000) + ' минут');
  process.exit(1);
}, HARD_LIMIT_MS);

let chrome;
try {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-uiaudit-'));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await sleep(250); }
  ws = new WebSocket(wsUrl);
  await new Promise((ok, b) => { ws.onopen = ok; ws.onerror = () => b(new Error('CDP')); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sess) => new Promise((r) => { const i = ++nextId; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sess ? { sessionId: sess } : {}) })); });
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const session = a.sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);

  // Таймаут на evaluate обязателен: страница может зависнуть, и тогда скрипт
  // молчал бы до общего дедлайна, не показав, на какой кнопке.
  const ev = async (expr, ms = 25_000) => {
    const res = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session),
      sleep(ms).then(() => ({ timeout: true })),
    ]);
    if (res.timeout) throw new Error('страница не ответила');
    if (res.result?.exceptionDetails) {
      const why = res.result.exceptionDetails.exception?.description ?? 'ошибка страницы';
      // Само выражение печатаем: без него SyntaxError в шаблонной строке
      // неотличим от десятка других мест, где она вставлена.
      throw new Error(why + ' | выражение: ' + String(expr).replace(/\s+/g, ' ').slice(0, 160));
    }
    return res.result?.result?.value;
  };

  // Инструментация: ошибки консоли, исключения и неудачные ответы. Подтверждения
  // всегда «отмена», печать и выбор файла заглушены — они открывают системный
  // диалог и намертво блокируют страницу в headless.
  const INSTRUMENT = `(() => {
    if (window.__auditReady) return 1;
    window.__auditReady = true;
    window.__audit = { errors: [], failed: [] };
    window.addEventListener('error', (e) => window.__audit.errors.push('exception: ' + (e.message || String(e.error))));
    window.addEventListener('unhandledrejection', (e) => window.__audit.errors.push('rejection: ' + (e.reason?.message ?? String(e.reason))));
    const origError = console.error.bind(console);
    console.error = (...a) => { window.__audit.errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)); origError(...a); };
    const origWarn = console.warn.bind(console);
    console.warn = (...a) => { window.__audit.warns.push('console.warn: ' + a.map(String).join(' ').slice(0, 160)); origWarn(...a); };
    const mark = (u, s) => { if (s >= 400 && !String(u).includes('/api/auth/login')) window.__audit.failed.push({ url: String(u).slice(0, 140), status: s }); };
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => { const res = await origFetch(...args); mark(args[0] instanceof Request ? args[0].url : args[0], res.status); return res; };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__auditUrl = u; return origOpen.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function (...r) { this.addEventListener('loadend', () => mark(this.__auditUrl, this.status)); return origSend.apply(this, r); };
    const origClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (this instanceof HTMLInputElement && this.type === 'file') return;
      if (this.tagName === 'A' && this.hasAttribute('download')) return;
      return origClick.apply(this, arguments);
    };
    window.print = () => {};
    window.confirm = () => false;
    window.alert = () => {};
    return 1;
  })()`;

  const take = () => ev(`(() => { const a = window.__audit; window.__audit = { errors: [], failed: [], warns: [] }; return a; })()`);

  const login = async () => {
    await send('Page.navigate', { url: BASE + '/' }, session);
    await sleep(2500);
    await ev(`(() => {
      const p = [...document.querySelectorAll('input[type=password]')][0];
      if (!p) return 'нет поля пароля';
      const form = p.closest('form') ?? document;
      const byLabel = (re) => {
        const l = [...form.querySelectorAll('label')].find((x) => re.test(x.innerText || ''));
        return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null;
      };
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      // Поле логина ищем по подписи, а если подписи нет — берём первое текстовое
      // поле формы. Раньше поиск шёл только по подписи, и при любом её переводе
      // el был null: set(null) падал, обход не начинался.
      const u = byLabel(/user|login|логин|用户|benutzer|usuario|utilisateur/i)
        || [...form.querySelectorAll('input')].find((el) => el !== p && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file');
      if (!u) return 'нет поля логина';
      set(u, 'admin');
      set(p, ${JSON.stringify(PASSWORD)});
      if (form.requestSubmit) form.requestSubmit(); else p.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return 'ок';
    })()`);
    await sleep(6000);
    await ev(INSTRUMENT);
    await take();
  };

  // Открыть подключение и базу, чтобы обход шёл по данным, а не по пустому списку.
  const openDemo = async () => {
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^e2e-mysql$/i.test((x.innerText || '').trim())); if (b) b.click(); return 1; })()`);
    await sleep(4000);
    await ev(INSTRUMENT);
    await take();
  };

  // Помечает кнопки области и возвращает их список. Метка сбрасывается при
  // каждом вызове, поэтому повторные прогоны не наследуют старые номера.
  const markButtons = (scopeSelector, skipRes) => ev(`(() => {
    const sel = ${JSON.stringify(scopeSelector || '')};
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return { gone: true, buttons: [] };
    for (const el of root.querySelectorAll('[data-audit-id]')) el.removeAttribute('data-audit-id');
    const skip = ${JSON.stringify(skipRes || [])}.map((s) => new RegExp(s, 'i'));
    const buttons = [...root.querySelectorAll('button, [role=button]')].filter((b) => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || b.disabled || b.offsetParent === null) return false;
      // Кнопка, ведущая на другую страницу, уводит обход с экрана.
      if (b.tagName === 'A' && b.getAttribute('href')) return false;
      return true;
    });
    const out = [];
    buttons.forEach((b, i) => {
      const id = 'a' + i + '-' + Math.random().toString(36).slice(2, 8);
      b.setAttribute('data-audit-id', id);
      const label = (b.getAttribute('title') || b.getAttribute('aria-label') || b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
        || (b.innerHTML.match(/lucide-[a-z-]+/g) || []).join(',') || b.className.slice(0, 40);
      const skipHit = skip.some((re) => re.test(label));
      out.push({ id, label, skip: skipHit });
    });
    return { gone: false, buttons: out };
  })()`);

  // Нажатие по метке, затем сбор ошибок. Метка не смещается, даже если нажатие
  // открыло окно и добавило в DOM новые кнопки.
  const clickById = (id) => ev(`(async () => {
    const b = document.querySelector('[data-audit-id="' + ${JSON.stringify(id)} + '"]');
    if (!b) return { gone: true };
    const label = (b.getAttribute('title') || b.getAttribute('aria-label') || b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    window.__audit = { errors: [], failed: [], warns: [] };
    try { b.scrollIntoView({ block: 'center' }); } catch {}
    try { b.click(); } catch (e) { return { label, err: 'click: ' + e.message }; }
    await new Promise((r) => setTimeout(r, 380));
    return { label, errors: window.__audit.errors.slice(0, 4), failed: window.__audit.failed.slice(0, 4), warns: window.__audit.warns.slice(0, 3) };
  })()`, 15_000);

  // Сброс состояния после кнопки: закрыть окна и меню, иначе следующий экран
  // будет проверен поверх того, что осталось от предыдущего.
  const settle = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session).catch(() => {});
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session).catch(() => {});
    await ev(`(() => {
      // Подтверждения, если всё же всплыли, — отмена.
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const modal = [...document.querySelectorAll('div.fixed')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 300 && r.height > 200 && !el.contains(el.parentElement?.querySelector?.('main'));
        }).pop();
        if (!modal) break;
        const panel = [...modal.children].find((c) => c.getBoundingClientRect().width > 120);
        const close = [...(panel?.querySelectorAll('button') ?? [])].find((b) => {
          const t = (b.innerText || '').trim();
          return (!t && b.querySelector('svg')) || /^(×|✕|close|закрыть|cancel|отмена)$/i.test(t);
        });
        if (!close) break;
        close.click();
        n++;
        break;
      }
      document.body.click();
      return n;
    })()`).catch(() => {});
    await sleep(260);
  };

  const MAX_CLICKS = Number(process.env.UI_AUDIT_MAX ?? 30);
  const sweep = async (scopeSelector, area, skipRes = SKIP, reOpen = null) => {
    let marked;
    try { marked = await markButtons(scopeSelector, skipRes); }
    catch (e) { notes.push(`${area}: не удалось получить список кнопок (${e.message})`); return; }
    if (marked.gone) { notes.push(`${area}: область не найдена`); return; }

    const list = marked.buttons.slice(0, MAX_CLICKS);
    let ok = 0, bad = 0, skipped = 0, recovered = 0;
    for (const item of list) {
      if (item.skip) { skipped++; continue; }
      let res;
      try { res = await clickById(item.id); }
      catch (e) {
        // Страница зависла или уехала: восстанавливаемся и идём дальше, иначе
        // одна кнопка обрушила бы весь обход.
        bad++;
        errorsByButton.set(area + ' → ' + item.label, ['страница не ответила: ' + String(e.message).slice(0, 80)]);
        results.push(area + ' → ' + item.label);
        recovered++;
        try { await login(); if (reOpen) await reOpen(); } catch {}
        continue;
      }
      if (res?.gone) { notes.push(`${area}: кнопка исчезла до нажатия, обход перезапущен`); recovered++; try { await login(); if (reOpen) await reOpen(); } catch {} break; }

      const problems = [...(res.errors ?? [])];
      const httpFails = (res.failed ?? []).map((f) => `http ${f.status} ${f.url}`);
      if (res.err) { bad++; errorsByButton.set(area + ' → ' + item.label, [res.err]); }
      else if (problems.length || httpFails.length) { bad++; errorsByButton.set(area + ' → ' + item.label, [...problems, ...httpFails]); }
      else ok++;
      if (res.warns?.length) warnings.set(area + ' → ' + item.label, res.warns);
      results.push(area + ' → ' + item.label);
      await settle();
    }
    notes.push(`${area}: найдено ${marked.buttons.length}, нажато ${ok + bad} (лимит ${MAX_CLICKS}), пропущено ${skipped}, с ошибками ${bad}${recovered ? ', восстановлений ' + recovered : ''}`);
  };

  // ── Обход ──────────────────────────────────────────────────────────────────
  console.log('вход и выбор подключения…');
  await login();
  await openDemo();
  const opened = await ev(`document.body.innerText.includes('users')`);
  notes.push('подключение и база открыты: ' + Boolean(opened));

  await sweep('header', 'шапка');
  await sweep('div.w-80:not(.border-l)', 'левая панель');
  await sweep('div.flex-1.min-w-0', 'рабочая область');
  await sweep('div.w-80.border-l, div.w-72', 'правая панель');

  // Вкладки верхнего уровня: открываем каждую и обходим кнопки внутри.
// Регулярки вставляются в код страницы через new RegExp, а не как /…/:
// RegExp.source не содержит слэшей, и прямая подстановка давала
// ^(…)$ — синтаксическая ошибка в момент вызова.
const TOP_TABS = /^(Structure|Панели|Конструктор|SQL|Search|Export|Import|Operations|Connections|Структура)$/i;
const tabs = await ev(`(() => {
    const re = new RegExp(${JSON.stringify(TOP_TABS.source)}, 'i');
    return [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => t && t.length < 28 && re.test(t));
  })()`);
  notes.push('вкладок верхнего уровня: ' + (tabs ?? []).length + ' → ' + (tabs ?? []).join(', '));
  for (const tab of tabs ?? []) {
    const okTab = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(tab)}); if (!b) return false; b.click(); return true; })()`);
    if (!okTab) continue;
    await sleep(1100);
    await settle();
    await sweep('div.flex-1.min-w-0', `вкладка «${tab}»`);
    await take();
  }

  // Карточка таблицы и её вкладки.
  const cardOpened = await ev(`(() => { const b = [...document.querySelectorAll('td button')].find((x) => /^users$/i.test((x.innerText || '').trim())); if (!b) return false; b.click(); return true; })()`);
  notes.push('карточка таблицы открыта: ' + cardOpened);
  if (cardOpened) {
    await sleep(3000);
    await sweep('div.flex-1.min-w-0', 'карточка таблицы');
    const CARD_TABS = /^(Structure|Indexes|Relations|Privileges|Triggers|Data preview|SQL|Design|Структура|Индексы)$/i;
    const cardTabs = await ev(`(() => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => t && t.length < 30 && new RegExp(${JSON.stringify(CARD_TABS.source)}, 'i').test(t)))()`);
    notes.push('вкладок карточки: ' + (cardTabs ?? []).length + ' → ' + (cardTabs ?? []).join(', '));
    for (const tab of cardTabs ?? []) {
      const okTab = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(tab)}); if (!b) return false; b.click(); return true; })()`);
      if (!okTab) continue;
      await sleep(1300);
      await settle();
      await sweep('div.flex-1.min-w-0', `карточка: вкладка «${tab}»`);
      await take();
    }
  }

  // Модальные окна открываются и обходятся целиком, затем закрываются.
  for (const m of [
    { name: 'настройки', open: /^(Settings|Настройки)$/ },
    { name: 'справка', open: /^(Documentation|Справка|Help)$/ },
  ]) {
    await login();
    const isOpen = await ev(`(() => {
      const re = new RegExp(${JSON.stringify(m.open.source)}, 'i');
      const b = [...document.querySelectorAll('button')].find((x) => re.test(((x.innerText || '') + ' ' + (x.getAttribute('title') || '')).trim()));
      if (!b) return false; b.click(); return true;
    })()`);
    await sleep(1400);
    // settle() здесь НЕ вызывается: он закрывает окна, а это окно мы как раз
    // собирась обойти. Сброс состояния нужен после прогона по нему.
    notes.push(`модальное «${m.name}»: открылось ${isOpen}`);
    if (!isOpen) continue;
    await sweep('div.fixed.inset-0', `модальное «${m.name}»`);
    const subTabs = await ev(`(() => [...document.querySelectorAll('div.fixed.inset-0 button')].map((b) => (b.innerText || '').trim()).filter((t) => t && t.length < 26 && !/^(×|✕)$/.test(t)).slice(0, 8))()`);
    for (const sub of subTabs ?? []) {
      const okSub = await ev(`(() => { const b = [...document.querySelectorAll('div.fixed.inset-0 button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(sub)}); if (!b) return false; b.click(); return true; })()`);
      if (!okSub) continue;
      await sleep(900);
      await settle();
      await sweep('div.fixed.inset-0', `«${m.name}» → «${sub}»`);
      await take();
    }
  }

  // ── Итог ──────────────────────────────────────────────────────────────────
  console.log('\n=== Сводка по областям ===');
  for (const n of notes) console.log('  ' + n);
  console.log(`\nвсего нажатий: ${results.length}, проблемных: ${errorsByButton.size}`);
  if (errorsByButton.size) {
    console.log('\n=== Нажатия с ошибками ===');
    for (const [label, problems] of errorsByButton) {
      console.log('  ' + label);
      for (const p of problems) console.log('      ' + String(p).slice(0, 180));
    }
  } else {
    console.log('\nошибок консоли и упавших запросов нет');
  }
  if (warnings.size) {
    console.log('\n=== Предупреждения консоли (не считаются ошибкой) ===');
    for (const [label, ws_] of warnings) console.log('  ' + label + ': ' + ws_[0].slice(0, 150));
  }
  const failed = errorsByButton.size;
  console.log(failed ? `\nUI AUDIT: ${failed} кнопок с проблемами` : '\nUI AUDIT ALL GREEN');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log('FAIL | ' + (e?.message ?? e));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}