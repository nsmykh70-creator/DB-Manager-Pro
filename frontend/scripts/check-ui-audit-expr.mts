// Проверка выражений, которые e2e-ui-audit.mjs отправляет в страницу.
//
// Скрипт ни разу не доходил дальше SKIP, а 300 строк браузерного кода,
// написанные без прогона, почти наверняка содержат ошибку. Чаще всего это
// не опечатка, а непарный обратный кавыч или незакрытая скобка во вложенном
// шаблонном литерале — такой код молча ломается в момент подстановки.
//
// Здесь каждое сгенерированное выражение разбирается как JavaScript: берём
// исходник файла, вычисляем те же шаблонные строки и проверяем парсинг.
// Никакого браузера не нужно.
import { readFileSync } from 'node:fs';

const src = readFileSync('e2e-ui-audit.mjs', 'utf8');
const PASSWORD = 'x';

// Вырезаем тела ev(`...`) в виде сырого текста. После закрывающего
// обратного кавычка может идти запятая с таймаутом, а может сразу скобка —
// учитываем оба вида вызовов.
const bodies = [];
const re = /ev\(\s*`([\s\S]*?)`\s*[,)]/g;
let m;
while ((m = re.exec(src)) !== null) {
  bodies.push({ at: src.slice(0, m.index).split('\n').length, raw: m[1], kind: 'ev' });
}

console.log('найдено выражений для страницы:', bodies.length);
if (!bodies.length) { console.log('FAIL | ни одного выражения не найдено — скрипт разбирается не так, как ожидалось'); process.exit(1); }

// Подставляем значения ТЕ ЖЕ, что подставляет сам скрипт. Важно: RegExp.source
// не содержит слэшей, поэтому подставлять надо JSON-строку, а new RegExp(...)
// — именно так это делает аудит. Подстановка вместо new RegExp маскировала бы
// ровно ту ошибку, которую проверка обязана ловить: «^(…)$» без слэшей.
const TOP_TABS_SOURCE = '(Structure|Панели|Конструктор|SQL|Search|Export|Import|Operations|Connections|Структура)$';
const CARD_TABS_SOURCE = '(Structure|Indexes|Relations|Privileges|Triggers|Data preview|SQL|Design|Структура|Индексы)$';
const OPEN_SOURCE = '(Settings|Настройки)$';

let bad = 0;
for (const { at, raw } of bodies) {
  let code = raw
    .replaceAll('${JSON.stringify(PASSWORD)}', JSON.stringify(PASSWORD))
    .replaceAll('${JSON.stringify(id)}', JSON.stringify('a0-abc'))
    .replaceAll('${JSON.stringify(tab)}', JSON.stringify('SQL'))
    .replaceAll('${JSON.stringify(sub)}', JSON.stringify('General'))
    .replaceAll('${scopeSelector || \'\'}', "''")
    .replaceAll('${JSON.stringify(scopeSelector || \'\')}', '""')
    .replaceAll('${JSON.stringify(skipRes || [])}', '[]')
    .replaceAll('${skipRes || []}', '[]')
    .replaceAll('${JSON.stringify(TOP_TABS.source)}', JSON.stringify(TOP_TABS_SOURCE))
    .replaceAll('${JSON.stringify(CARD_TABS.source)}', JSON.stringify(CARD_TABS_SOURCE))
    .replaceAll('${JSON.stringify(m.open.source)}', JSON.stringify(OPEN_SOURCE))
    .replaceAll('${m.open.source}', OPEN_SOURCE);
  // Проверяем именно «${…}»: одиночный «$» лежит в регулярных выражениях
  // вроде /^(×|✕)$/ и к подстановкам отношения не имеет.
  if (/\$\{/.test(code)) {
    const leftover = code.match(/\$\{[^}]*\}/g) ?? [];
    console.log('FAIL строка ' + at + ' | осталась подстановка: ' + leftover.slice(0, 2).join(', '));
    bad++;
    continue;
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('document', 'window', 'HTMLInputElement', 'Request', 'console', code);
  } catch (e) {
    console.log('FAIL строка ' + at + ' | ' + e.message);
    bad++;
  }
}

console.log(bad ? `\nUI AUDIT EXPR FAILURES: ${bad}` : '\nUI AUDIT EXPR ALL GREEN');
process.exit(bad ? 1 : 0);