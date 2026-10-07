import type { DesignDialect } from '../drivers/helpers.js';

/**
 * Перевод типов колонок при переносе модели с одной СУБД на другую.
 *
 * Модель хранит типы в том виде, в котором их отдала исходная СУБД: снятая с
 * MySQL модель хранит `VARCHAR(100)` и `TEXT`. Раньше это работало случайно —
 * словари MySQL и PostgreSQL сильно пересекаются, и `VARCHAR(100)`/`TEXT`
 * проходили проверку обоих. Oracle так не пересекается: у него `VARCHAR2` и
 * `CLOB`, — и перенос модели в него падал с «Bad column type for oracle:
 * VARCHAR(100)».
 *
 * Поэтому типы переводятся явно, в целевой диалект, ДО проверки allowlist в
 * columnSql(). Неизвестный тип не выдумывается: он уходит как есть, и тогда
 * сообщение «Bad column type» принадлежит самой модели, а не переводу.
 *
 * Автоинкремент отдельно не переводится: SERIAL/BIGSERIAL в Oracle становятся
 * IDENTITY-колонками, но это делает columnSql() по полю autoInc — тип у такой
 * колонки остаётся целочисленным.
 */

/** Нормализация для сравнения: верхний регистр, без пробелов вокруг скобок. */
function norm(type: string): string {
  return String(type ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');
}

/**
 * Типы, у которых параметры (длина, точность) несут смысл и потому
 * переносятся вместе с именем.
 *
 * Список закрытый именно потому, что параметры у остальных типов либо
 * бессмысленны (`TEXT`, `CLOB`, `YEAR(4)`), либо заданы переводом целиком
 * (`TINYINT` → `NUMBER(3)`). Если бы параметры дописывались ко всем типам
 * подряд, то `CHAR(10)` превратился бы в `CHAR` — а Oracle требует длину явно
 * (ORA-00902), и таблица падала бы уже на этапе перевода.
 */
const PARAM_TYPES = new Set([
  'VARCHAR', 'VARCHAR2', 'NVARCHAR', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW',
  'DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE',
  'DOUBLE', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'MEDIUMINT', 'TIMESTAMP'
]);

/**
 * Целочисленные типы, у которых параметр в скобках — ширина отображения.
 *
 * `INT(11)` и `BIGINT(20)` — артефакт MySQL: сервер хранит 4 и 8 байт, а число
 * в скобках игнорирует (с MySQL 8.0.17 выводит предупреждение). PostgreSQL
 * и SQLite такой тип не понимают, а Oracle трактует скобки как точность числа —
 * то есть `BIGINT(20)` превратился бы в NUMBER с 20 знаками, и это уже другая
 * величина. Поэтому вне MySQL/MariaDB ширина отбрасывается, а целочисленный тип
 * берётся по смыслу: SMALLINT → SMALLINT, INT → INTEGER, BIGINT → BIGINT.
 */
const INT_WIDTH_TYPES = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'MEDIUMINT', 'TINYINT']);

/** Тип целого по ширине отображения MySQL — для целей без своих правил. */
const INT_BY_WIDTH: Record<string, string> = {
  TINYINT: 'SMALLINT', SMALLINT: 'SMALLINT', MEDIUMINT: 'INTEGER', INT: 'INTEGER', INTEGER: 'INTEGER', BIGINT: 'BIGINT',
};

/** Правило задаёт тип целиком, вместе с параметрами. */
type Full = Record<string, string>;

/**
 * Перевод по имени типа без параметров.
 *
 * Значение с `(n)` — это полное определение, параметры источника к нему не
 * приписываются: `BIGINT` → `NUMBER(19)` означает «19 цифр», а не «19 плюс то,
 * что было у источника».
 */
const PLAIN: Partial<Record<DesignDialect, Full>> = {
  oracle: {
    // Целые. MySQL TINYINT — байт, MEDIUMINT — три байта, BIGINT — восемь:
    // в Oracle NUMBER с точностью хранит ровно столько цифр.
    TINYINT: 'NUMBER(3)',
    MEDIUMINT: 'NUMBER(7)',
    // INT(11) у MySQL — это «11 цифр», и в Oracle это NUMBER(11), а не голое
    // NUMBER: точность из модели теряться не должна.
    INT: 'NUMBER',
    INTEGER: 'NUMBER',
    BIGINT: 'NUMBER(19)',
    SMALLINT: 'SMALLINT',
    SMALLSERIAL: 'NUMBER(5)',
    BIGSERIAL: 'NUMBER(19)',
    SERIAL: 'NUMBER',
    // TINYINT(1) в MySQL — булево, а не «число из одной цифры».
    BOOL: 'NUMBER(1)',
    BOOLEAN: 'NUMBER(1)',
    DECIMAL: 'NUMBER',
    NUMERIC: 'NUMBER',
    REAL: 'BINARY_FLOAT',
    FLOAT: 'BINARY_FLOAT',
    DOUBLE: 'BINARY_DOUBLE',
    'DOUBLE PRECISION': 'BINARY_DOUBLE',
    // Строки. TEXT/CLOB — длинные строки, TINYTEXT — тоже.
    TEXT: 'CLOB',
    TINYTEXT: 'CLOB',
    MEDIUMTEXT: 'CLOB',
    LONGTEXT: 'CLOB',
    CLOB: 'CLOB',
    NCLOB: 'CLOB',
    BYTEA: 'BLOB',
    BLOB: 'BLOB',
    TINYBLOB: 'BLOB',
    MEDIUMBLOB: 'BLOB',
    LONGBLOB: 'BLOB',
    JSON: 'CLOB',
    JSONB: 'CLOB',
    ENUM: 'VARCHAR2(255)',
    UUID: 'VARCHAR2(36)',
    // Даты и время. Типа TIME у Oracle нет: промежуток времени — это INTERVAL.
    DATETIME: 'TIMESTAMP',
    TIMESTAMPTZ: 'TIMESTAMP WITH TIME ZONE',
    'TIMESTAMP WITH TIME ZONE': 'TIMESTAMP WITH TIME ZONE',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'TIMESTAMP WITH LOCAL TIME ZONE',
    TIME: 'INTERVAL DAY TO SECOND',
    'INTERVAL DAY TO SECOND': 'INTERVAL DAY TO SECOND',
    'INTERVAL YEAR TO MONTH': 'INTERVAL YEAR TO MONTH',
    // MySQL YEAR — четырёхзначное число.
    YEAR: 'NUMBER(4)'
  },
  pg: {
    TINYINT: 'SMALLINT',
    MEDIUMINT: 'INTEGER',
    INT: 'INTEGER',
    INTEGER: 'INTEGER',
    // У PostgreSQL нет ни DOUBLE, ни BOOL: DOUBLE — это double precision,
    // а булево в PG выражается через boolean.
    DOUBLE: 'DOUBLE PRECISION',
    FLOAT: 'DOUBLE PRECISION',
    BOOL: 'BOOLEAN',
    REAL: 'REAL',
    BINARY_FLOAT: 'REAL',
    BINARY_DOUBLE: 'DOUBLE PRECISION',
    // Длинные строки Oracle — обычный TEXT у PG.
    CLOB: 'TEXT',
    NCLOB: 'TEXT',
    RAW: 'BYTEA',
    BLOB: 'BYTEA',
    TINYBLOB: 'BYTEA',
    MEDIUMBLOB: 'BYTEA',
    LONGBLOB: 'BYTEA',
    TEXT: 'TEXT',
    TINYTEXT: 'TEXT',
    MEDIUMTEXT: 'TEXT',
    LONGTEXT: 'TEXT',
    JSON: 'JSONB',
    JSONB: 'JSONB',
    ENUM: 'TEXT',
    UUID: 'UUID',
    YEAR: 'SMALLINT',
    DATETIME: 'TIMESTAMP',
    'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'TIMESTAMPTZ',
    TIME: 'INTERVAL',
    'INTERVAL DAY TO SECOND': 'INTERVAL',
    'INTERVAL YEAR TO MONTH': 'INTERVAL',
    SERIAL: 'SERIAL',
    BIGSERIAL: 'BIGSERIAL',
    SMALLSERIAL: 'SMALLSERIAL'
  },
  mysql: {
    // Oracle NUMBER без точности — обычное целое у MySQL.
    NUMBER: 'BIGINT',
    BINARY_FLOAT: 'FLOAT',
    BINARY_DOUBLE: 'DOUBLE',
    FLOAT: 'FLOAT',
    REAL: 'FLOAT',
    CLOB: 'LONGTEXT',
    NCLOB: 'LONGTEXT',
    BLOB: 'LONGBLOB',
    RAW: 'BLOB',
    BYTEA: 'BLOB',
    TEXT: 'TEXT',
    TINYTEXT: 'TINYTEXT',
    MEDIUMTEXT: 'MEDIUMTEXT',
    JSON: 'JSON',
    JSONB: 'JSON',
    UUID: 'VARCHAR(36)',
    ENUM: 'VARCHAR(255)',
    // INTERVAL у MySQL нет; ближайшее — строковое время.
    'INTERVAL DAY TO SECOND': 'VARCHAR(30)',
    'INTERVAL YEAR TO MONTH': 'VARCHAR(30)',
    DATETIME: 'DATETIME',
    TIMESTAMP: 'DATETIME',
    'TIMESTAMP WITH TIME ZONE': 'DATETIME',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'DATETIME',
    YEAR: 'SMALLINT',
    SERIAL: 'INT',
    BIGSERIAL: 'BIGINT',
    SMALLSERIAL: 'SMALLINT'
  },
  sqlite: {
    NUMBER: 'NUMERIC',
    'BINARY_FLOAT': 'REAL',
    BINARY_DOUBLE: 'REAL',
    FLOAT: 'REAL',
    REAL: 'REAL',
    DOUBLE: 'REAL',
    'DOUBLE PRECISION': 'REAL',
    CLOB: 'TEXT',
    NCLOB: 'TEXT',
    LONGTEXT: 'TEXT',
    MEDIUMTEXT: 'TEXT',
    TINYTEXT: 'TEXT',
    TEXT: 'TEXT',
    BLOB: 'BLOB',
    RAW: 'BLOB',
    BYTEA: 'BLOB',
    LONGBLOB: 'BLOB',
    MEDIUMBLOB: 'BLOB',
    TINYBLOB: 'BLOB',
    JSON: 'TEXT',
    JSONB: 'TEXT',
    UUID: 'TEXT',
    ENUM: 'TEXT',
    INT: 'INTEGER',
    INTEGER: 'INTEGER',
    BIGINT: 'INTEGER',
    MEDIUMINT: 'INTEGER',
    TINYINT: 'INTEGER',
    SMALLINT: 'INTEGER',
    SERIAL: 'INTEGER',
    BIGSERIAL: 'INTEGER',
    SMALLSERIAL: 'INTEGER',
    // INTERVAL у SQLite нет: год и месяц помещаются в строку ISO 8601.
    'INTERVAL DAY TO SECOND': 'TEXT',
    'INTERVAL YEAR TO MONTH': 'TEXT',
    TIME: 'TEXT',
    DATETIME: 'DATETIME',
    TIMESTAMP: 'DATETIME',
    'TIMESTAMP WITH TIME ZONE': 'DATETIME',
    'TIMESTAMP WITH LOCAL TIME ZONE': 'DATETIME',
    YEAR: 'INTEGER'
  }
};

/**
 * Семейства строковых типов: меняется имя, длина переносится по правилам
 * целевой СУБД (обрезка по максимуму, умолчание, когда длина обязательна).
 */
const FAMILY: Partial<Record<DesignDialect, Record<string, string>>> = {
  // NVARCHAR2/CHAR/NCHAR/RAW перечислены «сами в себя» не случайно: имя не
  // меняется, но длина у них всё равно ограничена (NVARCHAR2 и RAW — 2000,
  // CHAR — 2000), и без них обрезки не было бы.
  oracle: { VARCHAR: 'VARCHAR2', NVARCHAR: 'NVARCHAR2', NVARCHAR2: 'NVARCHAR2', NCHAR: 'NCHAR', RAW: 'RAW' },
  pg: { VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR' },
  mysql: { VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR' },
  sqlite: { VARCHAR2: 'VARCHAR', NVARCHAR2: 'VARCHAR' }
};

/** Максимальная длина строкового типа: у Oracle VARCHAR2 — 4000, иначе ORA-12899. */
const MAX_LENGTH: Partial<Record<DesignDialect, Record<string, number>>> = {
  oracle: { VARCHAR2: 4000, NVARCHAR2: 2000, CHAR: 2000, NCHAR: 2000, RAW: 2000 },
  mysql: { VARCHAR: 1000, CHAR: 255 }
};

/** Длина обязательна: без неё СУБД отвергает тип (ORA-00902). */
const LENGTH_REQUIRED: Partial<Record<DesignDialect, Set<string>>> = {
  oracle: new Set(['VARCHAR2', 'NVARCHAR2'])
};

const DEFAULT_LENGTH: Partial<Record<DesignDialect, Record<string, number>>> = {
  oracle: { VARCHAR2: 255, NVARCHAR2: 255 }
};

/** Точные числа: меняется имя, параметры сохраняются (точность обязательна). */
const PARAM_KEEP: Partial<Record<DesignDialect, Record<string, string>>> = {
  oracle: { DECIMAL: 'NUMBER', NUMERIC: 'NUMBER' },
  pg: { DECIMAL: 'NUMERIC' },
  mysql: { NUMERIC: 'DECIMAL', NUMBER: 'DECIMAL' },
  sqlite: { DECIMAL: 'NUMERIC', NUMBER: 'NUMERIC' }
};

function split(type: string): { base: string; length: string | null; precision: string | null } {
  // В базе типа есть и цифры (VARCHAR2, TIMESTAMP(3)), поэтому класс символов
  // должен их включать: иначе «VARCHAR2(100)» не разбирался вовсе и уходил бы
  // в цель без перевода.
  const m = norm(type).match(/^([A-Z_0-9 ]+?)(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/);
  if (!m) return { base: norm(type), length: null, precision: null };
  return { base: m[1], length: m[2] ?? null, precision: m[3] ?? null };
}

/**
 * Переводит тип колонки в диалект целевой СУБД.
 *
 * Возвращает исходный тип без изменений, если перевода для него нет: лучше
 * сообщение «Bad column type for …» от проверки allowlist (оно указывает на
 * модель), чем выдуманный тип, который молча создаст не то.
 */
export function mapColumnType(type: string, target: DesignDialect): string {
  const rules = PLAIN[target];
  const families = FAMILY[target];
  if (!rules && !families) return type;
  const { base, length, precision } = split(type);
  if (!base) return type;

  // TINYINT(1) в MySQL — булево, а не «число из одной цифры».
  if (target === 'oracle' && base === 'TINYINT' && length === '1') return 'NUMBER(1)';

  // 0. INT(11)/BIGINT(20) — ширина отображения MySQL, а не точность числа.
  //    Вне MySQL/MariaDB её надо отбросить: PostgreSQL и SQLite такой тип не
  //    понимают, а Oracle прочитал бы скобки как точность и получил бы не тот
  //    диапазон. Само имя типа переводится обычным правилом ниже.
  if (INT_WIDTH_TYPES.has(base) && target !== 'mysql') {
    // Правило по имени типа уже содержит готовое определение цели — у Oracle
    // это NUMBER(19) для BIGINT (самого BIGINT там нет), поэтому скобки из
    // исходного типа не переносятся, а результат правила используется целиком.
    const plain = PLAIN[target]?.[base];
    if (plain) return plain;
    return INT_BY_WIDTH[base] ?? base;
  }

  // 0. Oracle NUMBER(p[,s]) — самый частый тип в моделях, снятых с Oracle, и
  //    единственный, где параметр решает всё: NUMBER(19) — это 64-битное целое,
  //    а NUMBER(19,2) — денежное. По умолчанию (без точности) подставлять
  // DECIMAL было бы ошибкой: он запрещает 19-значные целые, и перенос модели
  // падал бы уже на вставке данных.
  if (base === 'NUMBER' && target !== 'oracle') {
    return numberToIntegerFamily(length, precision, target);
  }

  // 1. Точные числа: меняем имя, параметры сохраняем.
  const kept = PARAM_KEEP[target]?.[base];
  if (kept) {
    if (length === null) return kept;
    return `${kept}(${length}${precision === null ? '' : `,${precision}`})`;
  }

  // 2. Семейства строк: длина переносится по правилам цели.
  const family = families?.[base];
  if (family) {
    return withLength(target, family, length, precision, base);
  }

  // 3. Остальные правила по имени типа.
  if (rules && Object.prototype.hasOwnProperty.call(rules, base)) {
    const value = rules[base];
    // Значение с параметрами задано целиком, свои к нему не приписываем.
    if (value.includes('(') || length === null || !PARAM_TYPES.has(base)) return value;
    return withLength(target, value, length, precision, base);
  }

  return type;
}

/**
 * Собирает «имя(длина[,точность])» и обрезает длину по максимуму цели.
 *
 * Обрезка нужна и для семейств (`VARCHAR(5000)` → `VARCHAR2(4000)`), и для
 * типов, которые не переименуются, но ограничены: `RAW(4000)` и `CHAR(4000)`
 * у Oracle — те же 2000 байт, а без обрезки ошибка пришла бы уже от сервера,
 * после того как часть переноса прошла.
 */
function withLength(
  target: DesignDialect,
  name: string,
  length: string | null,
  precision: string | null,
  sourceBase: string
): string {
  if (length === null) {
    // Длина обязательна там, где без неё тип отвергается (ORA-00902).
    if (LENGTH_REQUIRED[target]?.has(name)) return `${name}(${DEFAULT_LENGTH[target]?.[name] ?? 255})`;
    return name;
  }
  let n = Number(length);
  const max = MAX_LENGTH[target]?.[name] ?? MAX_LENGTH[target]?.[sourceBase];
  if (max && n > max) n = max;
  return `${name}(${n}${precision === null ? '' : `,${precision}`})`;
}

/**
 * Oracle NUMBER(p[,s]) → целочисленный или точный тип цели.
 *
 * s = 0 или отсутствие s означает целое: Oracle трактует NUMBER(p) как целое,
 * и хранить такие значения в DOUBLE было бы потерей точности.
 *
 * Предел целого у каждой цели свой: BIGINT (PostgreSQL, MySQL) занимает 8 байт
 * и вмещает 19 цифр, а у SQLite INTEGER — те же 8 байт, и NUMERIC поверх
 * REAL, то есть 19-значное целое он не хранит точно. Поэтому широкие NUMBER
 * уходят в точный тип, а не «вдвое увеличенный BIGINT».
 */
function numberToIntegerFamily(
  length: string | null,
  precision: string | null,
  target: DesignDialect
): string {
  const scale = precision === null ? 0 : Number(precision);
  // NUMBER без точности у Oracle = 38 знаков, и это не «просто целое».
  const digits = length === null ? 38 : Number(length);
  const exact: Record<DesignDialect, string> = { oracle: 'NUMBER', pg: 'NUMERIC', mysql: 'DECIMAL', sqlite: 'NUMERIC' };
  const exactWithScale = (d: number, s: number) => (target === 'sqlite' && s > 0 ? 'NUMERIC' : `${exact[target]}(${d},${s})`);
  if (scale > 0) return exactWithScale(digits, scale);
  if (digits <= 5) return { oracle: 'NUMBER', pg: 'SMALLINT', mysql: 'SMALLINT', sqlite: 'INTEGER' }[target];
  if (digits <= 9) return { oracle: 'NUMBER', pg: 'INTEGER', mysql: 'INT', sqlite: 'INTEGER' }[target];
  if (digits <= 19) return { oracle: 'NUMBER', pg: 'BIGINT', mysql: 'BIGINT', sqlite: 'INTEGER' }[target];
  return exact[target];
}

/**
 * Переводит выражение DEFAULT в диалект целевой СУБД.
 *
 * Переводчиков ровно два, и оба — про то, что MySQL пишет битовым литералом, а
 * Oracle его не понимает. `now()` → CURRENT_TIMESTAMP — единственная замена,
 * потому что CURRENT_TIMESTAMP понимают все семь СУБД, а now() не понимает
 * Oracle вовсе.
 */
export function mapDefault(value: string | null | undefined, target: DesignDialect): string | null | undefined {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (target !== 'oracle') return text;
  const bits = text.trim().match(/^b'([01])'$/i);
  if (bits) return bits[1];
  if (/^now\(\)$/i.test(text.trim())) return 'CURRENT_TIMESTAMP';
  return text;
}
