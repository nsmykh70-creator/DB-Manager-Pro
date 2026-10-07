/**
 * Сборка SQL для быстрых действий над таблицей: выбрать, вставить, очистить.
 *
 * Живут отдельно от компонента, потому что это чистые функции без состояния и
 * без перевода: их одинаково используют список таблиц, панели и конструктор.
 */

function quoteIdentifier(name: string, kind: string): string {
  // Oracle, как и PostgreSQL/SQLite, оборачивает идентификаторы в двойные
  // кавычки: без них имя, созданное панелью, сервер сложил бы в ВЕРХНИЙ РЕГИСТР.
  if (kind === 'postgres' || kind === 'sqlite' || kind === 'oracle') return `"${name.replaceAll('"', '""')}"`;
  return `\`${name.replaceAll('`', '``')}\``;
}

export function quickSelectSql(kind: string, table: string): string {
  if (kind === 'mongodb') return JSON.stringify({ collection: table, filter: {}, limit: 50 });
  if (kind === 'redis') return JSON.stringify({ cmd: 'HGETALL', key: table });
  // У Oracle нет LIMIT: ограничение выдачи называется FETCH NEXT.
  if (kind === 'oracle') return `SELECT * FROM ${quoteIdentifier(table, kind)} FETCH NEXT 50 ROWS ONLY;`;
  return `SELECT * FROM ${quoteIdentifier(table, kind)} LIMIT 50;`;
}

export function quickInsertSql(kind: string, table: string): string {
  if (kind === 'mongodb') return JSON.stringify({ collection: table, filter: {}, limit: 50 });
  if (kind === 'redis') return JSON.stringify({ cmd: 'HGETALL', key: table });
  if (kind === 'postgres' || kind === 'sqlite') return `INSERT INTO ${quoteIdentifier(table, kind)} DEFAULT VALUES;`;
  // Oracle не знает DEFAULT VALUES и не принимает пустой список колонок, а
  // узнать их панель здесь не может — заготовку вставляем с плейсхолдерами.
  if (kind === 'oracle') return `INSERT INTO ${quoteIdentifier(table, kind)} ("col1", "col2") VALUES (:1, :2);`;
  return `INSERT INTO ${quoteIdentifier(table, kind)} () VALUES ();`;
}

export function clearTableSql(kind: string, table: string): string {
  if (kind === 'mongodb') return JSON.stringify({ collection: table, clear: true });
  if (kind === 'redis') return JSON.stringify({ cmd: 'DEL', key: table });
  return `DELETE FROM ${quoteIdentifier(table, kind)}`;
}