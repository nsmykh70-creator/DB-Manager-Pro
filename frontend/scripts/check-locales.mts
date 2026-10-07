// Проверка локализации: после слияния additions каждый лист переводов должен быть
// СТРОКОЙ для каждого языка.
//
// Зачем: в additions ключи записаны «сумкой языков» — { ru: '…', en: '…' }.
// Если такую сумку слить обычным вложенным объектом, в переводах окажется объект,
// а t() вернёт сам ключ: панель показывает «panels.tables» вместо «Таблицы».
// Ошибка невидима в типах, поэтому её ловит только этот скрипт.
import { globSync, readFileSync } from 'node:fs';
import { translations } from '../src/locales/index.ts';

const LANGS = ['ru', 'en', 'de', 'fr', 'es', 'zh'] as const;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
}

// Лист перевода — строка. Объект значит, что «сумка языков» не развернулась.
const objectLeaves: string[] = [];
const rawKeys: string[] = [];
let leafCount = 0;

function walk(node: unknown, path: string): void {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object') {
      walk(value, next);
    } else {
      leafCount++;
      if (typeof value !== 'string') {
        objectLeaves.push(next);
      } else if (/^[a-zA-Z]+\.[a-zA-Z][a-zA-Z.]*$/.test(value)) {
        // Значение выглядит как непереведённый ключ — верный признак, что
        // развернулась не та ветка и пользователю покажут «panels.tables».
        // После точки обязательна буква: иначе «Saving...» (многоточие) тоже
        // подходило под ключ и давало ложное срабатывание.
        rawKeys.push(`${next} = "${value}"`);
      }
    }
  }
}

for (const lang of LANGS) {
  walk(translations[lang], '');
}

check('все листья переводов — строки', objectLeaves.length === 0,
  objectLeaves.length ? objectLeaves.slice(0, 5).join(', ') : `листьев: ${leafCount}`);
check('нет значений, похожих на сырые ключи', rawKeys.length === 0,
  rawKeys.length ? rawKeys.slice(0, 5).join('; ') : '');

// Ключи, которые видны в панелях, обязаны быть переведены в каждом языке.
function translate(lang: string, key: string): string {
  let value: any = translations[lang];
  for (const part of key.split('.')) {
    if (value && value[part]) value = value[part];
    else return key;
  }
  return typeof value === 'string' ? value : key;
}

// Ключи панелей лежат по пути main.panels.* — блок panels вложен в раздел main.
// Код вызывал t('panels.tables'), t() возвращал сам ключ, и в панели было видно
// «panels.tables» вместо «Таблицы». Здесь проверяем настоящие пути.
const PANEL_KEYS = [
  'main.panels.tables', 'main.panels.logs', 'main.panels.sqlEditor', 'main.panels.search',
  'main.panels.designer', 'main.panels.serverInfo', 'main.panels.dbUsers', 'main.panels.metrics',
  'main.panels.loadChart', 'main.panels.queryChart', 'main.panels.processes', 'main.panels.dbSizes',
  'main.panels.hint', 'main.panels.focusHint', 'main.panels.focus', 'main.panels.unfocus',
  'main.panels.detach', 'main.panels.dockAll', 'main.panels.reset', 'main.panels.collapse',
  'main.panels.expand', 'main.panels.chipHint', 'main.panels.keyboardHint', 'main.panels.title',
  'main.panels.subtitle', 'main.panels.processesEmpty', 'main.panels.sizesUnavailable'
];

// Ключи панелей, на которые ссылается код: t('panels.…') без префикса main —
// такая ссылка не найдёт ключ и покажет его пользователю.
const srcFiles = globSync('src/**/*.{ts,tsx}');
const badRefs: string[] = [];
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/['"`]([a-zA-Z]+)\.panels\.[a-zA-Z]+['"`]/g)) {
    if (match[1] !== 'main') badRefs.push(`${file}: ${match[0]}`);
  }
}
check('нет ссылок на panels.* без префикса main', badRefs.length === 0,
  badRefs.length ? badRefs.slice(0, 5).join('; ') : `проверено файлов: ${srcFiles.length}`);

for (const key of PANEL_KEYS) {
  const untranslated = LANGS.filter(lang => translate(lang, key) === key);
  check(`переведён ${key}`, untranslated.length === 0,
    untranslated.length ? `не переведён: ${untranslated.join(',')}` : `ru="${translate('ru', key).slice(0, 22)}"`);
}

// Разные языки должны давать разный текст — иначе «сумка» отдаёт один язык всем.
const distinct = new Set(LANGS.map(l => translate(l, 'main.panels.tables')));
check('разные языки дают разные заголовки', distinct.size >= 5, `вариантов: ${distinct.size}`);

// Ключи всплывающего окна быстрого редактирования: лежат по пути quickEdit.*
// на уровне языка (не main.*), проверяем во всех языках.
const QUICK_EDIT_KEYS = ['quickEdit.open', 'quickEdit.apply', 'quickEdit.cancel', 'quickEdit.booleanLabel'];
for (const key of QUICK_EDIT_KEYS) {
  const untranslated = LANGS.filter(lang => translate(lang, key) === key);
  check(`переведён ${key}`, untranslated.length === 0,
    untranslated.length ? `не переведён: ${untranslated.join(',')}` : `ru="${translate('ru', key)}"`);
}
// Ссылка t('quickEdit.…') в коде должна совпадать с реальным путём в переводах.
const qeRefs = [...srcFiles.reduce((acc, f) => acc.concat([...readFileSync(f, 'utf8').matchAll(/['"`](quickEdit\.[a-zA-Z]+)['"`]/g)].map(m => m[1])), [])];
const missing = qeRefs.filter(key => LANGS.some(lang => translate(lang, key) === key));
check('все ссылки quickEdit.* есть в переводах', missing.length === 0,
  missing.length ? `нет таких ключей: ${[...new Set(missing)].join(', ')}` : `ссылок: ${qeRefs.length}`);

console.log(failures ? `LOCALE FAILURES: ${failures}` : 'LOCALE OK');
if (failures) process.exit(1);