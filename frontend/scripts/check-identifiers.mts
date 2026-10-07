// Проверка правил проверки имён (backend/src/drivers/helpers.ts, ident/dbIdent).
//
// Зачем отдельный набор: ident() — единственное место, где панель решает, можно
// ли имя вставить в SQL. Слишком строгое правило означает «панель создала объект
// через SQL и больше не может его открыть» (`#__mywidget` у Joomla), слишком
// мягкое — что имя выйдет за пределы кавычек диалекта. Обе ошибки проверяются
// здесь явно, чтобы правило не «сдвинули» вместе с очередным рефакторингом.
import { ident, dbIdent, quoteIdent } from '../../backend/src/drivers/helpers.js';
// Второе правило имён — в моделях (core/models.ts). Оно жило отдельно и было
// строже: импорт схемы с таблицей `#__mywidget` падал с «Bad table name».
import { validateTables } from '../../backend/src/core/models.js';

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
};
const accepts = (fn: (n: string) => string, name: string) => {
  try { return fn(name) === name; } catch { return false; }
};
const rejects = (fn: (n: string) => string, name: string) => {
  try { fn(name); return false; } catch { return true; }
};

// 1. Имена, которые реально встречаются в базах.
const shouldAccept = [
  'users', 'users_copy', 'mdl_parent', 'Пользователи', 'Users2',
  '#__mywidget', '#__mycomponent', 'my-table', 'my$table', '_tmp1',
  'T1', 'a', '#tmp',
  // `--` и `#` — начало комментария только вне кавычек; имя всегда обёрнуто в
  // кавычки диалекта, поэтому внутри они обычные символы.
  'a--b', 'a#b', '2024-01-01_log', 'a-b-c'
];
for (const n of shouldAccept) {
  check(`ident принимает «${n}»`, accepts(ident, n));
}

// 2. Имена, которые панель обязана отвергнуть: без кавычек это не идентификатор,
//    а после подстановки в обёрнутый в кавычки фрагмент — выход из него.
const shouldReject = [
  '`', '"', "'", 'a`b', 'a"b', "a'b", 'a b', 'a.b', 'a;b', 'a-- b',
  'a/*b', '', 'a\nb', 'a\tb', 'a\\b', 'a(b', 'a)b', 'a,b', 'a+b', 'a=b',
  'a%b', 'a*b', 'DROP TABLE x', '`users` WHERE 1=1--', 'x` , (SELECT 1)',
  'a; DROP TABLE users', 'a/**/'
];
for (const n of shouldReject) {
  check(`ident отвергает ${JSON.stringify(n)}`, rejects(ident, n));
}

// 3. Диагностика: понятное сообщение, а не «Bad undefined».
try { ident('a b', 'table'); check('сообщение называет, что именно не так', false); }
catch (e: any) {
  check('сообщение называет объект и имя',
    /table/.test(e.message) && /a b/.test(e.message) && (e as any).statusCode === 400,
    e.message);
}

// 4. Имя БД мягче имени объекта: MySQL разрешает дефис, а база могла появиться
//    мимо панели (см. комментарий к dbIdent).
for (const n of ['demo', 'my-db', 'db$1', 'Test-DB-1']) {
  check(`dbIdent принимает «${n}»`, accepts(dbIdent, n));
}
for (const n of ['a`b', 'a"b', 'a b', 'a.b', '', 'x'.repeat(65), 'a;b']) {
  check(`dbIdent отвергает ${JSON.stringify(n)}`, rejects(dbIdent, n));
}

// 5. Кавычки диалекта: имя подставляется уже обёрнутым — обратная кавычка
//    внутри недопустима даже при «мягком» правиле.
check('mysql: имя оборачивается в обратные кавычки', quoteIdent('mysql', '#__t') === '`#__t`', quoteIdent('mysql', '#__t'));
check('pg/oracle: имя оборачивается в двойные кавычки', quoteIdent('pg', 'my-table') === '"my-table"', quoteIdent('pg', 'my-table'));

// 6. Модели: то же правило и для имён таблиц/колонок внутри модели.
const modelOk = (name: string) => {
  try {
    validateTables([{ name, columns: [{ name: 'id', type: 'INT', primary: true }] }]);
    return true;
  } catch { return false; }
};
for (const n of ['users', '#__mywidget', '#__mycomponent', 'my-table', 'wp_postmeta', 'Пользователи']) {
  check(`модель принимает «${n}»`, modelOk(n));
}
for (const n of ['a`b', 'a b', 'a.b', 'a;b', 'a"b']) {
  check(`модель отвергает ${JSON.stringify(n)}`, !modelOk(n));
}

const failed = results.filter(x => !x).length;
console.log(failed ? `FAILURES: ${failed}` : `IDENTIFIERS ALL GREEN (${results.length})`);
process.exit(failed ? 1 : 0);
