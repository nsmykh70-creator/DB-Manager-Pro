/**
 * Ошибка драйвера, допустимая к показу пользователю.
 *
 * Глобальный обработчик панели на 5xx отдаёт «Internal server error» без деталей
 * (чтобы не выдать внутренности), поэтому любая ошибка базы, дошедшая как 500,
 * выглядит как «ничего не понятно». Для SQL-редактора это особенно плохо:
 * опечатка в запросе — это ошибка пользователя, а не панели, и сервер уже
 * объяснил, в чём дело, — «You have an error in your SQL syntax ...».
 *
 * Правило: код ошибки, который поставил сам драйвер или панель (4xx), уходит
 * как есть; всё остальное — 400 с текстом СУБД. Таймаут остаётся 504, иначе
 * запрос, оборванный по истечении времени, выглядел бы как опечатка.
 */
import { codeForDriverError, withCode } from './errcodes.js';
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'PROTOCOL_CONNECTION_TIMEOUT', 'ETIMEOUT', 'QO_TIMEOUT', '57014', 'HYT00', 'Lock wait timeout'
]);

/** Текст ошибки от СУБД: у драйверов он лежит в разных полях. */
function dbMessage(e: any): string {
  const raw = e?.sqlMessage ?? e?.message ?? e?.errmsg ?? e?.reason ?? '';
  const text = String(raw).split('\nHelp:')[0].trim();
  return text || 'Query failed';
}

/**
 * Подсказки к сообщениям СУБД.
 *
 * Текст сервера точен, но не отвечает на вопрос «что делать». Самый частый случай
 * в DDL, импортированном из старых CMS: нулевая дата в DEFAULT. MySQL 8.4 и
 * MariaDB 10.2+ по умолчанию включают NO_ZERO_DATE и STRICT_TRANS_TABLES, и
 * '0000-00-00 00:00:00' перестал быть допустимым значением — сервер отвечает
 * «Invalid default value for 'created'», из чего не следует, что дело в дате.
 */
function hintFor(message: string, sql: string): string | null {
  if (/invalid default value/i.test(message) && /'0000-00-00/.test(sql)) {
    return "MySQL 8.4 / MariaDB 10.2+ run with NO_ZERO_DATE and STRICT_TRANS_TABLES, "
      + "so '0000-00-00 00:00:00' is no longer accepted as a value or a DEFAULT. "
      + "Use a real date such as '1970-01-01 00:00:00', allow NULL for the column, "
      + 'or relax sql_mode for that session.';
  }
  if (/incorrect datetime value/i.test(message) && /'0000-00-00/.test(sql)) {
    return "'0000-00-00 00:00:00' is not a valid date in MySQL 8.4 / MariaDB 10.2+ "
      + '(NO_ZERO_DATE). Use a real date or NULL, or relax sql_mode for that session.';
  }
  return null;
}

export function userFacingDbError(e: unknown, sql = ''): Error {
  const err = e as { statusCode?: number; code?: string; message?: string; sqlMessage?: string };
  if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return e instanceof Error ? e : new Error(dbMessage(e));
  }
  const code = String(err?.code ?? '');
  if (TIMEOUT_CODES.has(code) || /timeout|timed out/i.test(String(err?.message ?? ''))) {
    return Object.assign(new Error(`Query timed out: ${dbMessage(e)}`), { statusCode: 504 });
  }
  // Драйвер уже сказал, что не так (ER_NO_SUCH_TABLE, ORA-00942, 42P01, ...) —
  // показываем его текст, но как ошибку пользователя, а не как падение панели.
  const text = dbMessage(e);
  const hint = hintFor(text, sql);
  const out = Object.assign(new Error(hint ? `${text} — ${hint}` : text), { statusCode: 400 });
  // Стабильный код нужен интерфейсу для перевода; текст остаётся английским,
  // потому что он же попадает в журнал и в ответы API.
  const panelCode = hint && /0000-00-00/.test(sql) ? 'zero_date' : codeForDriverError(e);
  return panelCode ? withCode(out, panelCode) : out;
}
