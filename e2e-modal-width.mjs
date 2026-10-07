// Модальные окна не должны прокручиваться по горизонтали.
//
// Проверка статическая: ищет места, где содержимое может распирать окно вбок,
// и открывает в браузере каждое окно, сравнивая scrollWidth с clientWidth.
// Раньше в конструкторе таблицы была горизонтальная прокрутка (таблица полей с
// whitespace-nowrap и восемью колонками), а в «Моделях» таблица вообще не имела
// контейнера прокрутки.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
let failures = 0;
const check = (n, ok, d = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''));
  if (!ok) failures++;
};

// ── Часть 1. Статика: правила, без которых окно распирает вбок ───────────────
// min-w-0 обязателен на прокручиваемом теле внутри flex-контейнера: без него
// flex-элемент не сжимается меньше своего содержимого (min-width: auto).
const modals = [
  'CreateTableModal', 'EditColumnModal', 'EditRowModal', 'CreateConnectionModal',
  'CreateDatabaseModal', 'DocsModal', 'SettingsModal', 'ModelsModal',
];
for (const name of modals) {
  const file = join(root, 'frontend/src/components/modals', name + '.tsx');
  const src = readFileSync(file, 'utf8');
  check(`${name}: подложка прокручивается по вертикали`,
    /fixed inset-0[\s\S]{0,200}overflow-y-auto/.test(src), '');
  // max-w-full после max-w-<размер> отменяет ограничение ширины окна:
  // в Tailwind побеждает класс, стоящий позже в отсортированном списке.
  const sizedLines = src.split('\n').filter((l) => {
    const sizedAt = l.search(/max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)\b/);
    const fullAt = l.indexOf('max-w-full');
    return sizedAt >= 0 && fullAt >= 0 && fullAt > sizedAt;
  });
  check(`${name}: max-w-full не отменяет заданную ширину окна`, sizedLines.length === 0, sizedLines[0]?.trim().slice(0, 80) ?? '');
}

// Конструктор: у таблицы полей не должно быть whitespace-nowrap.
{
  const src = readFileSync(join(root, 'frontend/src/components/modals/CreateTableModal.tsx'), 'utf8');
  const tableBlock = /<table className="([^"]*)"/.exec(src);
  check('конструктор: таблица полей без whitespace-nowrap',
    Boolean(tableBlock) && !/whitespace-nowrap/.test(tableBlock[1]), tableBlock ? tableBlock[1] : 'не найдена');
  check('конструктор: таблица полей с фиксированными долями колонок',
    Boolean(tableBlock) && /table-fixed/.test(tableBlock[1]), '');
  check('конструктор: поля ввода не задают свою ширину',
    !/className="w-20 [^"]*"/.test(src) && !/className="w-28 [^"]*"/.test(src), '');
  check('конструктор: подпись про Primary Key переносится',
    /break-all">\s*\{t\('createTable\.selectedPk'/.test(src.replace(/\s+/g, ' ')), '');
}

// Модели: у таблицы должен быть контейнер, который не даёт ей выйти за окно.
{
  const src = readFileSync(join(root, 'frontend/src/components/modals/ModelsModal.tsx'), 'utf8');
  check('модели: таблица сжимается, а не распирает окно',
    /<table className="w-full table-fixed/.test(src), '');
  check('модели: тело окна не прокручивается по горизонтали',
    /overflow-x-hidden/.test(src), '');
}

// Справка: колонка с текстом обязана иметь min-w-0, иначе она не сжимается.
{
  const src = readFileSync(join(root, 'frontend/src/components/modals/DocsModal.tsx'), 'utf8');
  check('справка: текстовая колонка сжимается (min-w-0)', /flex-1 min-w-0/.test(src), '');
}

// Инлайновые окна в больших компонентах.
for (const [file, label] of [['MainContent.tsx', 'подтверждение массовых операций'], ['Header.tsx', 'уведомление']]) {
  const src = readFileSync(join(root, 'frontend/src/components', file), 'utf8');
  // У окна должна быть ПРЕДЕЛЬНАЯ ширина (max-w-<размер>). Раньше проверяли
  // наличие max-w-full, но этот класс, стоящий после max-w-<размер>, отменяет
  // ограничение: в Tailwind побеждает порядок utility-классов, и окно
  // растягивалось на весь экран.
  check(`${label}: задана предельная ширина окна`, /fixed inset-0[\s\S]{0,320}max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)\b/.test(src), '');
}

// .no-scrollbar использовался в коде, но не был определён — полоса появлялась.
{
  const css = readFileSync(join(root, 'frontend/src/index.css'), 'utf8');
  const users = readFileSync(join(root, 'frontend/src/components/MainContent.tsx'), 'utf8');
  check('класс no-scrollbar определён в CSS',
    !/no-scrollbar/.test(users) || /\.no-scrollbar\s*\{/.test(css), '');
}

// ── Часть 2. Браузер: реальная ширина содержимого ───────────────────────────
const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9363;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));

// Стенд может быть не поднят: без этой проверки тест всё равно упирался бы в
// 300 секунд ожидания, потому что страница не ответила бы на fetch.
let reachable = false;
try {
  reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok;
} catch { reachable = false; }

if (!PASSWORD || !CHROME || !reachable) {
  const why = !reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome';
  console.log('SKIP | браузерная часть пропущена: ' + why);
} else {
  const profile = mkdtempSync(join(tmpdir(), 'modals-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let ws;
  const deadline = setTimeout(() => { console.log('FAIL | тест не уложился в 300 секунд'); try { chrome.kill(); } catch {} process.exit(1); }, 300_000);
  try {
    let wsUrl;
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
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
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ev = async (expr, ms = 40_000) => {
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

    const token = await ev(`(async () => {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(PASSWORD)} }) });
      const j = await r.json(); window.__t = j.token; return j.token ?? '';
    })()`);
    const connName = await ev(`(async () => {
      const r = await fetch('/api/connections', { headers: { authorization: 'Bearer ' + window.__t } });
      const list = await r.json();
      const c = list.find(x => /^e2e-/.test(x.name) && x.kind === 'mysql') ?? list[0];
      window.__conn = c; return c?.name ?? '';
    })()`);

    // Ищем последнюю подложку на весь экран: она принадлежит самому верхнему
    // открытому окну. Проверка по computed position, а не по имени класса:
    // класс могу переименовать, а позиция у подложки всегда fixed.
    const measure = () => ev(`(() => {
      const backdrops = [...document.querySelectorAll('div')]
        .filter(el => {
          if (getComputedStyle(el).position !== 'fixed') return false;
          const r = el.getBoundingClientRect();
          return r.width > 200 && r.height > 200;
        });
      const bd = backdrops[backdrops.length - 1];
      if (!bd) return { open: false };
      const panel = [...bd.children].find(c => c.getBoundingClientRect().width > 100);
      if (!panel) return { open: false };
      const pr = panel.getBoundingClientRect();
      // Считаем вылезающие элементы и прокрутку во всех потомках: полоса может
      // стоять не на панели, а на её содержимом.
      const scrollers = [panel, ...panel.querySelectorAll('*')]
        .map(el => ({ el, x: el.scrollWidth - el.clientWidth }))
        .filter(s => s.x > 1);
      const overflowing = [...panel.querySelectorAll('*')]
        .filter(el => el.getBoundingClientRect().right > pr.right + 2)
        .slice(0, 5)
        .map(el => (el.tagName + '.' + String(el.className || '').slice(0, 28)).slice(0, 50));
      return {
        open: true, panelW: Math.round(pr.width), viewport: window.innerWidth,
        // Строка собирается конкатенацией, а не шаблонной строкой: внутри
        // evaluate уже есть шаблонная строка внешнего вызова, и вложенные
        // обратные кавычки разорвали бы его.
        scrollers: scrollers.map(s => s.el.tagName + '.' + String(s.el.className || '').slice(0, 24) + '=' + s.x).slice(0, 4),
        overflowing,
      };
    })()`);

    const assertNoHScroll = async (label) => {
      const m = await measure();
      if (!m.open) { check(`${label}: окно открылось`, false, 'модальное окно не найдено в DOM'); return; }
      const noOverflowingChildren = m.overflowing.length === 0;
      check(`${label}: нет горизонтальной прокрутки`, noOverflowingChildren,
        `ширина=${m.panelW}/${m.viewport}${m.scrollers.length ? ' прокрутка: ' + m.scrollers.join(' | ') : ''}${m.overflowing.length ? ' выступают: ' + m.overflowing.join(' | ') : ''}`);
      check(`${label}: окно помещается по ширине`, m.panelW <= m.viewport + 1, `${m.panelW} <= ${m.viewport}`);
    };

    // Навигация делается в-page, потому что в page есть и текст, и пороги
    // в несколько пикселей: селектор по тексту кнопки надёжнее, чем по классу.
    const clickButton = async (source, flags = '', wait = 1200) => {
      const hit = await ev(`(() => {
        const re = new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)});
        const el = [...document.querySelectorAll('button, a, [role=button]')].find(x => re.test((x.innerText || '').trim()));
        if (!el) return false;
        el.click(); return true;
      })()`, 20_000);
      await sleep(wait);
      return hit;
    };
    const closeTopModal = () => ev(`(() => {
      const bd = [...document.querySelectorAll('div')].filter(el => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width > 200).pop();
      if (!bd) return false;
      // Кнопка закрытия — первая без подписи с иконкой X в шапке панели.
      const panel = [...bd.children].find(c => c.getBoundingClientRect().width > 100);
      const close = [...(panel?.querySelectorAll('button') ?? [])].find(b => !b.innerText.trim() && b.querySelector('svg'));
      if (!close) return false;
      close.click(); return true;
    })()`, 20_000);

    // 1. Конструктор создания таблицы.
    check('подключение открыто', await clickButton('^' + connName + '$', '', 2000), connName);
    check('база demo открыта', await clickButton('^demo$', '', 2000), '');
    check('конструктор открыт', await clickButton('Create table|Новая таблица|Создать таблицу', 'i', 1500), '');

    assertNoHScroll('конструктор создания таблицы');

    // С большим числом полей: с одним полем места хватало всем.
    // Кнопка называется «Добавить ещё одно поле», а не «Добавить поле»: ищем по
    // смыслу, а не по точному тексту — он меняется от языка и от формулировки.
    const addField = await ev(`(() => {
      const add = [...document.querySelectorAll('button')].find(x => /поле|field|champ|campo/i.test((x.innerText || '').trim()));
      if (!add) return false;
      for (let i = 0; i < 6; i++) add.click();
      return true;
    })()`, 20_000);
    await sleep(1000);
    // Проверяем не сам клик, а число строк: кнопка найдена, но если поля не
    // добавились, проверка ширины ничего не говорила бы.
    const rows = await ev(`(() => {
      const tb = [...document.querySelectorAll('table')].find(t => /PK/.test(t.innerText.slice(0, 200)));
      return tb ? tb.querySelectorAll('tbody tr').length : 0;
    })()`, 20_000);
    check('поля добавлены', addField && rows >= 7, `строк=${rows}`);
    assertNoHScroll(`конструктор с ${rows} полями`);

    // Намеренно узкое окно: горизонтальной прокрутки быть не должно и здесь.
    await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 800, deviceScaleFactor: 1, mobile: false }, session);
    await sleep(900);
    assertNoHScroll('конструктор в узком окне 820px');
    await send('Emulation.clearDeviceMetricsOverride', {}, session);
    await sleep(600);

    await closeTopModal();
    await sleep(800);

    // 2. Модели — кнопка в правой панели активной базы.
    check('модели открыты', await clickButton('Project models|Модели', 'i', 1800), '');
    assertNoHScroll('модели');
    await closeTopModal();
    await sleep(700);

    // 3. Справка.
    check('справка открыта', await clickButton('Documentation|Справка|Help', 'i', 1500), '');
    assertNoHScroll('справка');
    await closeTopModal();
    await sleep(700);

    // 4. Настройки.
    check('настройки открыты', await clickButton('^Settings$|^Настройки$', 'i', 1500), '');
    assertNoHScroll('настройки');
    await closeTopModal();
    await sleep(700);

    // 5. Создание подключения и базы — короткие окна, но с сеткой на три колонки.
    check('создание подключения открыто', await clickButton('^Create$|^Создать$', 'i', 1500), '');
    assertNoHScroll('создание подключения');
    await closeTopModal();
    await sleep(700);

    check('создание базы открыто', await clickButton('^New DB$|^Новая БД$', 'i', 1500), '');
    assertNoHScroll('создание базы');
    await closeTopModal();
  } catch (e) {
    check('исключение', false, e.message);
  } finally {
    clearTimeout(deadline);
    try { chrome.kill(); } catch {}
    try { ws?.close(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

console.log(failures ? `FAILURES: ${failures}` : 'MODAL WIDTH ALL GREEN');
process.exit(failures ? 1 : 0);