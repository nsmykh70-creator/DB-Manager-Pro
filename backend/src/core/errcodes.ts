/**
 * Машинные коды ошибок, которые видит пользователь.
 *
 * Сообщение сервера остаётся английским (его читают в журналах и в ответах API),
 * но вместе с ним панель получает стабильный код: по нему интерфейс показывает
 * перевод, а если кода нет — показывает текст сервера как есть. Без кодов пришлось
 * бы сравнивать английские строки по шаблону, что ломается от первого же
 * переформулирования у MySQL.
 */
export type PanelErrorCode =
  | 'explain_readonly'
  | 'table_not_found'
  | 'zero_date'
  | 'bad_identifier'
  | 'read_only_connection'
  | 'unsupported_operation'
  | 'undo_structural'
  | 'undo_nothing';

/** Добавляет код к ошибке, не трогая её сообщение. */
export function withCode<T extends Error>(err: T, code: PanelErrorCode): T & { code?: PanelErrorCode } {
  (err as T & { code?: PanelErrorCode }).code = code;
  return err as T & { code?: PanelErrorCode };
}

/**
 * Коды драйверов, которые означают «объекта нет». У PostgreSQL и Oracle это
 * классы 42P01/ORA-00942, у MySQL — ER_NO_SUCH_TABLE, у SQLite — «no such table».
 */
const NOT_FOUND_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR', '42P01', '42704']);

/** Определяет код по ошибке драйвера, если он известен. */
export function codeForDriverError(e: unknown): PanelErrorCode | undefined {
  const err = e as { code?: string; message?: string; oracledbErrorNum?: number };
  if (NOT_FOUND_CODES.has(String(err?.code ?? ''))) return 'table_not_found';
  if (/ORA-00942|ORA-04043|does not exist|no such table|Unknown table/i.test(String(err?.message ?? ''))) {
    return 'table_not_found';
  }
  if (/Invalid default value|Incorrect datetime value/i.test(String(err?.message ?? '')) && /0000-00-00/.test(String((e as { sql?: string })?.sql ?? ''))) {
    return 'zero_date';
  }
  return undefined;
}
