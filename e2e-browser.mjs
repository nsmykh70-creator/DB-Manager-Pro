// E2E в настоящем браузере: ловит то, чего не видит проверка через API.
//
// Обычные наборы ходят по HTTP и не исполняют интерфейс, поэтому пропускают всё,
// что происходит при размонтировании и перемонтировании компонентов. Именно там
// уже вылезали две ошибки, которые статические проверки не видели:
//   - NotFoundError при удалении узла портала, приложение падало белым экраном;
//   - заголовки панелей показывали «panels.tables» вместо «Таблицы»
//     (ключи локализации лежали по пути main.panels.*, а код звал panels.*).
//
// Управляем Chrome через DevTools Protocol: в Node есть встроенный WebSocket,
// поэтому ни puppeteer, ни playwright ставить не нужно. Если Chrome не найден или
// не поднялся — набор пропускает себя, а не падает: браузерные прогоны удобно
// гонять локально, и не у всех он есть.
//
// Запуск:  node e2e-browser.mjs        (нужен ADMIN_PASSWORD, как у остальных)
// Требования: поднятый стенд (docker compose up -d).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const API = process.env.E2E_API ?? 'http://127.0.0.1:3002';
const USER = process.env.E2E_USER ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = Number(process.env.E2E_CDP_PORT ?? 9333);

// Таблица-черновик для сценария переименования колонки: создаётся и удаляется
// самим набором, чтобы не портить таблицы других e2e.
const PROBE_TABLE = 'qe_browser_probe';
const PROBE_NEW_NAME = 'created_at_stamp';

// Ищем Chrome: установленный в системе — лучше, чем ничего; если нет, набор
// пропускается, а не падает.
const CHROME_CANDIDATES = [
  process.env.E2E_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(path => existsSync(path));

let failures = 0;
const skips = [];
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}
function skip(name, why) {
  skips.push(name);
  console.log('SKIP ' + name + ' | ' + why);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!PASSWORD) {
  console.log('SKIP e2e-browser | не задан ADMIN_PASSWORD: для входа в интерфейс нужен пароль');
  process.exitCode = 0;
} else if (!CHROME) {
  console.log('SKIP e2e-browser | Chrome не найден, задайте E2E_CHROME путём к браузеру');
  process.exitCode = 0;
} else {
  const profile = mkdtempSync(join(tmpdir(), 'e2e-browser-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1680,1050',
    'about:blank'
  ], { stdio: 'ignore' });

  // Ждём DevTools: без него падать с «cannot connect» бессмысленно.
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* ещё поднимается */ }
  }

  if (!wsUrl) {
    console.error('SKIP e2e-browser | Chrome не поднял DevTools за 20 секунд');
    process.exitCode = 0;
  } else {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

    let id = 0;
    const pending = new Map();
    // Исключения страницы — то, что ломает интерфейс. console.error не берём:
    // приложение само пишет туда нештатные ситуации.
    const exceptions = [];
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        exceptions.push(String(d?.exception?.description || d?.text || '').split('\n')[0]);
      }
    };
    const send = (method, params = {}, sessionId) => new Promise(resolve => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
    });

    const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;
    await send('Runtime.enable', {}, session);
    await send('Page.enable', {}, session);
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
      if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
      return { value: r.result?.result?.value };
    };
    const goto = async url => { await send('Page.navigate', { url }, session); await sleep(3000); };

    try {
      // ── 1. Стенд отвечает ────────────────────────────────────────────────
      let reachable = false;
      try { reachable = (await fetch(BASE + '/')).ok; } catch { reachable = false; }
      check('стенд отвечает', reachable, BASE);

      // ── 2. Приложение смонтировалось ──────────────────────────────────────
      await goto(BASE + '/');
      check('страница загрузилась', (await evaluate('document.title')).value === 'DB Manager Pro');

      // ── 3. Вход ───────────────────────────────────────────────────────────
      // Поля входа без name/id/placeholder — только label, поэтому ищем по нему.
      const loginResult = await evaluate(`(() => {
        const labels = [...document.querySelectorAll('label')];
        const byLabel = re => {
          const l = labels.find(x => re.test(x.innerText || ''));
          return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null;
        };
        const user = byLabel(/пользователь|логин|user|name/i);
        const pass = byLabel(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
        if (!user || !pass) return { ok: false };
        const set = (el, v) => {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          desc.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(user, ${JSON.stringify(USER)});
        set(pass, ${JSON.stringify(PASSWORD)});
        const form = pass.closest('form');
        if (form) form.requestSubmit();
        else pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { ok: true };
      })()`);
      check('форма входа найдена', loginResult.value?.ok === true);
      await sleep(5000);

      const afterLogin = await evaluate(`({
        buttons: document.querySelectorAll('button').length,
        mounted: (document.getElementById('root')?.children.length || 0) > 0
      })`);
      check('вход выполнен', (afterLogin.value?.buttons ?? 0) > 5, `кнопок=${afterLogin.value?.buttons}`);
      check('React смонтировался', afterLogin.value?.mounted === true);

      // ── 3a-0. Язык для проверок — русский ─────────────────────────────────
      // Проверки ниже ищут русские надписи («Структура», «Быстрое
      // редактирование», «Применить»), а по умолчанию интерфейс английский.
      // Язык выбирается один раз в начале, дальше набор работает как раньше.
      const pickedLang = await evaluate(`(() => {
        const open = [...document.querySelectorAll('button')].find(x => /Language|Язык/i.test(x.getAttribute('title') || ''));
        if (!open) return { ok: false, причина: 'нет кнопки языка' };
        open.click();
        return { ok: true };
      })()`);
      await sleep(700);
      const clickedRu = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /^(Русский|Russian)$/i.test((x.innerText || '').trim()));
        if (!b) return { ok: false, причина: 'нет пункта русского языка' };
        b.click();
        return { ok: true };
      })()`);
      check('язык переключён на русский', pickedLang.value?.ok === true && clickedRu.value?.ok === true,
        pickedLang.value?.причина ?? clickedRu.value?.причина ?? '');
      await sleep(1500);

      // ── 3a. Открываем подключение ───────────────────────────────────────
      // Без этого нет ни списка таблиц, ни панелей с данными.
      const openedConn = await evaluate(`(() => {
// Кроме redis (у него нет таблиц) исключаем oracle: у него «база» = схема
      // подключения, и после своего прогона она пустая — выбрали бы подключение
      // без таблиц, и следующие шаги падали бы не из-за своих ошибок.
      const b = [...document.querySelectorAll('button')].find(x => /^e2e-(?!redis|oracle)/i.test((x.innerText || '').trim()));
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    })()`);
      check('подключение открывается', openedConn.value?.ok === true);
      await sleep(4000);

      // ── 3b. По умолчанию открывается «Структура» ─────────────────────────
      const defaultView = await evaluate(`({
        tableList: /Таблицы базы данных/.test(document.body.innerText || ''),
        panelsTab: /^(Панели|Panels)$/.test([...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).find(t => /^(Панели|Panels)$/.test(t)) || '')
      })`);
      check('по умолчанию открыта вкладка «Структура»', defaultView.value?.tableList === true,
        `список таблиц=${defaultView.value?.tableList}`);
      check('вкладки «Панели» нет в списке вкладок', defaultView.value?.panelsTab !== true);

      // ── 3c. Быстрое редактирование в окне создания таблицы ────────────────
      // Проверяем здесь, а не в конструкторе: поля в этом окне есть всегда, а
      // карточки конструктора появляются только после выбора таблицы.
      const openCreate = await evaluate(`(() => {
        const all = [...document.querySelectorAll('button')];
        const labels = all.map(x => (x.innerText || '').trim()).filter(Boolean);
        const b = all.find(x => /таблиц|table/i.test((x.innerText || '').trim()) && /созд|создать|new|create/i.test((x.innerText || '').trim()));
        if (!b) return { ok: false, проТаблицы: labels.filter(t => /таблиц|table/i.test(t)).slice(0, 8), всегоКнопок: all.length };
        b.click();
        return { ok: true };
      })()`);
      check('окно создания таблицы открывается', openCreate.value?.ok === true,
        openCreate.value?.ok === true ? '' : `подписи с «таблиц»: ${JSON.stringify(openCreate.value?.проТаблицы)} кнопок всего=${openCreate.value?.всегоКнопок}`);
      await sleep(2000);

      const quickEdit = await evaluate(`(() => {
        const pencils = document.querySelectorAll('[title="Быстрое редактирование"]');
        if (!pencils.length) return { ok: false };
        const el = [...pencils].find(x => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!el) return { ok: false, total: pencils.length };
        el.click();
        return { ok: true, total: pencils.length };
      })()`);
      check('у полей есть быстрые правки', quickEdit.value?.ok === true, `элементов=${quickEdit.value?.total}`);
      await sleep(1500);

      const popup = await evaluate(`(() => {
        const body = document.body.innerText || '';
        const inPopover = el => {
          const host = el.closest('[style*="z-index"]');
          return Boolean(host && host.getAttribute('style').includes('55'));
        };
        const field = [...document.querySelectorAll('input,textarea,select')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > 0 && inPopover(el);
          })[0];
        // Заголовок окна берём из того же слоя: он обязан быть переводом.
        // Раньше здесь был сырой ключ main.tableFields.* — t() возвращает ключ,
        // когда путь в переводах не найден, и это невидимо для типов.
        const host = field ? field.closest('[style*="z-index"]') : null;
        const title = host ? (host.querySelector('span')?.innerText || '').trim() : '';
        return {
          apply: /Применить/.test(body),
          cancel: /Отмена/.test(body),
          field: Boolean(field),
          title,
          titleIsRawKey: /^[a-zA-Z]+\\.[a-zA-Z.]+$/.test(title)
        };
      })()`);
      check('всплывающее окно с полем и кнопками открывается',
        popup.value?.field === true && popup.value?.apply === true && popup.value?.cancel === true,
        `поле=${popup.value?.field} применить=${popup.value?.apply}`);
      check('заголовок окна переведён, а не сырой ключ',
        Boolean(popup.value?.title) && popup.value?.titleIsRawKey === false,
        `«${popup.value?.title}»`);
      // Применяем значение и убеждаемся, что оно дошло до поля таблицы.
      const applied = await evaluate(`(() => {
        const inPopover = el => {
          const host = el.closest('[style*="z-index"]');
          return Boolean(host && host.getAttribute('style').includes('55'));
        };
        const field = [...document.querySelectorAll('input,textarea,select')]
          .filter(el => inPopover(el) && el.tagName !== 'BUTTON')[0];
        if (!field) return { ok: false };
        const value = 'quick_edit_probe';
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
        desc.set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(x => /Применить/.test(x.innerText || ''));
        if (!btn) return { ok: false, why: 'нет кнопки' };
        btn.click();
        return { ok: true, value };
      })()`);
      await sleep(1200);
      const appliedState = await evaluate(`({
        closed: !/Применить/.test(document.body.innerText || ''),
        hasValue: [...document.querySelectorAll('input')].some(i => i.value === 'quick_edit_probe')
      })`);
      check('«Применить» сохраняет значение и закрывает окно',
        applied.value?.ok === true && appliedState.value?.hasValue === true && appliedState.value?.closed === true,
        `сохранено=${appliedState.value?.hasValue} закрыто=${appliedState.value?.closed}`);
      // Закрываем окно создания таблицы.
      await evaluate(`(() => {
        for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(1000);

      // ── 3d. Таблица структуры: вызов редактора у каждого значения ─────────
      // Именно эта таблица имеет заголовки Имя/Тип/Null/Default/Extra.
      const openedTable = await evaluate(`(() => {
        const b = [...document.querySelectorAll('td button')].find(x => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (x.innerText || '').trim().length > 0;
        });
        if (!b) return { ok: false };
        b.click();
        return { ok: true };
      })()`);
      check('таблица открывается по клику на имя', openedTable.value?.ok === true);
      await sleep(4000);

      const structTable = await evaluate(`(() => {
        const heads = [...document.querySelectorAll('th')].map(h => (h.innerText || '').trim());
        const wanted = ['Имя', 'Тип', 'Null', 'Default', 'Extra'];
        return {
          found: wanted.filter(w => heads.includes(w)),
          quickOpen: document.querySelectorAll('button[title*="Быстрое"]').length
        };
      })()`);
      check('таблица Имя/Тип/Null/Default/Extra найдена', (structTable.value?.found?.length ?? 0) >= 4,
        `найдено: ${(structTable.value?.found || []).join(', ')}`);
      check('у значений колонок есть вызов редактора', (structTable.value?.quickOpen ?? 0) > 0,
        `кнопок=${structTable.value?.quickOpen}`);
      // Значок должен быть виден без наведения: иначе о его существовании не
      //льзя догадаться, пока не подведёшь курсор ко всем значениям подряд.
      const pencilVisibility = await evaluate(`(() => {
        const items = [...document.querySelectorAll('button[title*="Быстрое"]')]
          .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const hidden = items.filter(b => {
          const svg = b.querySelector('svg');
          return svg && Number(getComputedStyle(svg).opacity) < 0.2;
        });
        return { всего: items.length, скрытых: hidden.length };
      })()`);
      check('значки видны без наведения', (pencilVisibility.value?.всего ?? 0) > 0 &&
        (pencilVisibility.value?.скрытых ?? 1) === 0,
        `всего=${pencilVisibility.value?.всего} скрытых=${pencilVisibility.value?.скрытых}`);

      // Клик по значению открывает модальный редактор колонки: правка схемы идёт
      // через него, а не через мини-поле, поэтому проверяем именно факт открытия.
      const openEditor = await evaluate(`(() => {
        const b = document.querySelector('button[title*="Быстрое"]');
        if (!b) return { ok: false };
        b.click();
        return { ok: true };
      })()`);
      await sleep(2000);
      const editorOpen = await evaluate(`(() => {
        const body = document.body.innerText || '';
        return {
          fields: [...document.querySelectorAll('form input, form select')].filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length > 0,
          applies: /применить|сохранить|alter|изменени/i.test(body)
        };
      })()`);
      check('клик по значению открывает редактор колонки',
        openEditor.value?.ok === true && editorOpen.value?.fields === true,
        `fields=${editorOpen.value?.fields}`);

      // ── 3d2. Переименование вместе с изменением колонки ───────────────────
      // Регресс на реальный баг: операции уходили одной пачкой, renameColumn
      // выполнялся первым, а alterColumn обращался к СТАРОМУ имени. В итоге
      // переименование проходило, alter падал, значение по умолчанию не
      // сохранялось, а окно оставалось открытым — и уведомление об ошибке
      // исчезало раньше, чем его успевали увидеть.
      // Работаем на своей таблице, которую набор создаёт и удаляет сам.
      const probeApi = await (async () => {
        try {
          const login = await (await fetch(`${API}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: USER, password: PASSWORD })
          })).json();
          const conns = await (await fetch(`${API}/api/connections`, {
            headers: { authorization: `Bearer ${login.token}` }
          })).json();
          // Рабочее подключение стенда, а не любое с kind=mysql: пробные
          // подключения аудита тоже mysql, но в них нет данных.
          const mysql = conns.find(c => /^e2e-/.test(c.name) && c.kind === 'mysql')
            ?? conns.find(c => c.kind === 'mysql');
          if (!mysql) return { skip: 'нет mysql-подключения' };
          const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
          await fetch(`${API}/api/connections/${mysql.id}/demo/${PROBE_TABLE}`, { method: 'DELETE', headers: auth });
          const created = await fetch(`${API}/api/connections/${mysql.id}/demo/tables`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({
              name: PROBE_TABLE,
              columns: [
                { name: 'id', type: 'INT', primary: true, autoInc: true },
                { name: 'created_at', type: 'TIMESTAMP', nullable: false }
              ]
            })
          });
          if (!created.ok) return { skip: `не создалась: ${created.status}` };
          return { ok: true, id: mysql.id, token: login.token };
        } catch (e) {
          return { skip: e.message };
        }
      })();

      if (probeApi.skip) {
        skip('переименование колонки', probeApi.skip);
      } else {
        await goto(BASE + '/');
        await evaluate(`(() => {
          const L = [...document.querySelectorAll('label')];
          const byLabel = re => { const l = L.find(x => re.test(x.innerText || '')); return l ? l.querySelector('input') : null; };
          const user = byLabel(/пользователь|логин|user|name/i);
          const pass = byLabel(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
          const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
          set(user, ${JSON.stringify(USER)}); set(pass, ${JSON.stringify(PASSWORD)});
          pass.closest('form').requestSubmit(); return true;
        })()`);
        await sleep(5000);
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('button')].find(x => x.innerText && x.innerText.trim().startsWith('e2e-mysql'));
          if (b) { b.click(); return true; }
          return false;
        })()`);
        await sleep(4500);
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('td button')].find(x => (x.innerText || '').trim() === ${JSON.stringify(PROBE_TABLE)});
          if (b) { b.click(); return true; }
          return false;
        })()`);
        await sleep(4000);
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('button[title*="Быстрое"]')].find(x => {
            const t = (x.innerText || '').trim();
            const r = x.getBoundingClientRect();
            return t.includes('created_at') && r.width > 0 && r.height > 0;
          });
          if (b) { b.click(); return true; }
          return false;
        })()`);
        await sleep(2000);
        const renameFilled = await evaluate(`(() => {
          const form = document.querySelector('form');
          if (!form) return { ok: false, why: 'нет формы' };
          const inputs = [...form.querySelectorAll('input, textarea, select')];
          const setValue = (el, value) => {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            desc.set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const nameInput = inputs.find(i => i.value === 'created_at');
          if (!nameInput) return { ok: false, why: 'нет поля имени' };
          setValue(nameInput, ${JSON.stringify(PROBE_NEW_NAME)});
          const defInput = inputs.find(i => /CURRENT_TIMESTAMP/.test(i.placeholder || ''));
          if (defInput) setValue(defInput, 'CURRENT_TIMESTAMP');
          return { ok: true };
        })()`);
        await sleep(1200);
        const renameApplied = await evaluate(`(() => {
          const btn = [...document.querySelectorAll('button[type="submit"]')][0];
          if (!btn) return { ok: false };
          btn.click();
          return { ok: true };
        })()`);
        await sleep(6000);
        const renameState = await evaluate(`({
          окноЗакрыто: ![...document.querySelectorAll('h2')].some(h => /Редактировать поле/i.test(h.innerText || '')),
          новоеИмя: (document.body.innerText || '').includes(${JSON.stringify(PROBE_NEW_NAME)})
        })`);
        // Главное — сервер: переименование И значение по умолчанию должны
        // оказаться в базе, а не только на экране.
        const schema = await (await fetch(`${API}/api/connections/${probeApi.id}/demo/${PROBE_TABLE}/schema`, {
          headers: { authorization: `Bearer ${probeApi.token}` }
        })).json();
        const columns = (schema.columns || []).map(c => `${c.name}|${c.type}|${c.default ?? ''}`);
        const renamed = columns.find(c => c.startsWith(PROBE_NEW_NAME + '|'));
        check('переименование вместе с изменением колонки применяется',
          renameFilled.value?.ok === true && renameApplied.value?.ok === true &&
          Boolean(renamed) && /CURRENT_TIMESTAMP/.test(renamed),
          `колонки: ${columns.join(' ; ')} | форма: ${JSON.stringify(renameFilled.value)} | отправка: ${JSON.stringify(renameApplied.value)} | переименована: ${JSON.stringify(renamed ?? null)}`);
        check('после сохранения окно редактора закрывается', renameState.value?.окноЗакрыто === true,
          `закрыто=${renameState.value?.окноЗакрыто}`);
        await fetch(`${API}/api/connections/${probeApi.id}/demo/${PROBE_TABLE}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${probeApi.token}` }
        });
      }

      // ── 3e. Возвращаемся к списку таблиц ──────────────────────────────────
      // После открытия таблицы вкладки верхнего уровня скрыты, поэтому
      // перезагружаем страницу: из этого состояния на другую вкладку не перейти.
      await evaluate(`(() => {
        for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(1000);
      await goto(BASE + '/');
      await evaluate(`(() => {
        const labels = [...document.querySelectorAll('label')];
        const byLabel = re => {
          const l = labels.find(x => re.test(x.innerText || ''));
          return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null;
        };
        const user = byLabel(/пользователь|логин|user|name/i);
        const pass = byLabel(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
        const set = (el, v) => {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          desc.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(user, ${JSON.stringify(USER)});
        set(pass, ${JSON.stringify(PASSWORD)});
        const form = pass.closest('form');
        if (form) form.requestSubmit();
        return true;
      })()`);
      await sleep(5000);
      await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /^e2e-(?!redis|oracle)/i.test((x.innerText || '').trim()));
        if (b) { b.click(); return true; }
        return false;
      })()`);
      await sleep(4000);

      // ── 3d. Вкладки панелей больше нет ────────────────────────────────────
      // Панели живут в рабочей области «Структуры», отдельная вкладка удалена.
      const openedPanels = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /^(панели|panels)$/i.test((x.innerText || '').trim()));
        return { ok: !b };
      })()`);
      check('вкладки панелей нет', openedPanels.value?.ok === true);
      await sleep(1500);

      // ── 4. Панели рабочей области: заголовки переведены ───────────────────
      // Регрессия на ключи локализации: панель показывала «panels.tables».
      const panelHeaders = await evaluate(`[...document.querySelectorAll('[data-pane-id]')]
        .map(h => (h.parentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30)).filter(Boolean).slice(0, 8)`);
      const rawKeys = (panelHeaders.value || []).filter(text => /^[a-zA-Z]+\\.[a-zA-Z.]+$/.test(text));
      check('заголовки панелей переведены', (panelHeaders.value?.length ?? 0) > 0 && rawKeys.length === 0,
        rawKeys.length ? `сырые ключи: ${rawKeys.join(', ')}` : `панелей=${panelHeaders.value?.length}`);

      // ── 4a. Быстрое редактирование ──────────────────────────────────────
      // Конструктор — отдельная вкладка, поэтому открываем её явно: раньше
      // он был панелью вкладки «Панели», которой больше нет.
      const openedDesigner = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /^(конструктор|designer)$/i.test((x.innerText || '').trim()));
        if (b) b.click();
        return { ok: !!b };
      })()`);
      check('вкладка конструктора открывается', openedDesigner.value?.ok === true);
      await sleep(2000);
      // Конструктор проверяем через окно создания таблицы выше: там поля есть
      // всегда. Здесь убеждаемся, что и в конструкторе элементы появляются,
      // когда в нём есть карточки колонок.
      const designerEdit = await evaluate(`(() => {
        const all = [...document.querySelectorAll('[title="Быстрое редактирование"]')];
        return { total: all.length };
      })()`);
      check('в конструкторе есть быстрые правки', (designerEdit.value?.total ?? 0) > 0,
        `элементов=${designerEdit.value?.total}`);

      // Конструктор: открываем быструю правку и применяем значение. Проверяем не
      // только наличие значков: значение должно дойти до поля карточки, иначе
      // правка выглядит работающей, но ничего не меняет.
      const designerApply = await evaluate(`(() => {
        const visible = [...document.querySelectorAll('[title="Быстрое редактирование"]')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (!visible.length) return { ok: false, why: 'нет видимых значков' };
        visible[0].click();
        return { ok: true };
      })()`);
      await sleep(1500);
      const designerPopup = await evaluate(`(() => {
        const inPopover = el => {
          const host = el.closest('[style*="z-index"]');
          return Boolean(host && host.getAttribute('style').includes('55'));
        };
        const field = [...document.querySelectorAll('input,textarea,select')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && inPopover(el); })[0];
        if (!field) return { ok: false, why: 'поля в окне нет' };
        const value = 'qc_' + Math.random().toString(36).slice(2, 8);
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
        desc.set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(x => /Применить/.test(x.innerText || ''));
        if (!btn) return { ok: false, why: 'нет кнопки «Применить»' };
        btn.click();
        return { ok: true, value };
      })()`);
      await sleep(1200);
      const designerLanded = await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('input')];
        return {
          closed: !/Применить/.test(document.body.innerText || ''),
          попало: inputs.some(i => i.value && i.value.startsWith('qc_'))
        };
      })()`);
      check('быстрая правка в конструкторе применяется к карточке',
        designerPopup.value?.ok === true && designerLanded.value?.попало === true,
        designerPopup.value?.why ? `окно: ${designerPopup.value.why}` :
          `значок=${designerApply.value?.ok} попало=${designerLanded.value?.попало} закрыто=${designerLanded.value?.closed}`);
      await evaluate(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(600);

      // Дальше проверяем слой откреплённых окон рабочей области, поэтому
      // возвращаемся в «Структуру».
      await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /^(структура|structure)$/i.test((x.innerText || '').trim()));
        if (b) b.click();
        return !!b;
      })()`);
      await sleep(2000);

      // ── 5. Слой окон: выше сайдбаров, но под модальными окнами ────────────
      // Слой появляется, когда есть хоть одна откреплённая панель, поэтому
      // сначала открепляем одну, а потом уже смотрим сам слой.
      await evaluate(`(() => {
        const visible = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const b = [...document.querySelectorAll('button[title]')]
          .find(x => /откреп/i.test(x.getAttribute('title') || '') && /в окно$/i.test(x.getAttribute('title').trim()) && visible(x));
        if (b) b.click();
        return !!b;
      })()`);
      await sleep(2000);
      // Отдельно фиксируем, что слой не пересёкся с сайдбарами: сайдбары
      // перекрывали его содержимое, и панели выглядели «спрятанными под ними».
      const layer = await evaluate(`(() => {
        const all = [...document.querySelectorAll('body *')];
        const found = all.find(e => {
          const st = getComputedStyle(e);
          return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 46;
        });
        return { z: found ? getComputedStyle(found).zIndex : null, inBody: found ? found.parentElement === document.body : null };
      })()`);
      check('слой окон присутствует', layer.value?.z === '46', `z=${layer.value?.z}`);
      check('слой не привязан к body', layer.value?.inBody === false);
      // Возвращаем панель: дальше её состояние проверяется отдельно, с нуля.
      await evaluate(`(() => {
        const layer = [...document.querySelectorAll('body *')].find(e => {
          const st = getComputedStyle(e);
          return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 46;
        });
        const b = [...(layer?.querySelectorAll('button[title]') || [])]
          .find(x => /^закрепить окно|^вернуть/i.test(x.getAttribute('title').trim()));
        if (b) b.click();
        return !!b;
      })()`);
      await sleep(1500);

      // ── 6. Кнопки открепления принадлежат панельной системе ───────────────
      // Раньше в каждой панели висела лишняя кнопка старой оконной системы,
      // которая открывала окно мимо раскладки панелей.
      const detachButtons = await evaluate(`(() => {
        const visible = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = [...document.querySelectorAll('button[title]')]
          .filter(b => /откреп/i.test(b.getAttribute('title') || '') && visible(b));
        return {
          всего: all.length,
          панельные: all.filter(b => /в окно$/i.test(b.getAttribute('title').trim())).length,
          чужие: all.filter(b => !/в окно$/i.test(b.getAttribute('title').trim())).map(b => b.getAttribute('title'))
        };
      })()`);
      check('кнопки открепления только панельные', (detachButtons.value?.чужие?.length ?? 0) === 0,
        `всего=${detachButtons.value?.всего} панельных=${detachButtons.value?.панельные} чужие=${JSON.stringify(detachButtons.value?.чужие)}`);

      // ── 7. Открепление поднимает окно над остальными ───────────────────────
      // Проверяем именно z, а не наличие окна: раньше все окна делили один
      // счётчик, и активное оставалось под остальными.
      const detach = await evaluate(`(() => {
        const visible = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const b = [...document.querySelectorAll('button[title]')]
          .find(x => /откреп/i.test(x.getAttribute('title') || '') && /в окно$/i.test(x.getAttribute('title').trim()) && visible(x));
        if (!b) return { ok: false };
        b.click();
        return { ok: true };
      })()`);
      check('есть кнопка открепления панели', detach.value?.ok === true);
      await sleep(2500);

      const windowZ = await evaluate(`(() => {
        const layer = [...document.querySelectorAll('body *')].find(e => {
          const st = getComputedStyle(e);
          return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 46;
        });
        if (!layer) return { windows: [] };
        // WindowFrame — absolute + pointer-events-auto + z >= 100 (базовый слой).
        const windows = [...layer.querySelectorAll('*')].filter(e => {
          const st = getComputedStyle(e);
          return st.position === 'absolute' && st.pointerEvents === 'auto' && parseInt(st.zIndex) >= 100;
        });
        return { windows: windows.map(w => parseInt(getComputedStyle(w).zIndex)) };
      })()`);
      const zValues = windowZ.value?.windows ?? [];
      check('откреплённое окно получило слой выше базового', zValues.some(z => z > 100), `слои=${zValues.join(',') || 'нет'}`);

      // ── 8. Возврат окна в сетку ───────────────────────────────────────────
      // Кнопку ищем ВНУТРИ слоя окон и по её собственной подписи: поиск по всему
      // документу цеплял посторонние кнопки и молчал, а не проверял нужную.
      const dock = await evaluate(`(() => {
        const layer = [...document.querySelectorAll('body *')].find(e => {
          const st = getComputedStyle(e);
          return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 46;
        });
        if (!layer) return { ok: false, why: 'нет слоя' };
        const titles = [...layer.querySelectorAll('button[title]')].map(b => b.getAttribute('title'));
        const b = [...layer.querySelectorAll('button[title]')]
          .find(x => /^закрепить окно|^вернуть/i.test(x.getAttribute('title').trim()));
        if (!b) return { ok: false, why: 'нет кнопки возврата', titles };
        b.click();
        return { ok: true };
      })()`);
      check('в окне есть кнопка возврата в сетку', dock.value?.ok === true, dock.value?.why ?? '');
      await sleep(2000);
      const afterDock = await evaluate(`(() => {
        const layer = [...document.querySelectorAll('body *')].find(e => {
          const st = getComputedStyle(e);
          return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 46;
        });
        if (!layer) return 0;
        return [...layer.querySelectorAll('*')].filter(e => {
          const st = getComputedStyle(e);
          return st.position === 'absolute' && st.pointerEvents === 'auto' && parseInt(st.zIndex) >= 100;
        }).length;
      })()`);
      check('после возврата окон не осталось', afterDock.value === 0, `окон=${afterDock.value}`);

      // ── 9. Размонтирование и перемонтирование ─────────────────────────────
      // Главный регресс-тест: NotFoundError вылезал именно здесь, при удалении
      // узлов портала во время размонтирования.
      const before = exceptions.length;
      for (let i = 0; i < 3; i++) {
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /^(мониторинг|monitoring|monitor)$/i.test((x.innerText || '').trim()));
          if (b) { b.click(); return true; }
          return false;
        })()`);
        await sleep(2000);
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /^(базы данных|панели|структура|database)$/i.test((x.innerText || '').trim()));
          if (b) { b.click(); return true; }
          return false;
        })()`);
        await sleep(2000);
      }
      check('переключение вида туда-обратно чисто', exceptions.length === before,
        `исключений=${exceptions.length - before}`);

      // ── 10. Мониторинг на той же сетке ────────────────────────────────────
      // Кнопка «Мониторинг» лежит в боковой панели, поэтому ищем её по точному
      // тексту: расплывчатое совпадение раньше цепляло другие кнопки.
      const monitoring = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /^(мониторинг|monitoring|monitor)$/i.test((x.innerText || '').trim()));
        if (!b) {
          return { ok: false, why: 'кнопка не найдена', похожие: [...document.querySelectorAll('button')]
            .map(x => (x.innerText || '').trim()).filter(t => t && t.length < 20 && /мон|monitor/i.test(t)).slice(0, 5) };
        }
        b.click();
        return { ok: true };
      })()`);
      await sleep(5000);
      const monHeaders = await evaluate(`[...document.querySelectorAll('section header')]
        .map(h => (h.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 26)).filter(Boolean).slice(0, 8)`);
      const monRaw = (monHeaders.value || []).filter(text => /^[a-zA-Z]+\\.[a-zA-Z.]+$/.test(text));
      check('панели мониторинга переведены', (monHeaders.value?.length ?? 0) > 0 && monRaw.length === 0,
        `панелей=${monHeaders.value?.length} сырых=${monRaw.length}`);
      const monLayer = await evaluate(`[...document.querySelectorAll('body *')].some(e => {
        const st = getComputedStyle(e);
        return st.position === 'fixed' && st.pointerEvents === 'none' && parseInt(st.zIndex) === 45;
      })`);
      check('слой окон присутствует и в мониторинге', monitoring.value?.ok === true && monLayer.value === true,
        monitoring.value?.why ? `кнопка: ${monitoring.value.why} ${JSON.stringify(monitoring.value.похожие ?? [])}` : `слой=${monLayer.value}`);

      // ── Итог по исключениям ──────────────────────────────────────────────
      const notFound = exceptions.filter(text => /removeChild|NotFoundError/i.test(text));
      check('NotFoundError при размонтировании не повторяется', notFound.length === 0,
        notFound.slice(0, 2).join(' ;; '));
      check('других необработанных исключений нет', exceptions.length === 0,
        [...new Set(exceptions)].slice(0, 3).join(' ;; '));

      // ── Итог ──────────────────────────────────────────────────────────────
      if (failures) {
        console.error(`\nE2E BROWSER FAILURES: ${failures}`);
        console.error('Исключения страницы:');
        [...new Set(exceptions)].slice(0, 5).forEach(text => console.error('  - ' + text.slice(0, 200)));
      } else {
        console.log('\nE2E BROWSER ALL GREEN');
      }
      if (skips.length) console.log(`пропущено проверок: ${skips.length}`);
    } catch (err) {
      console.error('\nE2E BROWSER FAILED: ' + err.message);
      failures++;
    } finally {
      try { ws.close(); } catch { /* уже закрыт */ }
      chrome.kill();
      await sleep(600);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* временный каталог */ }
      // Без process.exit(): на Windows явный выход во время teardown сокета
      // даёт ошибку libuv, и оболочка показывает её даже при успехе.
      process.exitCode = failures ? 1 : 0;
    }
  }
}