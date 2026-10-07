// Браузерная проверка пользовательских порядков в боковой панели:
// и категорий СУБД (их порядок), и баз внутри категории.
//
// Чистая логика (перестановка списка, localStorage) проверяется в
// frontend/scripts/check-order-store.mts. Здесь проверяется то, что без DOM не
// проверить: что разметка помечена draggable, что на dragstart ставится
// перетаскиваемый ключ, что drop двигает именно тот элемент и что порядок уезжает
// в localStorage и переживает перечитывание списка.
//
// События перетаскивания диспатчатся прямо в страницу (dragstart/dragover/drop
// с настоящим DataTransfer): обработчики React от этого срабатывают так же,
// как от нативного перетаскивания, — нативную механику мыши тут не проверяем.
//
// Запуск:  node e2e-sidebar-order.mjs        (нужен ADMIN_PASSWORD)
// Требования: поднятый стенд и Chrome.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const USER = process.env.E2E_USER ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PORT = Number(process.env.E2E_CDP_PORT ?? 9336);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_PATH ?? ''
].filter(Boolean);

if (!PASSWORD) {
  console.log('SKIP e2e-sidebar-order | не задан ADMIN_PASSWORD: нужен вход в интерфейс');
  process.exit(0);
}
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) {
  console.log('SKIP e2e-sidebar-order | не найден Chrome: негде проверять интерфейс');
  process.exit(0);
}

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'cdp-order-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1680,1050', 'about:blank'
], { stdio: 'ignore' });

let ws;
try {
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { wsUrl = (JSON.parse(await r.text())).webSocketDebuggerUrl; break; }
    } catch { /* Chrome ещё не слушает порт */ }
    await sleep(500);
  }
  if (!wsUrl) throw new Error('Chrome не поднялся');

  ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP не ответил')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, session) =>
    new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: session })); });

  const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  await send('Runtime.enable', {}, session);
  await send('Page.enable', {}, session);
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (res.result?.exceptionDetails) {
      const d = res.result.exceptionDetails;
      throw new Error('ошибка в странице: ' + (d.exception?.description ?? d.text));
    }
    return res.result?.result?.value;
  };

  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(3000);

  const loggedIn = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('label')];
    const byLabel = re => {
      const l = labels.find(x => re.test(x.innerText || ''));
      return l ? (l.querySelector('input') || (l.htmlFor && document.getElementById(l.htmlFor))) : null;
    };
    const user = byLabel(/пользователь|логин|user|name/i);
    const pass = byLabel(/пароль|pass/i) || [...document.querySelectorAll('input[type=password]')][0];
    if (!user || !pass) return false;
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(user, ${JSON.stringify(USER)});
    set(pass, ${JSON.stringify(PASSWORD)});
    const form = pass.closest('form');
    if (form) form.requestSubmit();
    return true;
  })()`);
  if (!loggedIn) throw new Error('не нашли поля входа');
  await sleep(5000);

  // Чистый старт: собственный порядок этого пользователя не должен повлиять на прогон.
  // Домена два — категории СУБД и базы внутри категории.
  const ORDER_DOMAINS = ['dborder:', 'kindorder:'];
  const cleared = await evaluate(`(() => {
    const prefixes = ${JSON.stringify(ORDER_DOMAINS)};
    const keys = Object.keys(localStorage).filter(k => prefixes.some(p => k.startsWith(p)));
    keys.forEach(k => localStorage.removeItem(k));
    return keys;
  })()`);
  check('до прогона порядок был пуст', cleared.length === 0, `удалено ключей: ${cleared.length} ${JSON.stringify(cleared)}`);

  // ── Категории СУБД ───────────────────────────────────────────────────────
  // Порядок категорий задаёт SUPPORTED_KINDS, а пользователь его меняет. Шапка
  // категории — это кнопка с data-kind-key; именно она перетаскивается и на ней
  // же ловится фокус после сдвига стрелками.
  const kindHeaders = `(() => [...document.querySelectorAll('[data-kind-key]')])()`;
  const kindsBefore = await evaluate(`(() => (${kindHeaders}).map(b => b.getAttribute('data-kind-key')))()`);
  check('категории СУБД на месте', kindsBefore.length >= 6, `найдено: ${kindsBefore.join(',')}`);

  const kindMoved = await evaluate(`(() => {
    const hdrs = ${kindHeaders};
    const src = hdrs[0], dst = hdrs[1];
    if (!src || !dst) return { ok: false };
    window.__dt = new DataTransfer();
    src.closest('[draggable="true"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    return { ok: true, payload: window.__dt.getData('text/plain'), src: src.getAttribute('data-kind-key') };
  })()`);
  check('dragstart категории положил ключ с префиксом kind:',
    kindMoved?.ok === true && /^kind:/.test(String(kindMoved.payload)),
    JSON.stringify(kindMoved));
  await sleep(300);
  const kindOver = await evaluate(`(() => {
    const hdrs = ${kindHeaders};
    const dst = hdrs[1];
    const r = dst.closest('[draggable="true"]').getBoundingClientRect();
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientY: r.top + r.height * 0.75 });
    dst.closest('[draggable="true"]').dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  })()`);
  check('dragover категории разрешает drop', kindOver?.prevented === true, JSON.stringify(kindOver));
  await sleep(200);
  await evaluate(`(() => {
    const dst = (${kindHeaders})[1];
    dst.closest('[draggable="true"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    return 1;
  })()`);
  await sleep(600);
  const kindsAfter = await evaluate(`(() => (${kindHeaders}).map(b => b.getAttribute('data-kind-key')))()`);
  check('порядок категорий изменился мышью',
    kindsAfter[0] === kindsBefore[1] && kindsAfter[1] === kindsBefore[0],
    `было: ${kindsBefore.join(',')} → стало: ${kindsAfter.join(',')}`);

  const kindStored = await evaluate(`(() => {
    const k = Object.keys(localStorage).find(x => x.startsWith('kindorder:'));
    if (!k) return null;
    return { key: k, value: JSON.parse(localStorage.getItem(k)) };
  })()`);
  check('порядок категорий сохранён в отдельном домене', typeof kindStored?.key === 'string' && /^kindorder:v\d+:/.test(kindStored.key),
    kindStored?.key ?? 'нет');
  check('сохранён ровно видимый порядок', JSON.stringify(Object.values(kindStored?.value ?? {}).flat()) === JSON.stringify(kindsAfter),
    `в хранилище: ${JSON.stringify(Object.values(kindStored?.value ?? {}).flat())}`);
  const touched = await evaluate(`(() => Object.keys(localStorage).filter(k => k.startsWith('dborder:')))()`);
  check('порядок баз при этом не тронут', touched.length === 0, JSON.stringify(touched));

  // Стрелки по категориям: фокус на шапке, ArrowDown двигает саму категорию.
  const kindKeyMove = await evaluate(`(() => {
    const hdrs = ${kindHeaders};
    const first = hdrs[2] ?? hdrs[0];
    first.focus();
    const focused = document.activeElement === first;
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    first.dispatchEvent(ev);
    return { ok: true, focused, prevented: ev.defaultPrevented, key: first.getAttribute('data-kind-key') };
  })()`);
  check('фокус на шапке категории', kindKeyMove?.focused === true, JSON.stringify(kindKeyMove));
  check('стрелка по категории обработана', kindKeyMove?.prevented === true, JSON.stringify(kindKeyMove));
  await sleep(500);
  const kindsAfterKey = await evaluate(`(() => (${kindHeaders}).map(b => b.getAttribute('data-kind-key')))()`);
  // Позицию берём ДО сдвига и ждём ровно +1: иначе проверка сравнивала бы
  // старую позицию с новым списком и «падала» бы при правильном поведении.
  const beforeIdx = kindsAfter.indexOf(kindKeyMove?.key ?? '');
  const afterIdx = kindsAfterKey.indexOf(kindKeyMove?.key ?? '');
  check('стрелка сдвинула категорию на позицию ниже', beforeIdx >= 0 && afterIdx === beforeIdx + 1,
    `была позиция ${beforeIdx}, стала ${afterIdx} | ${kindsAfterKey.join(',')}`);
  const focusOnKind = await evaluate(`(() => {
    const el = document.activeElement;
    return { tag: el ? el.tagName : null, key: el && el.getAttribute ? el.getAttribute('data-kind-key') : null };
  })()`);
  check('фокус остался на переехавшей категории', focusOnKind?.key === kindKeyMove?.key, JSON.stringify(focusOnKind));

  // Категории и базы после перестановок обязаны пережить перезагрузку.
  await send('Page.navigate', { url: BASE + '/' }, session);
  await sleep(6000);
  const kindsAfterReload = await evaluate(`(() => (${kindHeaders}).map(b => b.getAttribute('data-kind-key')))()`);
  check('порядок категорий пережил перезагрузку', kindsAfterReload.join(',') === kindsAfterKey.join(','),
    `до: ${kindsAfterKey.join(',')} | после: ${kindsAfterReload.join(',')}`);
  await evaluate(`(() => {
    // Базовый стенд очищаем от своего порядка категорий: дальше проверяются базы.
    const prefixes = ${JSON.stringify(ORDER_DOMAINS)};
    Object.keys(localStorage).filter(k => prefixes.some(p => k.startsWith(p))).forEach(k => localStorage.removeItem(k));
    return 1;
  })()`);

  // Ищем группу, где больше одной базы: переставлять нечего в группе из одной.
  const found = await evaluate(`(() => {
    const groups = [...document.querySelectorAll('div.ml-4')].map(g => ({
      dbs: [...g.querySelectorAll('[draggable="true"] button span.truncate')].map(s => (s.innerText || '').trim()),
      rows: [...g.querySelectorAll('[draggable="true"]')]
    })).filter(g => g.dbs.length >= 2);
    if (!groups.length) return { ok: false };
    const g = groups[0];
    return { ok: true, dbs: g.dbs, rows: g.rows.length };
  })()`);
  if (!found?.ok) {
    check('нашли группу с двумя базами', false, JSON.stringify(found));
  } else {
    check('нашли группу с двумя базами', true, found.dbs.join(','));
    check('каждая строка базы помечена draggable', found.rows === found.dbs.length, `строк: ${found.rows}, баз: ${found.dbs.length}`);

    const before = found.dbs;

    // События идут ОТДЕЛЬНЫМИ тиками: обработчики держат перетаскиваемый ключ
    // в состоянии React, а состояние обновляется только на перерисовке. Три
    // события в одном task не дадут React перерисоваться между ними, и такой
    // тест проверял бы не то, что происходит при настоящем перетаскивании.
    // Перетаскиваем первую базу ВНИЗ, на вторую: курсор уходит в нижнюю
    // половину строки, поэтому база должна встать ПОСЛЕ неё.
    await evaluate(`(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      const src = [...g.querySelectorAll('[draggable="true"]')][0];
      window.__dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
      return window.__dt.getData('text/plain');
    })()`);
    check('dragstart положил ключ в dataTransfer',
      (await evaluate(`window.__dt.getData('text/plain')`)) !== '', String(await evaluate(`window.__dt.getData('text/plain')`)));
    await sleep(300);
    const overInfo = await evaluate(`(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      const dst = [...g.querySelectorAll('[draggable="true"]')][1];
      const r = dst.getBoundingClientRect();
      // Нижняя половина строки — «после».
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientY: r.top + r.height * 0.75 });
      dst.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, height: Math.round(r.height) };
    })()`);
    check('dragover разрешает drop (вызвал preventDefault)', overInfo?.defaultPrevented === true, JSON.stringify(overInfo));
    await sleep(200);
    await evaluate(`(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      const dst = [...g.querySelectorAll('[draggable="true"]')][1];
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
      return 1;
    })()`);
    await sleep(700);

    const afterDrop = await evaluate(`(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      const dbs = [...g.querySelectorAll('[draggable="true"] button span.truncate')].map(s => (s.innerText || '').trim());
      const saved = Object.keys(localStorage).filter(k => k.startsWith('dborder:'));
      return { dbs, saved };
    })()`);
    check('порядок в списке изменился (перенос вниз = строка поменялась местами)',
      afterDrop.dbs[0] === before[1] && afterDrop.dbs[1] === before[0],
      `было: ${before.join(',')} → стало: ${afterDrop.dbs.join(',')}`);
    check('порядок сохранён в localStorage', afterDrop.saved.length === 1, JSON.stringify(afterDrop.saved));

    const stored = await evaluate(`(() => {
      const k = Object.keys(localStorage).find(x => x.startsWith('dborder:'));
      return k ? { key: k, value: JSON.parse(localStorage.getItem(k)) } : null;
    })()`);
    check('ключ хранилища версионирован и per-user',
      typeof stored?.key === 'string' && /^dborder:v\d+:/.test(stored.key) && stored.key.endsWith(`:${USER}`),
      stored?.key ?? 'нет');
    check('в сохранении есть ключ перетащенной базы',
      Object.values(stored?.value ?? {}).flat().some((x) => typeof x === 'string' && x.includes(before[0])),
      JSON.stringify(stored?.value));

    // Порядок переживает перечитывание списка: перезагружаем страницу, ничего
    // не переставляя. Ключ строки строится из id подключения и имени базы, а не
    // из позиции, поэтому базы обязаны встать на те же места.
    await send('Page.navigate', { url: BASE + '/' }, session);
    await sleep(6000);
    const afterReload = await evaluate(`(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      return g ? [...g.querySelectorAll('[draggable="true"] button span.truncate')].map(s => (s.innerText || '').trim()) : [];
    })()`);
    check('порядок пережил перезагрузку', afterReload[0] === before[1] && afterReload[1] === before[0],
      `после перезагрузки: ${afterReload.join(',')}`);

    // Клавиатура: фокус на строке базы и стрелка вниз меняют порядок.
    // Перестановка мышью с клавиатуры недоступна, поэтому это второй путь,
    // а не замена первому.
    // Все выборки ниже — ВНУТРИ той же группы, где больше одной базы: первая
    // строка во всём документе может принадлежать другой категории, и стрелка
    // двигала бы не то.
    const groupRows = `(() => {
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      return g ? [...g.querySelectorAll('[data-db-key]')] : [];
    })()`;
    const beforeKeys = await evaluate(`(() => { const r = ${groupRows}; return r.map(b => b.getAttribute('data-db-key')); })()`);
    const movedByKey = await evaluate(`(() => {
      const r = ${groupRows};
      const btn = r[0];
      if (!btn) return { ok: false };
      btn.focus();
      const focused = document.activeElement === btn;
      const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      return { ok: true, focused, prevented: ev.defaultPrevented };
    })()`);
    check('строка базы получает фокус с клавиатуры', movedByKey?.focused === true, JSON.stringify(movedByKey));
    check('стрелка вниз обработана (событие погашено)', movedByKey?.prevented === true, JSON.stringify(movedByKey));
    await sleep(600);
    const afterKeys = await evaluate(`(() => { const r = ${groupRows}; return r.map(b => b.getAttribute('data-db-key')); })()`);
    check('стрелка вниз поменяла порядок',
      afterKeys[0] === beforeKeys[1] && afterKeys[1] === beforeKeys[0],
      `было: ${beforeKeys.join(',')} → стало: ${afterKeys.join(',')}`);
    // Фокус обязан остаться на переехавшей строке: иначе после перерисовки он
    // падает на body и пользователю пришлось бы начинать обход заново.
    const focusKept = await evaluate(`(() => {
      const el = document.activeElement;
      return { tag: el ? el.tagName : null, key: el && el.getAttribute ? el.getAttribute('data-db-key') : null };
    })()`);
    check('фокус остался на переехавшей строке', focusKept?.key === beforeKeys[0], JSON.stringify(focusKept));
    const savedByKey = await evaluate(`(() => {
      const k = Object.keys(localStorage).find(x => x.startsWith('dborder:'));
      return k ? JSON.parse(localStorage.getItem(k)) : null;
    })()`);
    // Сравниваем с порядком ПОСЛЕ сдвига: beforeKeys — это то, что было до стрелки.
    check('клавиатурный порядок сохранён', JSON.stringify(Object.values(savedByKey ?? {}).flat()) === JSON.stringify(afterKeys),
      `в списке: ${afterKeys.join(',')} | в хранилище: ${JSON.stringify(Object.values(savedByKey ?? {}).flat())}`);

    // На краю списка стрелка не гасится: иначе панель не прокручивалась бы.
    const atEdge = await evaluate(`(() => {
      const r = ${groupRows};
      const first = r[0];
      if (!first) return { ok: false };
      first.focus();
      const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      first.dispatchEvent(ev);
      return { ok: true, prevented: ev.defaultPrevented };
    })()`);
    check('на краю списка стрелка не гасится (панель прокручивается)', atEdge?.ok === true && atEdge?.prevented === false, JSON.stringify(atEdge));

    // Кнопка сброса возвращает порядок сервера и чистит хранилище.
    // Возврат в исходное состояние, чтобы следующий прогон был с нуля.
    const reset = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /сбросить порядок|reset order/i.test((x.innerText || '').trim()));
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    })()`);
    check('кнопка сброса порядка есть', reset?.ok === true);
    await sleep(700);
    const afterReset = await evaluate(`(() => {
      const k = Object.keys(localStorage).find(x => x.startsWith('dborder:'));
      const g = [...document.querySelectorAll('div.ml-4')].find(g =>
        [...g.querySelectorAll('[draggable="true"]')].length >= 2);
      return {
        left: k ? localStorage.getItem(k) : null,
        dbs: g ? [...g.querySelectorAll('[draggable="true"] button span.truncate')].map(s => (s.innerText || '').trim()) : []
      };
    })()`);
    check('сброс очистил хранилище', afterReset.left === null, afterReset.left ?? '');
    check('после сброса порядок как в списке сервера', afterReset.dbs.join(',') === before.join(','),
      `ожидали: ${before.join(',')}, получили: ${afterReset.dbs.join(',')}`);
  }
} catch (e) {
  console.log('FAIL прервано | ' + e.message);
  results.push(false);
} finally {
  // Уже сброшено кнопкой в интерфейсе; на случай падения до неё чистим ключи
  // ещё раз, чтобы порядок этого пользователя не остался в панели.
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль мог остаться заблокированным */ }
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nSIDEBAR ORDER: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nSIDEBAR ORDER ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);