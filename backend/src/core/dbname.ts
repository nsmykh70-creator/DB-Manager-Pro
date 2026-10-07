/**
 * Правила имени базы данных — по одному набору на СУБД.
 *
 * Раньше проверка была одна на все СУБД («[A-Za-z0-9_], до 64»), и это работало
 * против пользователя сразу в двух направлениях:
 *   - отвергались валидные имена (MongoDB и PostgreSQL спокойно принимают дефис,
 *     а Mongo различает регистр, поэтому «shop» и «Shop» — разные базы);
 *   - лимит 64 пропускал имя длиной 64, которое MongoDB и PostgreSQL отклоняют
 *     (у обоих предел 63), и пользователь получал 502 вместо внятного 400.
 * Пределы и наборы символов ниже взяты из документации соответствующих СУБД.
 */
export type DbNameKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb' | 'redis' | 'oracle';

type Rule = { max: number; re: RegExp; charsetHint: string; extra?: (name: string) => string | null };

// MySQL/MariaDB: только [A-Za-z0-9_$], длина 64 (документированный предел)
// PostgreSQL: буква/подчёркивание в начале, дальше буквы, цифры, _, $, длина 63
// MongoDB: буквы, цифры, _, -, длина 63; точка, $ и \\0 запрещены
// SQLite: имя становится файлом — тот же набор, что у Mongo, плюс запрет путей
const RULES: Record<DbNameKind, Rule> = {
  mysql: { max: 64, re: /^[A-Za-z0-9_$]+$/, charsetHint: 'только латиница, цифры и подчёркивание' },
  mariadb: { max: 64, re: /^[A-Za-z0-9_$]+$/, charsetHint: 'только латиница, цифры и подчёркивание' },
  postgres: { max: 63, re: /^[A-Za-z_][A-Za-z0-9_$]*$/, charsetHint: 'начинается с буквы или _, дальше латиница, цифры, _ и $' },
  mongodb: {
    max: 63,
    re: /^[A-Za-z0-9_-]+$/,
    charsetHint: 'только латиница, цифры, дефис и подчёркивание',
    extra: name => (/^system\./i.test(name) ? 'Имя не может начинаться с «system.»' : null)
  },
  sqlite: {
    max: 64,
    re: /^[A-Za-z0-9_-]+$/,
    charsetHint: 'только латиница, цифры, дефис и подчёркивание',
    extra: name => (/[\\/:*?"<>|]/.test(name) ? 'В имени файла нельзя использовать \ / : * ? " < > |' : null)
  },
  redis: { max: 64, re: /^[A-Za-z0-9_.:-]+$/, charsetHint: 'набор ключей Redis' },
  // Oracle: CREATE DATABASE не существует, «база» панели здесь — схема (или PDB).
  // Имя не должно начинаться с цифры — некавыченный идентификатор Oracle обязан
  // начинаться с буквы; решётка и $ допустимы в середине имени.
  oracle: { max: 128, re: /^[A-Za-z][A-Za-z0-9_$#]*$/, charsetHint: 'начинается с буквы, дальше латиница, цифры, _ и #' }
};

/** Возвращает текст ошибки или null, если имя допустимо для этой СУБД. */
export function validateDatabaseName(kind: DbNameKind, rawName: string): string | null {
  const name = rawName.trim();
  const rule = RULES[kind];
  if (!name) return 'Введите имя базы данных';
  if (name.length > rule.max) return `Имя базы данных: не длиннее ${rule.max} символов (сейчас ${name.length})`;
  const extra = rule.extra?.(name);
  if (extra) return `Имя базы данных: ${extra}`;
  if (!rule.re.test(name)) return `Имя базы данных: ${rule.charsetHint}`;
  return null;
}

// Правила сознательно продублированы в форме (CreateDatabaseModal.tsx), чтобы
// подсказка появлялась до отправки. Расхождение между копиями ловит набор
// e2e-dbname: он проверяет и отказ, и длину по каждой СУБД.
