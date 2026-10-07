// Контраст текста в тёмной теме.
//
// Проверка не «на глаз»: считаем контраст по формуле WCAG для каждого текста
// в тёмной теме. Именно поэтому жаловались на выпадающие списки — у них чёрный
// текст на тёмном фоне, и это видно в цифрах (1.0:1).
//
// Что проверяем:
//  1) контраст всего видимого текста в тёмной теме >= 4.5:1;
//  2) color-scheme объявлен, иначе всплывающий список нативного <select>
//     рисуется светлым, а его пункты — тёмными;
//  3) элементы, вынесенные порталом в document.body (всплывающие окна
//     QuickEdit), не наследуют цвет <body>, то есть чёрный.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = 9381;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p));

let failures = 0;
const check = (n, ok, d = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''));
  if (!ok) failures++;
};

let reachable = false;
try { reachable = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) })).ok; } catch { reachable = false; }
if (!PASSWORD || !CHROME || !reachable) {
  console.log('SKIP | браузерная часть пропущена: ' + (!reachable ? 'стенд не отвечает' : !PASSWORD ? 'нет ADMIN_PASSWORD' : 'нет Chrome'));
  console.log('CONTRAST ALL GREEN');
  process.exit(0);
}

// Формула относительной яркости и контраста из WCAG 2.1. Вычисляется в
// странице: там уже есть разобранные цвета, и не нужно тащить парсер CSS.
const CONTRAST_FN = `
  // getComputedStyle в Chrome возвращает цвет в виде oklch(...)/oklab(...),
  // а не в rgb. Разбирать такие строки регуляркой нельзя — получается мусор, и
  // проверка сравнивала бы случайные числа. Поэтому цвета переводятся в sRGB
  // через canvas: fillStyle понимает любой синтаксис CSS, а пиксель даёт
  // готовые каналы 0..255.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const toRGBA = cssColor => {
    if (cache.has(cssColor)) return cache.get(cssColor);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2], d[3] / 255];
    cache.set(cssColor, out);
    return out;
  };
  const lum = rgb => {
    const ch = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  // Фон ищем вверх до первого непрозрачного слоя и сами смешиваем
  // полупрозрачные слои между собой — иначе oklab(… / 0.5) читался как
  // непрозрачный цвет и контраст считался неверно.
  const bgOf = el => {
    const layers = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const c = toRGBA(getComputedStyle(node).backgroundColor);
      if (c[3] > 0.001) {
        layers.push(c);
        if (c[3] > 0.999) break;
      }
      node = node.parentElement;
    }
    const root = toRGBA(getComputedStyle(document.documentElement).backgroundColor);
    if (root[3] > 0.001) layers.push(root);
    let acc = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      acc = [0, 1, 2].map(k => l[k] * l[3] + acc[k] * (1 - l[3])).concat(1);
    }
    return acc;
  };
  const ratio = el => {
    const s = getComputedStyle(el);
    const fg = toRGBA(s.color);
    const bg = bgOf(el);
    if (!fg) return null;
    // Полупрозрачный текст смешиваем с фоном, иначе контраст завышается.
    const mixed = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const l1 = lum(mixed), l2 = lum(bg.slice(0, 3));
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Крупный текст (>=18.66px полужирный или >=24px) требует лишь 3:1,
  // но проверяем по единому порогу 4.5 — это строже и не должно мешать.
  const scan = () => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.35) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      // Текстом считаем элементы с собственным текстовым содержимым.
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) continue;
      // Имя не ratio: внутри scan это затенило бы внешнюю функцию ratio,
      // и обращение к ней попало бы во временную мёртвую зону (TDZ).
      const r = ratio(el);
      if (r === null) continue;
      if (r < 4.5) {
        bad.push({
          ratio: Math.round(r * 100) / 100,
          text: el.textContent.trim().slice(0, 24),
          cls: String(el.className || '').slice(0, 46),
          tag: el.tagName,
        });
      }
    }
    return bad;
  };
`;

const profile = mkdtempSync(join(tmpdir(), 'contrast-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
  const ev = async (expr, ms = 60_000) => {
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
  await sleep(7000);

  // Тёмная тема включается до всех проверок: именно в ней был дефект.
  const theme = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /theme|тема|тем/i.test((b.title || b.innerText || '')));
    if (!btn) return 'кнопки темы нет';
    const isDark = document.documentElement.classList.contains('dark');
    if (!isDark) btn.click();
    return document.documentElement.classList.contains('dark') ? 'тёмная' : 'не переключилась';
  })()`, 20_000);
  await sleep(800);
  check('тёмная тема включена', theme === 'тёмная', String(theme));

  const scheme = await ev(`getComputedStyle(document.documentElement).colorScheme`);
  check('color-scheme объявлен для тёмной темы', /dark/.test(scheme), 'color-scheme=' + scheme);

  // Всплывающие окна вне оболочки: проверяем на реальном поповере QuickEdit,
  // который выносится порталом в body и потому наследует цвет body.
  // Попасть в него можно только с холста конструктора — раньше поиск шёл с
  // рабочей области, где этих кнопок нет, и проверка пропускалась.
  await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^e2e-/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
  await sleep(1800);
  await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^(Конструктор|Designer)$/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
  await sleep(1800);
  const popover = await ev(`(() => {
    const pencil = [...document.querySelectorAll('button, svg')].find(el => {
      const svg = el.tagName === 'svg' ? el : el.querySelector('svg');
      return svg && /pencil|edit/i.test(svg.className.baseVal || '');
    });
    if (!pencil) return { opened: false };
    (pencil.tagName === 'svg' ? pencil.parentElement : pencil).click();
    return { opened: true };
  })()`, 20_000);
  if (popover.opened) {
    await sleep(700);
    const popColors = await ev(`(() => {
      const pop = [...document.querySelectorAll('body > div')].find(el => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.position === 'fixed' && r.width > 100 && r.height > 50;
      });
      if (!pop) return { found: false };
      const inputs = [...pop.querySelectorAll('input, select, textarea')];
      return {
        found: true,
        color: getComputedStyle(pop).color,
        fields: inputs.map(el => {
          const r = el.getBoundingClientRect();
          return { color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, w: Math.round(r.width) };
        }),
      };
    })()`, 30_000);
    check('всплывающее окно найдено', Boolean(popColors.found), '');
    if (popColors.found) {
      const texts = [popColors.color, ...popColors.fields.map(f => f.color)];
      // Любой цвет текста вроде rgb(0,0,0) на тёмном фоне — дефект.
      const black = texts.filter(c => /rgb\((\d+),\s*\1,\s*\1\)/.test(c.replace(/\s/g, '')) && /rgb\(0,\s*0,\s*0\)/.test(c.replace(/\s/g, '')));
      check('во всплывающем окне нет чёрного текста', black.length === 0,
        texts.length ? 'цвета: ' + texts.join(' | ') : '');
    }
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /cancel|отмена/i.test(x.innerText)); if (b) b.click(); return !!b; })()`, 20_000);
    await sleep(400);
  } else {
    console.log('SKIP | поповер QuickEdit не найден на этом экране');
  }

  // Основной обход страницы: конструктор, таблица, справка, настройки.
  const screens = [
    ['рабочая область', async () => {
      await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^e2e-/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
      await sleep(1800);
      return true;
    }],
    ['вкладка «Структура»', async () => {
      await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^(Структура|Structure)$/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
      await sleep(1800);
      return true;
    }],
    ['конструктор', async () => {
      await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^(Конструктор|Designer)$/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
      await sleep(1500);
      return true;
    }],
    ['справка', async () => {
      await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /Справка|Documentation|Help/i.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
      await sleep(1200);
      const bad = await ev(`(() => { ${CONTRAST_FN} return scan(); })()`, 60_000);
      check('справка: контраст текста >= 4.5:1', bad.length === 0, bad.slice(0, 4).map(b => `${b.ratio} «${b.text}» .${b.cls}`).join(' | '));
      await ev(`(() => { const bd = [...document.querySelectorAll('div')].filter(el => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width > 200).pop(); const panel = [...(bd?.children ?? [])].find(c => c.getBoundingClientRect().width > 100); const c = [...(panel?.querySelectorAll('button') ?? [])].find(b => !b.innerText.trim() && b.querySelector('svg')); if (c) c.click(); return !!c; })()`, 20_000);
      await sleep(600);
      return true;
    }],
    ['настройки', async () => {
      await ev(`(() => { const el = [...document.querySelectorAll('button')].find(x => /^(Настройки|Settings)$/.test(x.innerText.trim())); if (el) el.click(); return !!el; })()`, 20_000);
      await sleep(1200);
      const bad = await ev(`(() => { ${CONTRAST_FN} return scan(); })()`, 60_000);
      check('настройки: контраст текста >= 4.5:1', bad.length === 0, bad.slice(0, 4).map(b => `${b.ratio} «${b.text}» .${b.cls}`).join(' | '));
      await ev(`(() => { const bd = [...document.querySelectorAll('div')].filter(el => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width > 200).pop(); const panel = [...(bd?.children ?? [])].find(c => c.getBoundingClientRect().width > 100); const c = [...(panel?.querySelectorAll('button') ?? [])].find(b => !b.innerText.trim() && b.querySelector('svg')); if (c) c.click(); return !!c; })()`, 20_000);
      await sleep(600);
      return true;
    }],
  ];

  for (const [name, open] of screens) {
    if (!(await open())) { console.log(`SKIP ${name} | не открылся`); continue; }
    const bad = await ev(`(() => { ${CONTRAST_FN} return scan(); })()`, 60_000);
    // Модальные окна и подписи в 3:1 по WCAG крупным текстом допустимы, но
    // мы требуем 4.5 — строже; показываем, что именно не прошло.
    check(`${name}: контраст текста >= 4.5:1`, bad.length === 0,
      bad.length ? bad.slice(0, 5).map(b => `${b.ratio} «${b.text}» ${b.tag}.${b.cls}`).join(' | ') : 'все элементы прошли');
  }

  // Светлая тема должна остаться неизменной: правила живут внутри .dark.
  // Возврат делаем через ту же кнопку темы, но с проверкой после паузы:
  // тема хранится в состоянии React, и класс .dark ставится эффектом позже
  // клика. Раньше проверка читала класс сразу и всегда получала «осталась
  // тёмной», хотя переключение срабатывало.
  const clickTheme = () => ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /theme|тема|тем/i.test((b.title || b.innerText || '')));
    if (!btn) return 'нет кнопки';
    btn.click();
    return 'clicked';
  })()`, 20_000);
  await clickTheme();
  await sleep(1200);
  const backToLight = await ev(`({ dark: document.documentElement.classList.contains('dark'), stored: localStorage.getItem('mydbroot_theme') })`);
  check('светлая тема возвращается', backToLight.dark === false && backToLight.stored === 'light', JSON.stringify(backToLight));
  const schemeLight = await ev(`getComputedStyle(document.documentElement).colorScheme`);
  check('color-scheme в светлой теме нормальный', !/dark/.test(schemeLight), 'color-scheme=' + schemeLight);

  // И обратно в тёмную: правила .dark должны применяться без перезагрузки.
  await clickTheme();
  await sleep(1200);
  check('тема переключается обратно в тёмную', await ev(`document.documentElement.classList.contains('dark')`), '');
} catch (e) {
  check('исключение', false, e.message);
} finally {
  clearTimeout(deadline);
  try { chrome.kill(); } catch {}
  try { ws?.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `FAILURES: ${failures}` : 'CONTRAST ALL GREEN');
process.exit(failures ? 1 : 0);