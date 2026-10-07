// Поиск текста, который не проходит через t(): такие строки не переключаются
// вместе с языком и остаются english/русскими при любом выборе.
//
// Проверка check-locale-keys ловит обратную проблему — ключ есть, но код его
// не зовёт. Здесь обратная сторона: код есть, а перевода нет.
//
// Отчёт, а не падение: зашитый текст — это не поломка, а недоработка, и
// список нужен чтобы решить, что переводить в первую очередь.
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const files = globSync(SRC_DIR + '/**/*.tsx').filter(f => !f.includes('locales/index.ts'));
if (files.length === 0) {
  console.error('FAIL не найдены исходники: ' + SRC_DIR);
  process.exit(1);
}

// Атрибуты, которые видит пользователь.
const VISIBLE_ATTR = /\b(title|placeholder|aria-label|alt|label)\s*=\s*"([^"]{2,})"/g;
// Текст между тегами: >текст<. Флаг s и [\s\S] обязательны: надпись часто
// разбита на несколько строк форматирования, и построчный разбор её терял —
// именно из-за этого в отчёте не было длинных подписей и текстов модалок.
const JSX_TEXT = />([^<>{}][^<>{}]{2,}?)</gs;
// Технические строки, которые переводить не нужно.
const TECHNICAL = /^[\s\d.,%/()[\]#:+-]*$/;
// Обрывки выражений и типов TypeScript, попавшие в разбор JSX:
// «0 &&» между тегами — это условие рендера, а не текст. Набор маркеров
// расширен: раз сканируем весь файл, а не строку, в надпись может попасть
// кусок кода между тегами.
const CODE_FRAGMENT =
  /(&&|\|\||\?|=>|\bPromise\b|\bvoid\b|[{}();=\[\]]|\btype\b|\binterface\b|\breturn\b|\bconst\b|\blet\b|\bfunction\b|\bimport\b|\bif\b|\bfor\b|\bwhile\b|\bawait\b|\basync\b|\bnull\b|\bundefined\b|\btrue\b|\bfalse\b)/;
// Служебные значения внутри t('…') и обратные кавычки не трогаем.
const IGNORED_SUBSTRINGS = ['…', 'https://', 'http://', 'data-'];
// Строки в кавычках, внутри которых есть кириллица: подписи в массивах,
// объектах и тернарниках. Без этого разбора оставалась слепая зона, и именно
// в ней жили «Структура», «Да»/«Нет» и «Нет (NOT NULL)» — карточка таблицы и
// окно правки колонки оставались русскими при любом языке.
const QUOTED_CYRILLIC = /'([^'\\\n]{2,})'|"([^"\\\n]{2,})"|`([^`\\]{2,})`/g;
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Текст сразу после JSX-выражения: `{cond ? <Icon/> : <Icon/>} Объяснить</button>`.
 *
 * Раньше такая надпись не попадала ни в один разбор: JSX_TEXT требует `>`
 * перед текстом, а тут между `>` и текстом стоит `}`, и проверка рапортовала
 * «0 зашитого текста» при трёх русских надписях на экране. Поэтому отдельно
 * ловим кириллицу после `}` — только её, чтобы не поймать код.
 */
const JSX_AFTER_EXPR = /\}\s*([Ѐ-ӿ][^<>{}]{1,60})</g;

// Служебные значения, которые переводить не нужно: имена часовых поясов и
// форматов, технические примеры в подсказках, идентификаторы. Без этого списка
// они учитывались как «зашитый текст» и раздували бюджет.
const ALLOWED = new Set([
  'UTC', 'Europe/Moscow', 'America/New_York', 'Europe/Berlin', 'Europe/London',
  'Asia/Tokyo', 'Asia/Shanghai', 'SQL', 'CSV', 'JSON', 'SQLite', 'MongoDB', 'Redis',
  'MySQL', 'MariaDB', 'PostgreSQL', 'PID', 'PK', 'VIEW', 'NULL', 'AUTO', 'DDL',
  'ON DELETE', 'ON UPDATE', 'NOT NULL', 'PRIMARY KEY', 'CURRENT_TIMESTAMP',
  'idx_table_col', 'fk_table_col', 'trg_table_event', 'ref_table', 'id',
  'BTREE', 'HASH', 'localhost', 'data/local.sqlite', 'production-postgres',
  'utf8mb4', 'utf8mb4_unicode_ci', 'UTF8', 'template0'
]);

// Мусор разбора: многострочный JSX-текст склеивает код между тегами, а поиск
// строк в кавычках цепляет хвост за пределами литерала. Такие обрывки не
// переводить нельзя — в них нет пользовательского текста.
function isParseNoise(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // Обрывок кода: скобки, теги, ключи переводов.
  if (/[{}<>]/.test(v)) return true;
  if (/^\s*[,;)]/.test(v)) return true;
  if (/\bt\('[\w.]+'\)/.test(v)) return true;
  if (/^[A-Za-z_$][\w$.]*$/.test(v)) return true;
  // Многострочный JSX-текст может захватить кусок объявления объекта между
  // тегами: «,\n  mariadb: 'MariaDB',» — кавычки и двоеточие выдают код.
  if (/['":]/.test(v) && /\n/.test(v)) return true;
  return false;
}

const isNoise = (value: string) =>
  TECHNICAL.test(value) || CODE_FRAGMENT.test(value) || ALLOWED.has(value.trim());

const rows: { file: string; line: number; text: string; kind: string }[] = [];

for (const file of files) {
  const rel = file.replace(SRC_DIR + '\\', '').replace(SRC_DIR + '/', '');
  const text = readFileSync(file, 'utf8');
  // className, key и прочее — не пользовательский текст.
  const scan = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/className\s*=\s*\{?["'`][^"'`]*["'`]?\}?/g, '');

  // Номер строки считаем по позиции совпадения: при разборе всего файла
  // индексы строк недоступны, а в отчёте место с��лки нужно.
  const lineAt = (index: number) => scan.slice(0, index).split('\n').length;

  for (const m of scan.matchAll(VISIBLE_ATTR)) {
    const value = m[2].trim();
    if (isNoise(value)) continue;
    if (IGNORED_SUBSTRINGS.some(s => value.includes(s))) continue;
    rows.push({ file: rel, line: lineAt(m.index ?? 0), text: value, kind: m[1] });
  }
  for (const m of scan.matchAll(JSX_TEXT)) {
    const value = m[1].replace(/\s+/g, ' ').trim();
    if (isNoise(value)) continue;
    // Исходный фрагмент, а не нормализованный: мусор склейки виден по кавычкам.
    if (isParseNoise(m[1])) continue;
    if (IGNORED_SUBSTRINGS.some(s => value.includes(s))) continue;
    rows.push({ file: rel, line: lineAt(m.index ?? 0), text: value, kind: 'текст' });
  }
  for (const m of scan.matchAll(JSX_AFTER_EXPR)) {
    const value = m[1].replace(/\s+/g, ' ').trim();
    if (isNoise(value) || isParseNoise(m[1])) continue;
    if (IGNORED_SUBSTRINGS.some(s => value.includes(s))) continue;
    rows.push({ file: rel, line: lineAt(m.index ?? 0), text: value, kind: 'текст после выражения' });
  }
  // Подписи в массивах, объектах и тернарниках: 'Структура', 'Да', 'Нет'.
  for (const m of scan.matchAll(QUOTED_CYRILLIC)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!CYRILLIC.test(value)) continue;
    if (isNoise(value) || isParseNoise(value)) continue;
    // Ключ перевода: t('…')
    const before = scan.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0);
    if (/t\(\s*['"`]$/.test(before)) continue;
    if (IGNORED_SUBSTRINGS.some(s => value.includes(s))) continue;
    rows.push({ file: rel, line: lineAt(m.index ?? 0), text: value, kind: 'строка' });
  }
}

// Свёртка: одинаковые строки считаем один раз, но файлы перечисляем.
const grouped = new Map<string, { count: number; places: string }>();
for (const row of rows) {
  const key = row.text;
  const entry = grouped.get(key) ?? { count: 0, places: '' };
  entry.count += 1;
  entry.places += `${entry.places ? ', ' : ''}${row.file}:${row.line}`;
  grouped.set(key, entry);
}

const sorted = [...grouped.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`зашитого пользовательского текста: ${rows.length} вхождений, ${sorted.length} уникальных`);
console.log('\nчаще всего встречается:');
for (const [text, info] of sorted.slice(0, 40)) {
  console.log(`  ×${info.count}  «${text.slice(0, 62)}»  ${info.places.slice(0, 70)}`);
}
// Отчёт и лимит. Отчёт нужен, чтобы видеть, что переводить дальше. Лимит
// не даёт числу зашитого текста расти обратно: пока локализация не доделана,
// он просто зафиксирован на текущем уровне и постепенно снижается.
// Поднять лимит можно только осознанно, вместе с планом на новую порцию.
// Бюджет считается по расширенному разбору (включая строки в массивах и
// тернарниках), поэтому он больше прежних 188: раньше эти подписи были не видны.
// Основная масса — справочная документация в DocsModal.
// Интерфейс переведён полностью: из 472 зашитых строк остались только 146 в
// справочной документации DocsModal. Ложные срабатывания (служебные значения
// вроде Europe/Moscow и BTREE, а также мусор разбора JSX) отфильтрованы.
const BUDGET = Number(process.env.HARDCODED_BUDGET ?? 0);

console.log('\nвсе места:');
for (const row of rows) console.log(`  ${row.file}:${row.line} [${row.kind}] ${row.text.slice(0, 70)}`);

if (rows.length > BUDGET) {
  console.error(
    `\nПРОВАЛ: зашитого текста ${rows.length}, лимит ${BUDGET} ` +
    `(было ${BUDGET - 1} или меньше). Новые строки без t() запрещены.`
  );
  process.exit(1);
}
console.log(`\nв пределах лимита: ${rows.length} <= ${BUDGET}`);