// Каждый ключ, который код просит через t('…'), должен существовать в переводах.
//
// Зачем: t() при неудаче возвращает сам ключ, и пользователь видит в интерфейсе
// «main.panels.tables» вместо «Таблицы» — ошибка невидима для типов и для
// остальных наборов. Именно так в приложении появились сырые ключи в панелях.
// Обратная проверка (неиспользуемые ключи) — только отчёт: удалять их рискованно,
// а вот отсутствующий ключ — это настоящий дефект.
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translations } from '../src/locales/index.ts';

// Путь к исходникам строим от расположения скрипта: набор запускается из
// backend (`cd backend && npx tsx ../frontend/scripts/…`), и glob относительно
// текущей папки молча нашёл бы ноль файлов — проверка прошла бы вхолостую.
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const LANGS = ['ru', 'en', 'de', 'fr', 'es', 'zh'] as const;
const srcFiles = globSync(SRC_DIR + '/**/*.{ts,tsx}').filter(f => !f.includes('locales/index.ts'));
if (srcFiles.length === 0) {
  console.error('FAIL не найдены исходники: ' + SRC_DIR);
  process.exit(1);
}

function lookup(lang: string, key: string): string | null {
  let value: any = translations[lang];
  for (const part of key.split('.')) {
    if (value && value[part]) value = value[part];
    else return null;
  }
  return typeof value === 'string' ? value : null;
}

// Ключи вида t('…') с литералом. Динамические (t(`main.bulk.${x}`) и t(key))
// пропускаем: их нельзя разрешить статически, и это не дефект.
const literalKeys = new Map<string, Set<string>>();
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
    const key = match[1];
    if (!literalKeys.has(key)) literalKeys.set(key, new Set());
    literalKeys.get(key)!.add(file);
  }
  // Коды ошибок сервера адресуются не через t(), а через таблицу в api.ts
  // (ERROR_CODES: 'explain_readonly' → 'errors.explainReadonly'), поэтому
  // такие ключи тоже считаем использованными — иначе проверка врала бы, что
  // они никому не нужны.
  for (const match of text.matchAll(/'(errors\.[a-zA-Z][\w.]*)'/g)) {
    const key = match[1];
    if (!literalKeys.has(key)) literalKeys.set(key, new Set());
    literalKeys.get(key)!.add(file);
  }
}

const missing: string[] = [];
for (const [key, files] of literalKeys) {
  if (!LANGS.some(lang => lookup(lang, key) !== null)) {
    missing.push(`${key} (${[...files].join(', ')})`);
  }
}

console.log(`литеральных вызовов t('…'): ${literalKeys.size}`);
console.log(missing.length === 0
  ? 'PASS все ключи, которые запрашивает код, есть в переводах'
  : `FAIL отсутствуют ключи: ${missing.length}`);
for (const item of missing.slice(0, 25)) console.log('  - ' + item);

// Отчёт без падения: неиспользуемые ключи — повод навести порядок, но не дефект.
function collect(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const next = path ? `${path}.${k}` : k;
    if (v && typeof v === 'object') collect(v, next, out);
    else out.push(next);
  }
}
const leaves: string[] = [];
collect(translations.ru, '', leaves);
const unused = leaves.filter(key => !literalKeys.has(key) && !['ru'].includes(key));
console.log(`\nсправочно: всего ключей в ru = ${leaves.length}, из них не встречается в коде = ${unused.length}`);
if (unused.length) console.log('  примеры: ' + unused.slice(0, 12).join(', '));

process.exit(missing.length ? 1 : 0);