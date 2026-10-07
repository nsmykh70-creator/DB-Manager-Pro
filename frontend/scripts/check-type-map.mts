// Статическая проверка перевода типов колонок между СУБД.
//
// Перевод нужен при переносе модели: модель хранит лексикон исходной СУБД
// (у MySQL — VARCHAR и TEXT, у PostgreSQL — text/jsonb), а создаёт таблицу
// драйвер целевого подключения со своим allowlist. Без перевода перенос модели
// в Oracle падал с «Bad column type for oracle: VARCHAR(100)», а перенос между
// MySQL и PostgreSQL работал случайно — их словари сильно пересекаются.
//
// Запуск: npm run check:type-map (входит в verify).
import { mapColumnType, mapDefault } from '../../backend/src/core/typemap';
import { checkColumnType } from '../../backend/src/drivers/helpers';

let failures = 0;
const results: boolean[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` | ${extra}` : ''}`);
  results.push(ok);
  if (!ok) failures++;
}

/** Перевод не должен выдавать тип, который цель потом не примет. */
function mapsTo(type: string, target: 'mysql' | 'pg' | 'sqlite' | 'oracle'): boolean {
  const mapped = mapColumnType(type, target);
  try {
    checkColumnType(target, mapped);
    return true;
  } catch {
    return false;
  }
}

// ── 1. Oracle: лексикон MySQL и PostgreSQL ───────────────────────────────────
// Именно это и падало у пользователя: модель с MySQL-типами в Oracle.
{
  const cases: [string, string][] = [
    ['VARCHAR(100)', 'VARCHAR2(100)'],
    ['varchar(64)', 'VARCHAR2(64)'],
    ['TEXT', 'CLOB'],
    ['LONGTEXT', 'CLOB'],
    ['INT', 'NUMBER'],
    ['INTEGER', 'NUMBER'],
    ['BIGINT', 'NUMBER(19)'],
    ['SMALLINT', 'SMALLINT'],
    ['TINYINT', 'NUMBER(3)'],
    ['TINYINT(1)', 'NUMBER(1)'],
    ['MEDIUMINT', 'NUMBER(7)'],
    ['BOOLEAN', 'NUMBER(1)'],
    ['BOOL', 'NUMBER(1)'],
    ['DOUBLE', 'BINARY_DOUBLE'],
    ['FLOAT', 'BINARY_FLOAT'],
    ['DATETIME', 'TIMESTAMP'],
    ['TIMESTAMP', 'TIMESTAMP'],
    ['JSON', 'CLOB'],
    ['BLOB', 'BLOB'],
    ['LONGBLOB', 'BLOB'],
    ['ENUM', 'VARCHAR2(255)'],
    ['UUID', 'VARCHAR2(36)'],
    ['YEAR', 'NUMBER(4)'],
    ['TIME', 'INTERVAL DAY TO SECOND'],
    // Точные числа: точность обязана сохраниться.
    ['DECIMAL(10,2)', 'NUMBER(10,2)'],
    ['NUMERIC(8,3)', 'NUMBER(8,3)'],
    ['DECIMAL', 'NUMBER'],
    ['SERIAL', 'NUMBER']
  ];
  for (const [from, to] of cases) {
    check(`oracle: ${from} → ${to}`, mapColumnType(from, 'oracle') === to, mapColumnType(from, 'oracle'));
  }
  check('oracle: неизвестный тип не выдумывается', mapColumnType('GEOMETRY', 'oracle') === 'GEOMETRY', mapColumnType('GEOMETRY', 'oracle'));
  check('oracle: неизвестный с параметрами не выдумывается', mapColumnType('GEOMETRY(3)', 'oracle') === 'GEOMETRY(3)', mapColumnType('GEOMETRY(3)', 'oracle'));
}

// ── 2. Длина строки в Oracle ограничена 4000 ────────────────────────────────
// Без обрезки модель с MySQL-колонкой VARCHAR(5000) падала бы с ORA-12899 уже
// после создания таблицы — то есть половина переноса прошла бы, а потом всё
// равно упало бы.
check('oracle: длинная строка обрезается до 4000', mapColumnType('VARCHAR(5000)', 'oracle') === 'VARCHAR2(4000)', mapColumnType('VARCHAR(5000)', 'oracle'));
check('oracle: NVARCHAR2 обрезается до 2000', mapColumnType('NVARCHAR2(4000)', 'oracle') === 'NVARCHAR2(2000)', mapColumnType('NVARCHAR2(4000)', 'oracle'));
check('oracle: VARCHAR без длины получает умолчание', mapColumnType('VARCHAR', 'oracle') === 'VARCHAR2(255)', mapColumnType('VARCHAR', 'oracle'));
check('oracle: RAW без длины остаётся как есть', mapColumnType('RAW', 'oracle') === 'RAW', mapColumnType('RAW', 'oracle'));

// ── 2-bis. Ширина отображения целых (INT(11), BIGINT(20)) ───────────────────
// Найдено живым прогоном переноса модели: `INT(11)` уезжал в PostgreSQL и
// SQLite как `INTEGER(11)`, а в Oracle превращался в `NUMBER` с шириной вместо
// типа, и DDL отвергался. Ширина отображения — артефакт MySQL, её значение
// задаёт разрядность, но не диапазон.
for (const [from, pg, sqlite, oracle] of [
  ['INT(11)', 'INTEGER', 'INTEGER', 'NUMBER'],
  ['BIGINT(20)', 'BIGINT', 'INTEGER', 'NUMBER(19)'],
  ['SMALLINT(6)', 'SMALLINT', 'INTEGER', 'SMALLINT'],
  ['MEDIUMINT(9)', 'INTEGER', 'INTEGER', 'NUMBER(7)'],
] as [string, string, string, string][]) {
  check(`ширина ${from} не попадает в pg`, mapColumnType(from, 'pg') === pg, mapColumnType(from, 'pg'));
  check(`ширина ${from} не попадает в sqlite`, mapColumnType(from, 'sqlite') === sqlite, mapColumnType(from, 'sqlite'));
  check(`ширина ${from} не попадает в oracle`, mapColumnType(from, 'oracle') === oracle, mapColumnType(from, 'oracle'));
}
check('MySQL сохраняет ширину отображения', mapColumnType('INT(11)', 'mysql') === 'INT(11)', mapColumnType('INT(11)', 'mysql'));
check('TINYINT(1) → boolean-эквивалент', mapColumnType('TINYINT(1)', 'oracle') === 'NUMBER(1)', mapColumnType('TINYINT(1)', 'oracle'));

// ── 3. PostgreSQL и MySQL: обратный перевод ─────────────────────────────────
{
  const cases: [string, 'pg' | 'mysql', string][] = [
    ['VARCHAR2(100)', 'pg', 'VARCHAR(100)'],
    ['CLOB', 'pg', 'TEXT'],
    ['NUMBER(19)', 'pg', 'BIGINT'],
    ['BINARY_DOUBLE', 'pg', 'DOUBLE PRECISION'],
    ['TIMESTAMP WITH TIME ZONE', 'pg', 'TIMESTAMPTZ'],
    ['INTERVAL DAY TO SECOND', 'pg', 'INTERVAL'],
    ['VARCHAR2(100)', 'mysql', 'VARCHAR(100)'],
    ['CLOB', 'mysql', 'LONGTEXT'],
    ['NUMBER(19)', 'mysql', 'BIGINT'],
    ['TIMESTAMP WITH TIME ZONE', 'mysql', 'DATETIME'],
    ['BYTEA', 'mysql', 'BLOB'],
    ['DECIMAL(10,2)', 'pg', 'NUMERIC(10,2)'],
    ['NUMERIC(10,2)', 'mysql', 'DECIMAL(10,2)'],
    ['NUMBER(10,2)', 'mysql', 'DECIMAL(10,2)']
  ];
  for (const [from, target, to] of cases) {
    check(`${target}: ${from} → ${to}`, mapColumnType(from, target) === to, mapColumnType(from, target));
  }
}

// ── 4. SQLite ───────────────────────────────────────────────────────────────
{
  const cases: [string, string][] = [
    ['VARCHAR2(100)', 'VARCHAR(100)'],
    ['CLOB', 'TEXT'],
    ['NUMBER(19)', 'INTEGER'],
    ['BINARY_DOUBLE', 'REAL'],
    ['TIMESTAMP WITH TIME ZONE', 'DATETIME']
  ];
  for (const [from, to] of cases) {
    check(`sqlite: ${from} → ${to}`, mapColumnType(from, 'sqlite') === to, mapColumnType(from, 'sqlite'));
  }
}

// ── 5. Перевод не ломает то, что уже в словаре цели ────────────────────────
// Модель, снятая с той же СУБД, должна проходить без изменений: иначе перенос
// «сам в себя» испортил бы модель.
{
  const sameEngine: [string, 'mysql' | 'pg' | 'sqlite' | 'oracle'][] = [
    ['INT', 'mysql'], ['VARCHAR(100)', 'mysql'], ['TEXT', 'mysql'], ['DECIMAL(10,2)', 'mysql'],
    ['INTEGER', 'pg'], ['VARCHAR(100)', 'pg'], ['TEXT', 'pg'], ['NUMERIC(10,2)', 'pg'],
    ['INTEGER', 'sqlite'], ['TEXT', 'sqlite'], ['REAL', 'sqlite'],
    ['NUMBER', 'oracle'], ['VARCHAR2(100)', 'oracle'], ['CLOB', 'oracle'], ['TIMESTAMP', 'oracle']
  ];
  for (const [type, target] of sameEngine) {
    const mapped = mapColumnType(type, target);
    check(`${target}: ${type} не меняется`, mapped === type, mapped);
  }
}

// ── 6. Результат перевода всегда принимается целевым allowlist ─────────────
// Главная гарантия: перевод не подставляет тип, который цель отвергнет. Без
// этого проверки выше были бы проверками строковых констант.
{
  const samples = [
    'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'TINYINT(1)', 'MEDIUMINT',
    'VARCHAR(10)', 'VARCHAR(5000)', 'CHAR(10)', 'TEXT', 'LONGTEXT', 'TINYTEXT',
    'MEDIUMTEXT', 'DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'YEAR',
    'DECIMAL(10,2)', 'DECIMAL', 'NUMERIC(8,3)', 'FLOAT', 'DOUBLE',
    'BOOLEAN', 'BOOL', 'JSON', 'JSONB', 'BLOB', 'LONGBLOB', 'MEDIUMBLOB',
    'ENUM', 'UUID', 'BYTEA', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL',
    'BINARY_FLOAT', 'BINARY_DOUBLE', 'VARCHAR2(50)', 'CLOB', 'NCLOB', 'NUMBER', 'NUMBER(19)'
  ];
  for (const target of ['oracle', 'pg', 'mysql', 'sqlite'] as const) {
    const bad = samples.filter(s => !mapsTo(s, target));
    check(`${target}: все переводы принимаются allowlist`, bad.length === 0, `не прошли: ${bad.join(', ')}`);
  }
}

// ── 7. DEFAULT ──────────────────────────────────────────────────────────────
{
  check('oracle: битовый литерал MySQL → число', mapDefault("b'1'", 'oracle') === '1', String(mapDefault("b'1'", 'oracle')));
  check('oracle: now() → CURRENT_TIMESTAMP', mapDefault('now()', 'oracle') === 'CURRENT_TIMESTAMP', String(mapDefault('now()', 'oracle')));
  check('oracle: CURRENT_TIMESTAMP не трогается', mapDefault('CURRENT_TIMESTAMP', 'oracle') === 'CURRENT_TIMESTAMP');
  check('oracle: 0 остаётся 0', mapDefault('0', 'oracle') === '0');
  check('pg: битовый литерал не трогается', mapDefault("b'1'", 'pg') === "b'1'", String(mapDefault("b'1'", 'pg')));
  check('null остаётся null', mapDefault(null, 'oracle') === null);
  check('undefined остаётся undefined', mapDefault(undefined, 'oracle') === undefined);
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nTYPE MAP: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nTYPE MAP ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);