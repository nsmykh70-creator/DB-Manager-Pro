import { isWriteSql } from '../core/sql-classifier.js';
import { withCode } from '../core/errcodes.js';

export function ident(name: string, what = 'identifier'): string {
  // Буквы любых алфавитов (кириллица в т.ч.), цифры, подчёркивание, а также
  // # $ -: их используют CMS и служебные таблицы (`#__mywidget` у Joomla,
  // `my-table`), и SQL-редактор панели такие имена создаёт без вопросов.
  // Раньше они проходили только через SQL, а карточка таблицы отвечала 400
  // «Bad table» — то есть панель создавала объекты, которыми не могла управлять.
  //
  // Кавычки, обратные кавычки, пробелы, точки и точка с запятой по-прежнему
  // запрещены: драйвер подставляет имя в запрос уже обёрнутым в кавычки диалекта
  // (см. quoteIdent), и без escape-а именно эти символы выпустили бы значение
  // за пределы идентификатора.
  if (!/^[\p{L}0-9_#$?-]+$/u.test(name)) {
    // Код ошибки нужен интерфейсу: само правило длинное, а пользователю важно
    // понять, какие символы допустимы, а не где именно регулярное выражение.
    throw withCode(Object.assign(new Error(`Bad ${what}: ${name}`), { statusCode: 400 }), 'bad_identifier');
  }
  return name;
}

/**
 * Имя БД для чтения — мягче, чем ident().
 *
 * ident() намеренно строгий: имена таблиц и колонок панель создаёт сама, и лишний
 * символ там — это ошибка пользователя. С именем базы дело иное: база могла появиться
 * на сервере помимо панели (или остаться от старой версии), и MySQL вполне допускает
 * дефис в имени БД, если оно обёрнуто в обратные кавычки — их и подставляет драйвер.
 * Из-за строгого ident() чтение из такой базы падало с «Bad database: my-db» (400),
 * хотя `USE ` + обратные кавычки отрабатывали нормально.
 *
 * Разрешаем буквы (любые алфавиты), цифры, подчёркивание, дефис и $; точка, двоеточие,
 * кавычки и пробелы по-прежнему запрещены. Предел 64 — как у MySQL.
 */
export function dbIdent(name: string): string {
  const value = name.trim();
  if (!value || value.length > 64 || !/^[\p{L}0-9_$-]+$/u.test(value)) {
    throw Object.assign(new Error(`Bad database: ${name}`), { statusCode: 400 });
  }
  return value;
}

/**
 * Собирает WHERE из строки фильтра панели для конкретного диалекта.
 *
 * Зачем отдельная функция, если каждый драйвер уже умеет строить WHERE сам: условия
 * чтения и условия массовой правки обязаны быть ОДНИМИ И ТЕМИ ЖЕ. Если getPage
 * и updateRowsBulk разойдутся, то предпросмотр покажет одно число строк, а операция
 * затронет другое — худший вид расхождения в панели, где всё завязано на
 * «сначала посмотри, потом подтверди». Общая функция делает расхождение
 * структурно невозможным.
 *
 * `placeholder(i)` возвращает текст плейсхолдера для i-го параметра ($1 для
 * PostgreSQL, ? для MySQL/SQLite), `like` задаёт разновидность LIKE.
 */
export function buildWhere(
  filter: string | undefined,
  quote: (column: string) => string,
  opts: { placeholder: (index: number) => string; like: 'plain' | 'ilike' | 'escape' }
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const c of parseFilter(filter) ?? []) {
    // Имя колонки уже проверено ident() внутри parseFilter
    const col = quote(c.column);
    if (c.op === '~' || c.op === '^' || c.op === '$') {
      params.push(likePattern(c.value, c.op));
      const ph = opts.placeholder(params.length);
      parts.push(
        opts.like === 'ilike' ? `${col}::text ILIKE ${ph}`
          : opts.like === 'escape' ? `${col} LIKE ${ph} ESCAPE '\\'`
            : `${col} LIKE ${ph}`
      );
      continue;
    }
    const ph = opts.placeholder(params.length + 1);
    parts.push(`${col} ${c.op} ${ph}`);
    params.push(filterValue(c.op, c.value));
  }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Убрать комментарии (-- , #, слэш-звёздочный блок), сохранив строковые литералы.
 *  Нужно перед любыми проверками формы SQL: иначе комментарий-префикс перед
 *  DELETE делает запрос невидимым для классификатора. `--` считается
 *  комментарием только с пробелом (правило MySQL), иначе ломается `SELECT 1--2`. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const nx = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        const s = sql[i];
        out += s;
        i++;
        if (s === '\\' && quote === "'") { if (i < sql.length) { out += sql[i]; i++; } continue; }
        if (s === quote) {
          if (sql[i] === quote) { out += sql[i]; i++; continue; }
          break;
        }
      }
      continue;
    }
    if (c === '-' && nx === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && nx === '*') {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Первое значимое слово стейтмента (без скобок и комментариев). */
function leadingKeyword(code: string): string {
  const m = code.replace(/^\(*\s*/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1].toUpperCase() : '';
}

/** Есть ли уже ограничение выдачи на верхнем уровне (вне подзапросов). */
function hasRowLimit(code: string): boolean {
  let depth = 0;
  let i = 0;
  const words: string[] = [];
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < code.length) {
        if (code[i] === '\\' && quote === "'") { i += 2; continue; }
        if (code[i] === quote) { if (code[i + 1] === quote) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < code.length && /[A-Za-z0-9_]/.test(code[i])) i++;
      if (depth === 0) words.push(code.slice(start, i).toUpperCase());
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i++;
      while (i < code.length && /[0-9.]/.test(code[i])) i++;
      if (depth === 0) words.push(code.slice(start, i));
      continue;
    }
    i++;
  }
  for (let k = 0; k < words.length; k++) {
    if (words[k] === 'LIMIT' || words[k] === 'OFFSET') return true;
    if (words[k] === 'TOP' && /^\d+$/.test(words[k + 1] ?? '')) return true;
    if (words[k] === 'FETCH' && words[k + 1] === 'FIRST') return true;
  }
  return false;
}

/** Грубая защита от выдачи всей таблицы: если SELECT (или WITH..SELECT) без
 *  LIMIT — дописываем LIMIT. Комментарии и подзапросные LIMIT учитываются. */
export function capSelect(sql: string, maxRows: number): string {
  const limit = Math.max(1, Math.floor(Number(maxRows)) || 1);
  const code = stripSqlComments(sql).trim();
  if (!code) return sql;
  const head = leadingKeyword(code);
  if (head !== 'SELECT' && head !== 'WITH') return sql;
  // WITH ... INSERT/UPDATE/DELETE — не SELECT, LIMIT ему не нужен
  if (head === 'WITH' && isWriteSql(code)) return sql;
  if (hasRowLimit(code)) return sql;
  return `${code.replace(/;\s*$/, '')} LIMIT ${limit}`;
}

/**
 * То же ограничение выдачи для Oracle, у которого нет LIMIT. Есть два отличия:
 * родное FETCH NEXT n ROWS ONLY и то, что ROWNUM/двойной FETCH проверяем
 * отдельно — общий hasRowLimit() про ROWNUM не знает (его пишут как
 * `WHERE ROWNUM <= 10`, и это уже ограничение).
 */
export function capSelectOracle(sql: string, maxRows: number): string {
  const limit = Math.max(1, Math.floor(Number(maxRows)) || 1);
  const code = stripSqlComments(sql).trim();
  if (!code) return sql;
  const head = leadingKeyword(code);
  if (head !== 'SELECT' && head !== 'WITH') return sql;
  if (head === 'WITH' && isWriteSql(code)) return sql;
  if (hasRowLimit(code)) return sql;
  if (/\bROWNUM\b/i.test(code)) return sql;
  return `${code.replace(/;\s*$/, '')} FETCH NEXT ${limit} ROWS ONLY`;
}

export type FilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '^' | '$';

export interface FilterCond {
  column: string;
  op: FilterOp;
  value: string;
}

/** Разбор фильтра строк таблицы: `col=value`, `col>5`, `col~text`, несколько
 *  условий через AND. Только белый список операторов и ident() на колонке —
 *  произвольный мусор раньше молча игнорировался и панель показывала все строки. */
export function parseFilter(filter?: string | null): FilterCond[] | null {
  if (filter === undefined || filter === null) return null;
  const raw = filter.trim();
  if (!raw) return null;
  if (raw.length > 500) throw Object.assign(new Error('Filter too long (500 chars)'), { statusCode: 400 });
  const parts = raw.split(/\s+AND\s+/i);
  if (parts.length > 20) throw Object.assign(new Error('Too many filter conditions (max 20)'), { statusCode: 400 });
  const out: FilterCond[] = [];
  for (const part of parts) {
    const m = part.trim().match(/^([\p{L}0-9_]+)\s*(>=|<=|!=|<>|~=|\^=|\$=|=|~|\^|>|<)\s*(.*)$/u);
    if (!m) throw Object.assign(new Error(`Bad filter condition: "${part.trim()}" (expected col=value|!=|<|>|<=|>=|~|^|$ joined by AND)`), { statusCode: 400 });
    const column = ident(m[1], 'column');
    const raw: string = m[2];
    let op: FilterOp = raw as FilterOp;
    if (raw === '~=') op = '~';
    if (raw === '^=') op = '^';
    if (raw === '$=') op = '$';
    if (raw === '<>') op = '!=';
    let value = m[3].trim();
    if ((value.startsWith("'") && value.endsWith("'") && value.length >= 2) || (value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (!value) throw Object.assign(new Error(`Empty value in filter: "${part.trim()}"`), { statusCode: 400 });
    if (value.length > 200) throw Object.assign(new Error('Filter value too long (200 chars)'), { statusCode: 400 });
    if (op !== '~' && op !== '^' && op !== '$') {
      // Значение всегда уходит bind-параметром, поэтому инъекции нет, но мусор
      // вида `1 OR 1=1` / `x; DROP TABLE t` отсекаем — иначе фильтр молча
      // ничего не найдёт и пользователь решит, что данных нет.
      if (/[()'"`;,]/.test(value)) throw Object.assign(new Error(`Bad filter value for "${column}" (quotes/brackets not allowed with ${raw})`), { statusCode: 400 });
      if (/\b(OR|AND|UNION|SELECT|INSERT|DELETE|UPDATE|DROP|ALTER|TRUNCATE)\b|--|\/\*/i.test(value)) {
        throw Object.assign(new Error(`Bad filter value for "${column}": SQL is not allowed in a filter value`), { statusCode: 400 });
      }
    }
    out.push({ column, op, value });
  }
  return out;
}

/** LIKE-шаблон: экранируем спецсимволы, чтобы пользовательский текст не стал
 *  метасимволом (*, %, _). */
export function likePattern(value: string, mode: '~' | '^' | '$'): string {
  const escaped = value.replace(/[\\%_]/g, (m) => `\\${m}`);
  return mode === '~' ? `%${escaped}%` : mode === '^' ? `${escaped}%` : `%${escaped}`;
}

/** Значение для передачи в драйвер: сравнение с числом, если значение числовое. */
export function filterValue(op: FilterOp, value: string): string | number {
  if (op !== '~' && op !== '^' && op !== '$' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what = 'query'): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${what} timeout ${ms}ms`), { statusCode: 504 })), ms); });
  try {
    return await Promise.race([p, to]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Подсчёт стейтментов с учётом строковых литералов '...' (с ''), "...", `...` и комментариев -- /* *‍/ . */
export function countStatements(script: string): number {
  let n = 0;
  let cur = '';
  let q: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    const nx = script[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && nx === '/') { blockComment = false; i++; }
      continue;
    }
    if (q) {
      cur += c;
      if (c === q) {
        if (q === `'` && nx === `'`) { cur += nx; i++; } // '' внутри строки
        else q = null;
      }
      continue;
    }
    if (c === '-' && nx === '-') { lineComment = true; i++; continue; }
    if (c === '/' && nx === '*') { blockComment = true; i++; continue; }
    if (c === `'` || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === ';') {
      if (cur.trim()) n++;
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) n++;
  return n;
}

/**
 * Разбить скрипт на отдельные стейтменты. Точки с запятой внутри строк,
 * комментариев, dollar-quoted блоков ($$...$$) и тел BEGIN...END не считаются,
 * поэтому CREATE TRIGGER/FUNCTION с многострочным телом остаётся одним
 * стейтментом. CASE...END внутри тела учитывается отдельно, чтобы его END
 * не закрыл блок.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let dollar: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let beginDepth = 0;
  let caseDepth = 0;
  const flush = () => {
    const s = cur.trim().replace(/;+$/, '');
    if (s) out.push(s);
    cur = '';
  };
  // Ключевое слово в текущей позиции, если перед ним граница идентификатора.
  const wordAt = (i: number): string => {
    const before = i === 0 || !/[A-Za-z0-9_$]/.test(script[i - 1]);
    if (!before) return '';
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i));
    if (!m) return '';
    const after = script[i + m[0].length];
    return after === undefined || !/[A-Za-z0-9_$]/.test(after) ? m[0].toUpperCase() : '';
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    const nx = script[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && nx === '/') { blockComment = false; i++; }
      continue;
    }
    if (dollar) {
      if (c === '$' && script.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (q) {
      cur += c;
      if (c === q) {
        if (q === `'` && nx === `'`) { cur += nx; i++; }
        else q = null;
      }
      continue;
    }
    if (c === '-' && nx === '-') { lineComment = true; i++; continue; }
    if (c === '/' && nx === '*') { blockComment = true; i++; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(script.slice(i));
      if (m) { dollar = m[0]; cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === `'` || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === ';') {
      if (beginDepth > 0) { cur += c; continue; }
      flush();
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const w = wordAt(i);
      if (w === 'BEGIN') {
        // BEGIN TRANSACTION/WORK и т.п. — не тело, а самостоятельная конструкция
        const rest = script.slice(i + 5).trimStart().split(/[\s;]/, 1)[0].toUpperCase();
        if (!['TRANSACTION', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(rest)) beginDepth++;
      } else if (w === 'CASE') {
        caseDepth++;
      } else if (w === 'END') {
        if (caseDepth > 0) caseDepth--;
        else if (beginDepth > 0) beginDepth--;
      }
      cur += script.slice(i, i + w.length);
      i += w.length - 1;
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}
/** Минимальный CSV-парсер: кавычки, запятые, переносы внутри кавычек, \r\n. */
export function parseCsv(text: string): { columns: string[]; rows: Record<string, unknown>[] } {
  const cells: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cells.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* ждём \n */ }
    else cur += c;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') cells.push(row);
  const nonEmpty = cells.filter((r) => r.some((x) => x !== ''));
  if (!nonEmpty.length) return { columns: [], rows: [] };
  const columns = nonEmpty[0].map((h, i) => h.trim() || `col${i + 1}`);
  const rows = nonEmpty.slice(1).map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c] = r[i] ?? ''; });
    return o;
  });
  return { columns, rows };
}

export type SqlDialect = 'mysql' | 'pg' | 'sqlite' | 'oracle';

/** Кавычки идентификаторов под диалект (имена уже проверены ident()). */
export function quoteIdent(d: SqlDialect, name: string): string {
  return d === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

/** SQL-литерал значения для дампа. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').slice(0, 19)}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replaceAll(`'`, `''`)}'`;
  return `'${String(v).replaceAll(`'`, `''`)}'`;
}

/** INSERT-строка дампа: INSERT INTO `t` (`a`) VALUES (...); */
export function insertStatement(d: SqlDialect, table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  const q = (n: string) => quoteIdent(d, n);
  return `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`;
}

/** CSV-строка (заголовок отдельным вызовом с columns). */
export function csvLine(columns: string[], row?: Record<string, unknown>): string {
  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return row ? columns.map((c) => esc(row[c])).join(',') : columns.join(',');
}

export type DesignDialect = 'mysql' | 'pg' | 'sqlite' | 'oracle';

const TYPE_PATTERNS: Record<DesignDialect, RegExp> = {
  // TINYINT(1) и DECIMAL без параметров — законные типы MySQL, их не было в
  // allowlist, и модель, снятая с MySQL, переносилась в MySQL же только потому,
  // что её типы никуда не переводились. Ширина отображения (`INT(11)`,
  // `BIGINT(20)`) у MySQL тоже законна — сервер её игнорирует, но отвергать
  // такую модель нельзя.
  mysql: /^(INT|INTEGER|BIGINT|SMALLINT|MEDIUMINT|TINYINT)(\(\d{1,3}\))?|VARCHAR\(\d{1,5}\)|CHAR\(\d{1,255}\)|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|DATETIME|TIMESTAMP|DATE|TIME|YEAR|DECIMAL(\(\d{1,65},\d{1,30}\))?|NUMERIC(\(\d{1,65},\d{1,30}\))?|FLOAT|DOUBLE|BOOLEAN|BOOL|JSON|BLOB|MEDIUMBLOB|LONGBLOB$/i,
  // INTERVAL и UUID — законные типы PostgreSQL; без них модель с Oracle
  // (INTERVAL DAY TO SECOND, UUID) не переносилась: перевод давал верный тип,
  // а allowlist его отвергал. CITEXT — регистронезависимый текст из одноимённого
  // расширения, частый в реальных схемах.
  pg: /^(SERIAL|BIGSERIAL|SMALLSERIAL|INTEGER|INT|BIGINT|SMALLINT|VARCHAR\(\d{1,10000}\)|CHAR\(\d{1,10000}\)|TEXT|CITEXT|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|UUID|MONEY|NUMERIC(\(\d{1,1000}(,\d{1,1000})?\))?|DECIMAL(\(\d{1,1000}(,\d{1,1000})?\))?|REAL|DOUBLE PRECISION|BOOLEAN|JSONB?|BYTEA)$/i,
  // DECIMAL/NUMERIC с точностью и BOOL — то же, что для остальных диалектов:
  // типы из моделей, снятых с MySQL, иначе не переносятся.
  sqlite: /^(INTEGER|TEXT|REAL|BLOB|NUMERIC(\(\d{1,3}(,\d{1,3})?\))?|DECIMAL(\(\d{1,3}(,\d{1,3})?\))?|VARCHAR\(\d{1,10000}\)|CHAR\(\d{1,10000}\)|DATETIME|DATE|BOOLEAN|BOOL)$/i,
  // Oracle: NUMBER с точностью, VARCHAR2/NVARCHAR2/CHAR/NCHAR/RAW с длиной,
  // TIMESTAMP с точностью и оба INTERVAL — всё это приходит из моделей и из
  // panel-схем, и раньше отсекался allowlist'ом.
  oracle: /^(NUMBER(\(\d{1,5}(,\d{1,5})?\))?|INTEGER|INT|SMALLINT|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|VARCHAR2\(\d{1,4000}\)|NVARCHAR2\(\d{1,2000}\)|CHAR\(\d{1,2000}\)|NCHAR\(\d{1,2000}\)|RAW\(\d{1,2000}\)|CLOB|NCLOB|BLOB|DATE|TIMESTAMP(\(\d{1,3}\))?|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITH LOCAL TIME ZONE|INTERVAL DAY TO SECOND|INTERVAL YEAR TO MONTH)$/i
};

/** ENUM/SET MySQL со списком строковых значений: проверяется отдельно, т.к.
 *  в общий RegExp список литералов не вписать. */
function checkEnumSet(t: string): string | null {
  const m = /^((?:ENUM|SET))\s*\(([\s\S]+)\)$/i.exec(t.trim());
  if (!m) return null;
  const body = m[2].trim();
  if (!body) return null;
  // Делим по запятым вне кавычек, каждое значение — 'строка' с ''-эскейпом.
  const values: string[] = [];
  let cur = '', q = false, i = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      if (q && body[i + 1] === "'") { cur += "''"; i++; continue; }
      q = !q; cur += c; continue;
    }
    if (c === ',' && !q) { values.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  values.push(cur.trim());
  if (!values.length || values.length > 65535) return null;
  for (const v of values) {
    if (!/^'([^']|'')*'$/.test(v) || v.length > 1024) return null;
  }
  return `${m[1].toUpperCase()}(${values.join(',')})`;
}

/** Проверка типа колонки против allowlist диалекта. Возвращает нормализованный тип. */
export function checkColumnType(d: DesignDialect, type: string): string {
  const t = type.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!t) throw Object.assign(new Error(`Bad column type for ${d}: ${type}`), { statusCode: 400 });
  if (d === 'mysql') {
    const es = checkEnumSet(type);
    if (es) return es;
  }
  if (!TYPE_PATTERNS[d].test(t)) throw Object.assign(new Error(`Bad column type for ${d}: ${type}`), { statusCode: 400 });
  return t;
}

/** Проверка DEFAULT: литерал/число/CURRENT_* плюс функции движков по белому
 *  списку (NOW(), UUID-генераторы, SYSDATE/SYSTIMESTAMP, nextval). Без списка
 *  это был 400 на каждую реальную схему с `DEFAULT now()` или дефолтом
 *  последовательности. Возвращает null если пусто. */export function checkDefault(def: string | null | undefined, d?: DesignDialect): string | null {
  if (def == null || String(def).trim() === '') return null;
  const v = String(def).trim();
  if (/^('([^']|'')*'|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE|-?\d+(\.\d+)?)$/i.test(v)) {
    return v;
  }
  // Функциональные дефолты — только из белого списка, с точностью в скобках.
  const fn = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(\(\s*\d*\s*\))?$/i.exec(v);
  if (fn) {
    const name = fn[1].toUpperCase();
    const allowed: Partial<Record<DesignDialect, Set<string>>> = {
      mysql: new Set(['NOW', 'CURRENT_TIMESTAMP', 'UUID', 'CURDATE', 'CURTIME']),
      pg: new Set(['NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'GEN_RANDOM_UUID', 'UUID_GENERATE_V4']),
      sqlite: new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'DATETIME']),
      oracle: new Set(['SYSDATE', 'SYSTIMESTAMP', 'CURRENT_TIMESTAMP', 'CURRENT_DATE']),
    };
    const set = (d && allowed[d]) || new Set([...allowed.mysql!, ...allowed.pg!, ...allowed.sqlite!, ...allowed.oracle!]);
    if (set.has(name)) return v;
  }
  // nextval('seq'::regclass) — стандартный дефолт serial-колонок PG.
  if (/^nextval\s*\(\s*'[^']+'(::regclass)?\s*\)$/i.test(v)) return v;
  throw Object.assign(new Error(`Bad default: ${def}`), { statusCode: 400 });
}

/**
 * SELECT для CREATE VIEW: только чтение (SELECT/WITH без пишущих стейтментов),
 * иначе через «создание представления» можно выполнить любую запись.
 * Возвращает очищенный текст без концевого `;`.
 */
export function checkViewSql(sql: string): string {
  const raw = String(sql ?? '');
  if (!raw.trim()) throw Object.assign(new Error('View SELECT is required'), { statusCode: 400 });
  if (raw.length > 100_000) throw Object.assign(new Error('View SELECT too large (100KB)'), { statusCode: 413 });
  const code = stripSqlComments(raw).trim();
  const head = leadingKeyword(code);
  if (head !== 'SELECT' && head !== 'WITH') {
    throw Object.assign(new Error('View definition must be a SELECT (or WITH ... SELECT) query'), { statusCode: 400 });
  }
  if (isWriteSql(code)) {
    throw Object.assign(new Error('View definition must be read-only'), { statusCode: 400 });
  }
  if (splitStatements(code).length > 1) {
    throw Object.assign(new Error('View definition must be a single SELECT statement'), { statusCode: 400 });
  }
  return code.replace(/;\s*$/, '');
}

export interface ColumnSpec { name: string; type: string; nullable?: boolean; primary?: boolean; autoInc?: boolean; default?: string | null; comment?: string | null; }
export interface IndexSpec { name: string; columns: string[]; unique?: boolean; type?: string; where?: string }
export interface ForeignKeySpec { name?: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: string; onUpdate?: string }

export function escSqlString(s: string): string {
  return `'${s.replaceAll(`'`, `''`)}'`;
}

export type DbUserKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb' | 'redis' | 'oracle';

/**
 * Имя пользователя СУБД — по одному набору на движок (пределы и алфавиты из
 * документации). Раньше правило было одно на всех (`[A-Za-z0-9_]{3,32}`) и
 * резало валидные имена: PG-роли до 63 символов, Oracle с `#`, Mongo с `-`.
 * Без kind ведёт себя как раньше — для обратной совместимости.
 */
export function validateDbUserName(name: string, kind?: DbUserKind | string): string {
  const rules: Record<string, { max: number; re: RegExp; hint: string }> = {
    mysql: { max: 32, re: /^[A-Za-z0-9_.$-]{3,32}$/, hint: '3-32: латиница, цифры, _ . $ -' },
    mariadb: { max: 32, re: /^[A-Za-z0-9_.$-]{3,32}$/, hint: '3-32: латиница, цифры, _ . $ -' },
    postgres: { max: 63, re: /^[A-Za-z_][A-Za-z0-9_$]{2,62}$/, hint: 'до 63, начинается с буквы/_' },
    oracle: { max: 30, re: /^[A-Za-z][A-Za-z0-9_$#]{2,29}$/, hint: 'до 30, начинается с буквы' },
    mongodb: { max: 64, re: /^[A-Za-z0-9_-]{3,64}$/, hint: '3-64: латиница, цифры, _ -' },
    redis: { max: 64, re: /^[A-Za-z0-9_.\-:]{3,64}$/, hint: '3-64: латиница, цифры, _ . - :' },
  };
  const rule = (kind && rules[kind]) || { max: 32, re: /^[A-Za-z0-9_]{3,32}$/, hint: '3-32 alphanum/_' };
  if (!rule.re.test(name) || name.length > rule.max) throw Object.assign(new Error(`Bad username (${rule.hint})`), { statusCode: 400 });
  return name;
}

/** Хост MySQL-пользователя: `%` — любой, иначе буквы/цифры/точки/дефис/%. */
export function validateDbHost(host: string | undefined | null): string {
  const h = (host ?? '%').trim() || '%';
  if (h.length > 255 || !/^[A-Za-z0-9_.\-%]+$/.test(h)) throw Object.assign(new Error('Bad host (letters, digits, . - _ %%)'), { statusCode: 400 });
  return h;
}

export function validateDbPassword(pw: string): string {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw Object.assign(new Error('Bad password (8-128 chars)'), { statusCode: 400 });
  // Кавычки/точка с запятой/бэкслэш разрешены: во все DDL пароль уходит через
  // escSqlString() (''-эскейп) или bind-параметр, поэтому это не инъекция.
  // Запрещены только NUL и управляющие символы, ломающие протокол.
  if (/[\0-\x1f\x7f]/.test(pw)) throw Object.assign(new Error('Password contains control characters'), { statusCode: 400 });
  return pw;
}

const PRIVS = new Set(['SELECT','INSERT','UPDATE','DELETE','CREATE','DROP','ALTER','INDEX','ALL','ALL PRIVILEGES']);
export function validatePriv(p: string): string {
  const t = p.trim().toUpperCase();
  if (!t || !PRIVS.has(t)) throw Object.assign(new Error('Bad privilege (SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/INDEX/ALL)'), { statusCode: 400 });
  return t === 'ALL' ? 'ALL PRIVILEGES' : t;
}

/**
 * Роль MongoDB: встроенные роли сервера плюс пользовательские по шаблону имени.
 * Раньше уходил любой текст, и несуществующая роль падала 500 от сервера —
 * теперь мусор отсекается на входе с 400, а кастомные роли вида `app_reader`
 * по-прежнему проходят (их существование проверяет сам сервер).
 */
const MONGO_ROLES = new Set([
  'read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin',
  'clusterAdmin', 'clusterManager', 'clusterMonitor', 'hostManager',
  'backup', 'restore', 'root',
  'readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase',
  'enableSharding',
]);
export function validateMongoRole(role: string): string {
  const r = String(role ?? '').trim();
  if (MONGO_ROLES.has(r)) return r;
  if (/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(r)) return r;
  throw Object.assign(new Error(`Bad MongoDB role: ${role} (built-in like read/readWrite/dbAdmin or custom [A-Za-z][A-Za-z0-9_]{2,63})`), { statusCode: 400 });
}

export function validateRow(row: Record<string, unknown>, what='row'): Record<string, unknown> {
  if (!row || typeof row!=='object' || Array.isArray(row) || !Object.keys(row).length) throw Object.assign(new Error(`Bad ${what}`), { statusCode: 400 });
  if (Object.keys(row).length>100) throw Object.assign(new Error(`${what} too many keys`), { statusCode: 400 });
  for(const k of Object.keys(row)){
    ident(k,'column');
    const v=row[k];
    if(v!==null && typeof v!=='string' && typeof v!=='number' && typeof v!=='boolean') throw Object.assign(new Error(`Bad value for ${k}`), { statusCode: 400 });
    if(typeof v==='string' && v.length>10000) throw Object.assign(new Error(`Value too long for ${k}`), { statusCode: 400 });
  }
  return row;
}

export function validatePid(pid: string): number {
  const n = Number(pid);
  if (!Number.isInteger(n) || n<=0 || n> 2147483647) throw Object.assign(new Error('Bad pid'), { statusCode: 400 });
  return n;
}

/** Определение колонки для CREATE/ADD под диалект. */
export function columnSql(d: DesignDialect, c: ColumnSpec): string {
  const name = ident(c.name, 'column');
  const q = quoteIdent(d, name);
  let type = checkColumnType(d, c.type);
  const dv = checkDefault(c.default, d);
  if (c.autoInc) {
    if (d === 'pg') {
      if (type === 'INTEGER' || type === 'INT') type = 'SERIAL';
      else if (type === 'BIGINT') type = 'BIGSERIAL';
      else throw Object.assign(new Error('autoInc needs integer type'), { statusCode: 400 });
      return `${q} ${type} PRIMARY KEY`;
    }
    if (d === 'sqlite') return `${q} INTEGER PRIMARY KEY AUTOINCREMENT`;
    if (d === 'oracle') {
      // У Oracle нет AUTO_INCREMENT: счётчик — это либо IDENTITY на самой колонке,
      // либо отдельная последовательность. Для панели достаточно IDENTITY, он
      // работает с 12c и не требует прав на создание отдельных объектов.
      if (!/^(NUMBER(\(\d{1,2}\))?|INTEGER|INT|SMALLINT)$/.test(type)) {
        throw Object.assign(new Error('autoInc needs integer type'), { statusCode: 400 });
      }
      // NUMBER без точности Oracle хранит как NUMBER(38) — теряет смысл INTEGER
      if (type === 'INTEGER' || type === 'INT') type = 'NUMBER';
      // IDENTITY объявляется ПОСЛЕ типа: «col NUMBER GENERATED …», а не вместо
      // него — иначе Oracle отвечает ORA-02263 «не указан тип столбца».
      return `${q} ${type} GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
    }
    if (!/INT/i.test(type)) throw Object.assign(new Error('autoInc needs integer type'), { statusCode: 400 });
    return `${q} ${type} NOT NULL AUTO_INCREMENT PRIMARY KEY`;
  }
  const parts = [q, type];
  if (c.primary) parts.push('PRIMARY KEY');
  // DEFAULT обязан идти раньше NOT NULL: Oracle разбирает определение колонки
  // строго по порядку и на «col NUMBER NOT NULL DEFAULT 0» отвечает
  // ORA-03076 «unexpected item DEFAULT». MySQL, PostgreSQL и SQLite принимают
  // оба порядка, поэтому порядок выбираем один для всех.
  if (dv !== null) parts.push(`DEFAULT ${dv}`);
  if (!c.primary && c.nullable === false) parts.push('NOT NULL');
  // Комментарий колонки inline — только MySQL/MariaDB понимают COMMENT в
  // определении колонки. PG/Oracle делают это отдельным COMMENT ON COLUMN,
  // поэтому здесь комментарий добавляет только mysql-диалект.
  if (d === 'mysql' && c.comment) {
    const text = String(c.comment).slice(0, 1024);
    parts.push(`COMMENT ${escSqlString(text)}`);
  }
  return parts.join(' ');
}

const FK_ACTIONS_ALLOWED = new Set(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);

/** Правило ссылочной целостности: только allowlist, без свободного текста. */
export function checkFkAction(action: string | undefined): string | null {
  if (action === undefined || action === null || String(action).trim() === '') return null;
  const a = String(action).trim().toUpperCase();
  if (!FK_ACTIONS_ALLOWED.has(a)) {
    throw Object.assign(new Error(`Bad FK action: ${action} (${[...FK_ACTIONS_ALLOWED].join(' / ')})`), { statusCode: 400 });
  }
  return a;
}

const TRIGGER_TIMINGS = new Set(['BEFORE', 'AFTER', 'INSTEAD OF']);
const TRIGGER_EVENTS = new Set(['INSERT', 'UPDATE', 'DELETE']);

export function checkTriggerTiming(timing: string): string {
  const t = String(timing ?? '').trim().toUpperCase();
  if (!TRIGGER_TIMINGS.has(t)) throw Object.assign(new Error(`Bad trigger timing: ${timing} (${[...TRIGGER_TIMINGS].join(' / ')})`), { statusCode: 400 });
  return t;
}

export function checkTriggerEvent(event: string): string {
  const e = String(event ?? '').trim().toUpperCase();
  if (!TRIGGER_EVENTS.has(e)) throw Object.assign(new Error(`Bad trigger event: ${event} (${[...TRIGGER_EVENTS].join(' / ')})`), { statusCode: 400 });
  return e;
}

/**
 * Тело триггера. Это единственное место, где в DDL попадает свободный SQL
 * (создать триггер без него нельзя), поэтому проверяем только длину и то,
 * что это не несколько стейтментов там, где СУБД требует один.
 * SQLite допускает несколько стейтментов: драйвер сам оборачивает тело
 * в BEGIN ... END, поэтому пользователю BEGIN/END писать не нужно.
 */
export function checkTriggerBody(body: string, allowMultiple = false): string {
  const text = String(body ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw Object.assign(new Error('Trigger body is required'), { statusCode: 400 });
  if (text.length > 10_000) throw Object.assign(new Error('Trigger body too large (10KB)'), { statusCode: 413 });
  if (!allowMultiple && splitStatements(text).length > 1) {
    throw Object.assign(new Error('Trigger body must be a single statement (SQLite allows several — they are wrapped in BEGIN ... END)'), { statusCode: 400 });
  }
  return text;
}

/** Типы индексов, которые мы готовы генерировать (MySQL/MariaDB, SQLite — без type). */
const INDEX_TYPES = new Set(['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL', 'GIN', 'GIST', 'BRIN']);

/**
 * CREATE INDEX под диалект. Частичный индекс (where) — только PostgreSQL:
 * остальные его просто проигнорируют, поэтому это 400, а не тихая потеря.
 *
 * У Oracle синтаксис индекса другой: метод доступа идёт через bitmap/function-based
 * выражения, а обычный BTREE — это конструкция по умолчанию, которую писать не
 * нужно. Поэтому для Oracle принимаем только UNIQUE-вариант без метода.
 */
export function indexSql(d: DesignDialect, table: string, def: IndexSpec): string {
  const name = ident(def.name, 'index');
  const q = quoteIdent(d, name);
  if (!Array.isArray(def.columns) || !def.columns.length || def.columns.length > 16) {
    throw Object.assign(new Error('Index needs 1..16 columns'), { statusCode: 400 });
  }
  const cols = def.columns.map((c) => quoteIdent(d, ident(c, 'column')));
  let using = '';
  if (def.type) {
    const t = String(def.type).trim().toUpperCase();
    if (!INDEX_TYPES.has(t)) throw Object.assign(new Error(`Bad index type: ${def.type}`), { statusCode: 400 });
    if (t === 'GIN' || t === 'GIST' || t === 'BRIN') {
      if (d !== 'pg') throw Object.assign(new Error(`Index type ${t} is PostgreSQL-only`), { statusCode: 400 });
    }
    if (d === 'sqlite') throw Object.assign(new Error('SQLite indexes have no type'), { statusCode: 400 });
    if (d === 'oracle') {
      // BTREE — значение по умолчанию; явное «USING BTREE» Oracle отвергает.
      if (t !== 'BTREE') throw Object.assign(new Error('Oracle supports only the default BTREE index type'), { statusCode: 400 });
      if (!def.unique) throw Object.assign(new Error('Oracle indexes have no explicit type: leave the type field empty'), { statusCode: 400 });
    }
    if (d !== 'oracle') using = ` USING ${t}`;
  }
  let where = '';
  if (def.where) {
    if (d !== 'pg') throw Object.assign(new Error('Partial indexes (WHERE) are PostgreSQL-only'), { statusCode: 400 });
    where = ` WHERE ${def.where}`;
  }
  // MySQL/MariaDB: FULLTEXT/SPATIAL нельзя смешивать с USING и UNIQUE
  if (d === 'mysql' && (def.type === 'FULLTEXT' || def.type === 'SPATIAL')) {
    return `CREATE ${def.type} INDEX ${q} ON ${quoteIdent(d, ident(table, 'table'))} (${cols.join(', ')})${where}`;
  }
  return `CREATE ${def.unique ? 'UNIQUE ' : ''}INDEX ${q} ON ${quoteIdent(d, ident(table, 'table'))}${using} (${cols.join(', ')})${where}`;
}

export function dropIndexSql(d: DesignDialect, table: string, name: string): string {
  const n = ident(name, 'index');
  const q = quoteIdent(d, n);
  // MySQL/MariaDB: индекс принадлежит таблице — DROP INDEX t idx
  if (d === 'mysql') return `DROP INDEX ${q} ON ${quoteIdent(d, ident(table, 'table'))}`;
  return `DROP INDEX ${q}`;
}

/**
 * Пункт «FOREIGN KEY (...) REFERENCES ...» для определения таблицы.
 *
 * Отдельная функция, а не переиспользование addForeignKeySql: там ключ
 * добавляется ALTER-ом, а здесь он объявляется вместе с CREATE — так вынужден
 * поступать SQLite, у которого нет ALTER TABLE ADD CONSTRAINT. Общая только
 * проверка колонок и правил ON DELETE/ON UPDATE, чтобы обе формы не разошлись.
 */
export function inlineForeignKeySql(d: DesignDialect, fk: ForeignKeySpec): string {
  if (!Array.isArray(fk.columns) || !fk.columns.length) throw Object.assign(new Error('FK needs columns'), { statusCode: 400 });
  if (!Array.isArray(fk.refColumns) || fk.refColumns.length !== fk.columns.length) {
    throw Object.assign(new Error('FK columns/refColumns length mismatch'), { statusCode: 400 });
  }
  const cols = fk.columns.map((c) => quoteIdent(d, ident(c, 'column')));
  const refCols = fk.refColumns.map((c) => quoteIdent(d, ident(c, 'column')));
  const ref = quoteIdent(d, ident(fk.refTable, 'table'));
  // У Oracle нет ON UPDATE для внешних ключей (только delete_rule): пропускать
  // его молча нельзя — сервер ответит ORA-00905, а пользователь не поймёт что.
  if (d === 'oracle' && fk.onUpdate && String(fk.onUpdate).trim() !== '') {
    throw Object.assign(new Error('Oracle foreign keys do not support ON UPDATE (only ON DELETE)'), { statusCode: 400 });
  }
  const onDelete = checkFkAction(fk.onDelete);
  const onUpdate = checkFkAction(fk.onUpdate);
  const rules = [onDelete ? `ON DELETE ${onDelete}` : '', onUpdate ? `ON UPDATE ${onUpdate}` : ''].filter(Boolean).join(' ');
  // Имя ограничения пишем везде, где диалект его принимает в CREATE TABLE:
  // SQLite, MySQL, PostgreSQL и Oracle понимают CONSTRAINT name FOREIGN KEY.
  // Раньше имя добавлялось только для SQLite, и ключи, созданные вместе с
  // таблицей на остальных СУБД, получали автогенератные имена.
  const named = fk.name ? `CONSTRAINT ${quoteIdent(d, ident(fk.name, 'constraint'))} ` : '';
  return `${named}FOREIGN KEY (${cols.join(', ')}) REFERENCES ${ref} (${refCols.join(', ')})${rules ? ' ' + rules : ''}`;
}

/** ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY под диалект. */
export function addForeignKeySql(d: DesignDialect, table: string, fk: ForeignKeySpec): string {
  const t = quoteIdent(d, ident(table, 'table'));
  if (!Array.isArray(fk.columns) || !fk.columns.length) throw Object.assign(new Error('FK needs columns'), { statusCode: 400 });
  if (!Array.isArray(fk.refColumns) || fk.refColumns.length !== fk.columns.length) {
    throw Object.assign(new Error('FK columns/refColumns length mismatch'), { statusCode: 400 });
  }
  const cols = fk.columns.map((c) => quoteIdent(d, ident(c, 'column')));
  const refCols = fk.refColumns.map((c) => quoteIdent(d, ident(c, 'column')));
  const ref = quoteIdent(d, ident(fk.refTable, 'table'));
  if (d === 'oracle' && fk.onUpdate && String(fk.onUpdate).trim() !== '') {
    throw Object.assign(new Error('Oracle foreign keys do not support ON UPDATE (only ON DELETE)'), { statusCode: 400 });
  }
  const onDelete = checkFkAction(fk.onDelete);
  const onUpdate = checkFkAction(fk.onUpdate);
  const rules = [onDelete ? `ON DELETE ${onDelete}` : '', onUpdate ? `ON UPDATE ${onUpdate}` : ''].filter(Boolean).join(' ');
  if (d === 'sqlite') {
    // Сюда панель не доходит: sqlite-драйвер строит пересборку таблицы, а не
    // ALTER TABLE ADD CONSTRAINT. Ветка оставлена как защита от прямых вызовов.
    throw Object.assign(new Error('SQLite foreign keys are applied via table rebuild, not ALTER TABLE ADD CONSTRAINT (internal error)'), { statusCode: 400 });
  }
  if (!fk.name) throw Object.assign(new Error('FK name is required'), { statusCode: 400 });
  return `ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(d, ident(fk.name, 'constraint'))} FOREIGN KEY (${cols.join(', ')}) REFERENCES ${ref} (${refCols.join(', ')})${rules ? ' ' + rules : ''}`;
}

export function dropForeignKeySql(d: DesignDialect, table: string, name: string): string {
  const t = quoteIdent(d, ident(table, 'table'));
  const n = quoteIdent(d, ident(name, 'constraint'));
  if (d === 'mysql') return `ALTER TABLE ${t} DROP FOREIGN KEY ${n}`;
  // Oracle, как и PostgreSQL, удаляет внешний ключ констрейнтом.
  if (d === 'pg' || d === 'oracle') return `ALTER TABLE ${t} DROP CONSTRAINT ${n}`;
  // Сюда панель не доходит (rebuild в sqlite-драйвере); ветка — защита.
  throw Object.assign(new Error('SQLite foreign keys are dropped via table rebuild (internal error)'), { statusCode: 400 });
}

/**
 * Изменение колонки под диалект. MySQL — одним MODIFY COLUMN, PostgreSQL —
 * тремя ALTER COLUMN (тип требует USING для несовместимых типов), Oracle —
 * четырьмя ALTER COLUMN без USING (приведение там делает неявный CAST).
 */
export function alterColumnSql(d: DesignDialect, table: string, name: string, c: ColumnSpec): string[] {
  const column = ident(name, 'column');
  const q = quoteIdent(d, column);
  const type = checkColumnType(d, c.type);
  const dv = checkDefault(c.default, d);
  if (d === 'mysql') {
    const parts = [q, type];
    if (c.nullable === false) parts.push('NOT NULL');
    if (dv !== null) parts.push(`DEFAULT ${dv}`);
    if (c.autoInc) parts.push('AUTO_INCREMENT');
    return [`ALTER TABLE ${quoteIdent(d, ident(table, 'table'))} MODIFY COLUMN ${parts.join(' ')}`];
  }
  if (d === 'pg') {
    const out: string[] = [];
    const t = quoteIdent(d, ident(table, 'table'));
    // USING нужен для приведения между несовместимыми типами (text -> int и т.п.)
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${q} TYPE ${type} USING ${q}::${type}`);
    if (c.nullable === false) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q} SET NOT NULL`);
    else if (c.nullable === true) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q} DROP NOT NULL`);
    if (dv !== null) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q} SET DEFAULT ${dv}`);
    else out.push(`ALTER TABLE ${t} ALTER COLUMN ${q} DROP DEFAULT`);
    return out;
  }
  if (d === 'oracle') {
    const out: string[] = [];
    const t = quoteIdent(d, ident(table, 'table'));
    out.push(`ALTER TABLE ${t} MODIFY ${q} ${type}`);
    // NOT NULL на пустой колонке требует DEFAULT — Oracle отвергает без него.
    if (c.nullable === false) out.push(`ALTER TABLE ${t} MODIFY ${q} NOT NULL`);
    else if (c.nullable === true) out.push(`ALTER TABLE ${t} MODIFY ${q} NULL`);
    if (dv !== null) out.push(`ALTER TABLE ${t} MODIFY ${q} DEFAULT ${dv}`);
    else out.push(`ALTER TABLE ${t} MODIFY ${q} DEFAULT NULL`);
    return out;
  }
  // Сюда панель не доходит (rebuild в sqlite-драйвере); ветка — защита.
  throw Object.assign(new Error('SQLite columns are altered via table rebuild (internal error)'), { statusCode: 400 });
}

/** Первичный ключ под диалект. SQLite без пересоздания таблицы не умеет. */
export function setPrimaryKeySql(d: DesignDialect, table: string, columns: string[], currentPkConstraint?: string): string[] {
  const t = quoteIdent(d, ident(table, 'table'));
  if (!Array.isArray(columns) || !columns.length) throw Object.assign(new Error('Primary key needs columns'), { statusCode: 400 });
  const cols = columns.map((c) => quoteIdent(d, ident(c, 'column')));
  if (d === 'mysql') return [`ALTER TABLE ${t} ADD PRIMARY KEY (${cols.join(', ')})`];
  if (d === 'pg') return [`ALTER TABLE ${t} ADD PRIMARY KEY (${cols.join(', ')})`];
  if (d === 'oracle') return [`ALTER TABLE ${t} ADD PRIMARY KEY (${cols.join(', ')})`];
  // Сюда панель не доходит (rebuild в sqlite-драйвере); ветка — защита.
  throw Object.assign(new Error('SQLite primary keys are changed via table rebuild (internal error)'), { statusCode: 400 });
}

export function dropPrimaryKeySql(d: DesignDialect, table: string, pkConstraint?: string): string {
  const t = quoteIdent(d, ident(table, 'table'));
  if (d === 'mysql') return `ALTER TABLE ${t} DROP PRIMARY KEY`;
  if (d === 'pg') {
    // Имя PK-констрейнта у pg дефолтное <table>_pkey, но пользователь мог
    // переименовать констрейнт — тогда нужен реальный, его отдаёт getSchema.
    if (!pkConstraint) throw Object.assign(new Error('Primary key constraint name is required to drop it'), { statusCode: 400 });
    return `ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(d, ident(pkConstraint, 'constraint'))}`;
  }
  if (d === 'oracle') {
    // У Oracle имя PK-констрейнта не догадать: дефолтное — SYS_Cxxx, поэтому
    // спрашиваем каталог, как для PostgreSQL.
    if (!pkConstraint) throw Object.assign(new Error('Primary key constraint name is required to drop it'), { statusCode: 400 });
    return `ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(d, ident(pkConstraint, 'constraint'))} DROP PRIMARY KEY`;
  }
  // Сюда панель не доходит (rebuild в sqlite-драйвере); ветка — защита.
  throw Object.assign(new Error('SQLite primary keys are dropped via table rebuild (internal error)'), { statusCode: 400 });
}

/** Совместимость с T-SQL (скрипты от нейросетей): IDENTITY(1,1), GETDATE(),
 * [identifier], NVARCHAR(n) -> диалект mysql/mariadb/postgres/sqlite.
 * Замены только вне строковых литералов и комментариев. Без маркеров —
 * возвращает исходник как есть (быстрый путь).
 */export function translateTsSql(sql: string, kind: string): string {
  const target = kind === 'mariadb' ? 'mysql' : kind;
  if (target !== 'mysql' && target !== 'postgres' && target !== 'sqlite' && target !== 'oracle') return sql;
  if (!/IDENTITY\s*(\(|\b)|GETDATE\s*\(\s*\)|\[[\p{L}0-9_ ]+\]|NVARCHAR\s*\(/iu.test(sql)) return sql;

  // ВАЖНО: трансформируем ПОСТЕЙТМЕНТНО. Regex-выражения (\s включает \n)
  // иначе матчей через границу стейтментов, а lastIndexOf(')') для FK
  // обязан искаться внутри одного CREATE TABLE.
  const statements = splitStatements(sql);
  if (!statements.length) return sql;
  return statements.map(stmt => translateOneStatement(stmt, target)).join(';\n');
}

/** Трансляция одного стейтмента (без внешних ';'). */
function translateOneStatement(stmt: string, target: string): string {

  // Режем стейтмент на сегменты кода/строк/комментариев, трансформируем только код
  const segs: { text: string; code: boolean }[] = [];
  let cur = '';
  let q: string | null = null;
  let lineComment = false;
  let blockComment = false;
  const pushCode = () => { if (cur) segs.push({ text: cur, code: true }); cur = ''; };
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    const nx = stmt[i + 1];
    if (lineComment) {
      if (c === '\n') { lineComment = false; segs.push({ text: '\n', code: false }); }
      else segs.push({ text: c, code: false });
      continue;
    }
    if (blockComment) {
      if (c === '*' && nx === '/') { blockComment = false; segs.push({ text: '*/', code: false }); i++; }
      else segs.push({ text: c, code: false });
      continue;
    }
    if (q) {
      cur += c;
      if (c === q) {
        if (q === `'` && nx === `'`) { cur += nx; i++; }
        else { q = null; pushCode(); }
      }
      continue;
    }
    if (c === '-' && nx === '-') { pushCode(); lineComment = true; segs.push({ text: '--', code: false }); i++; continue; }
    if (c === '/' && nx === '*') { pushCode(); blockComment = true; segs.push({ text: '/*', code: false }); i++; continue; }
    if (c === `'` || c === '"' || c === '`') { q = c; cur += c; continue; }
    cur += c;
  }
  pushCode();

  const nowFn = target === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP';
  const openQ = target === 'mysql' ? '`' : '"';
  const closeQ = openQ;
  // Инлайн-FK вида `user_id INT FOREIGN KEY REFERENCES users(id)`:
  // MySQL/MariaDB так не умеют — выносим в табличное ограничение.
  // Применяется только к CREATE TABLE (по первому слову стейтмента).
  const hoistInlineFk = (s: string): string => {
    if (target !== 'mysql') return s;
    if (!/^\s*CREATE\s+TABLE\b/i.test(s)) return s;
    const fks: string[] = [];
    s = s.replace(
      /([\p{L}_][\p{L}0-9_]*)\s+((?:BIGINT|INT|INTEGER|SMALLINT|VARCHAR\s*\([^()]*\)|CHAR\s*\([^()]*\)|DECIMAL\s*\([^()]*\)|NUMERIC\s*\([^()]*\)|DATE|DATETIME|TIMESTAMP|TEXT))\s+FOREIGN\s+KEY\s+REFERENCES\s+([\p{L}_][\p{L}0-9_]*)\s*(\(\s*[\p{L}_][\p{L}0-9_]*\s*\))?/giu,
      (_m, col: string, type: string, refTable: string, refCol: string) => {
        fks.push(`FOREIGN KEY (${col}) REFERENCES ${refTable}${refCol || ''}`);
        return `${col} ${type}`;
      }
    );
    if (!fks.length) return s;
    const closeIdx = s.lastIndexOf(')');
    if (closeIdx < 0) return s;
    return s.slice(0, closeIdx) + `, ${fks.join(', ')}` + s.slice(closeIdx);
  };
  const mapCode = (s: string): string => {
    // Инлайн-FK раньше остальных замен (пока типы ещё на месте)
    s = hoistInlineFk(s);
    s = s.replace(
      /([\p{L}_][\p{L}0-9_]*)\s+(BIGINT|INT|INTEGER|SMALLINT)\s+PRIMARY\s+KEY\s+IDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/giu,
      (_m, col: string, type: string) => {
        const t = String(type).toUpperCase();
        if (target === 'mysql') return `${col} ${type} PRIMARY KEY AUTO_INCREMENT`;
        if (target === 'postgres') {
          const serial = t === 'BIGINT' ? 'BIGSERIAL' : t === 'SMALLINT' ? 'SMALLSERIAL' : 'SERIAL';
          return `${col} ${serial} PRIMARY KEY`;
        }
        if (target === 'oracle') return `${col} NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
        return `${col} INTEGER PRIMARY KEY AUTOINCREMENT`;
      }
    );
    // Остаточный bare IDENTITY(...)
    // Lookbehind (?<!AS ) обязателен: `GENERATED ALWAYS AS IDENTITY` и
    // `GENERATED BY DEFAULT AS IDENTITY` — стандартный SQL (PostgreSQL 10+ и
    // Oracle 12c+), его нельзя превращать в AUTO_INCREMENT или вырезать, иначе
    // запрос не распарсится. T-SQL-конструкция выглядит как `IDENTITY(1,1)`.
    s = s.replace(/(?<!AS )\bIDENTITY\s*(\(\s*\d+\s*,\s*\d+\s*\))?/gi, target === 'mysql' ? 'AUTO_INCREMENT' : '');
    // DATE DEFAULT GETDATE() -> DEFAULT (CURRENT_DATE): голый NOW()/CURRENT_TIMESTAMP
    // MySQL в DEFAULT для DATE не принимает
    if (target === 'mysql') {
      s = s.replace(
        /\bDATE\b((?:\s+NOT\s+NULL|\s+NULL)*)\s+DEFAULT\s+GETDATE\s*\(\s*\)/gi,
        'DATE$1 DEFAULT (CURRENT_DATE)'
      );
    }
    // GETDATE() -> NOW()/CURRENT_TIMESTAMP
    s = s.replace(/\bGETDATE\s*\(\s*\)/gi, nowFn);
    // NVARCHAR(n) -> VARCHAR(n)
    s = s.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
    // [identifier] -> кавычки диалекта
    s = s.replace(/\[([\p{L}0-9_ ]+)\]/gu, `${openQ}$1${closeQ}`);
    return s;
  };
  return segs.map(s => (s.code ? mapCode(s.text) : s.text)).join('');
}
