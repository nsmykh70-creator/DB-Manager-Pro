import type { AlterOp, ColumnDef } from '../api';

/**
 * Планирование изменений структуры для визуального конструктора колонок.
 *
 * Вынесено отдельно от React-компонента намеренно: это чистая функция «что было →
 * что стало», и её интересно проверять скриптом (scripts/check-column-plan.mts),
 * а не глазами в браузере. Ошибка здесь означала бы, что панель предлагает
 * применить не то, что показала, — самый дорогой вид ошибки в конструкторе.
 */

export interface ColumnCard {
  /** Стабильный ключ карточки, чтобы перетаскивание не путало одинаковые имена. */
  key: string;
  name: string;
  /** Тип без длины: хранится отдельно, как в CreateTableModal. */
  type: string;
  length: string;
  nullable: boolean;
  primary: boolean;
  autoInc: boolean;
  def: string;
}

export interface LoadedColumn {
  name: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  autoInc: boolean;
  default: string | null;
  ordinal: number;
}

export interface ChangePlan {
  ops: AlterOp[];
  add: number;
  rename: number;
  alter: number;
  drop: number;
  pkChanged: boolean;
}

/** Тип в виде СУБД -> (базовый тип, длина). `varchar(64)` -> ('VARCHAR', '64'). */
export function splitType(raw: string): { type: string; length: string } {
  const text = String(raw ?? '').trim();
  const match = /^([A-Za-z ]+?)\s*\((\d+)\)$/.exec(text);
  if (match) return { type: match[1].trim().toUpperCase(), length: match[2] };
  return { type: text.toUpperCase(), length: '' };
}

/** Собирает тип для отправки: VARCHAR + 64 -> VARCHAR(64). */
export function composeType(card: Pick<ColumnCard, 'type' | 'length'>): string {
  const base = card.type.trim().toUpperCase();
  const length = card.length.trim();
  return /^(VARCHAR|CHAR)$/.test(base) && length ? `${base}(${length})` : base;
}

export function cardFromLoaded(column: LoadedColumn, key: string): ColumnCard {
  const { type, length } = splitType(column.type);
  return {
    key,
    name: column.name,
    type,
    length,
    nullable: column.nullable,
    primary: column.primary,
    autoInc: column.autoInc,
    def: column.default ?? '',
  };
}

export function cardToColumnDef(card: ColumnCard): ColumnDef {
  return {
    name: card.name.trim(),
    type: composeType(card),
    nullable: card.primary ? false : card.nullable,
    primary: card.primary,
    autoInc: card.primary && card.autoInc,
    default: card.def.trim() || null,
  };
}

export function sameColumnProps(card: ColumnCard, original: ColumnCard): boolean {
  return (
    composeType(card) === composeType(original) &&
    Boolean(card.primary) === Boolean(original.primary) &&
    (card.primary ? Boolean(card.autoInc) : false) === (original.primary ? Boolean(original.autoInc) : false) &&
    (card.def.trim() || null) === (original.def.trim() || null) &&
    (card.primary ? false : Boolean(card.nullable)) === (original.primary ? false : Boolean(original.nullable))
  );
}

/** Подпись, по которой две колонки считаются одинаковыми во всём, кроме имени. */
function columnSignature(card: ColumnCard): string {
  return [
    composeType(card),
    card.primary ? '1' : '0',
    card.primary && card.autoInc ? '1' : '0',
    card.def.trim() || '',
    card.primary ? '0' : (card.nullable ? '1' : '0')
  ].join('|');
}

/**
 * Порядок операций важен и не случаен:
 *  1. добавление новых колонок — их ещё нет, но на них уже могут ссылаться связи;
 *  2. переименование — дальше все операции идут по новым именам;
 *  3. изменение свойств существующих колонок;
 *  4. смена первичного ключа — тоже по новым именам;
 *  5. удаление — последним, иначе можно удалить колонку, на которую уже
 *     ссылается предыдущая операция.
 */
export function planChanges(cards: ColumnCard[], original: ColumnCard[]): ChangePlan {
  const ops: AlterOp[] = [];
  const cardsByName = new Map(cards.map(card => [card.name, card]));
  const originalByName = new Map(original.map(card => [card.name, card]));

  // 1) переименования находим ПЕРВЫМИ и только там, где они однозначны.
  //
  //    Раньше колонка с новым именем искала «близнеца» среди старых по
  //    совпадению свойств, и это давало две поломки: переименованная
  //    первичная ключевая колонка额外 попадала в удаление (её исходного имени
  //    уже нет в холсте), а новая колонка TEXT при наличии в базе любой
  //    колонки TEXT объявлялась переименованием чужой. Теперь старая колонка
  //    подходит на переименование, только если она единственная с такой
  //    подписью; иначе это честное «добавить + удалить», и панель покажет
  //    оба действия пользователю.
  const renameFrom = new Map<string, string>();  // новое имя -> старое имя
  const usedOriginals = new Set<string>();
  for (const card of cards) {
    if (originalByName.has(card.name)) continue;
    const signature = columnSignature(card);
    const candidates = original.filter(o => !usedOriginals.has(o.name) && columnSignature(o) === signature);
    if (candidates.length === 1) {
      renameFrom.set(card.name, candidates[0].name);
      usedOriginals.add(candidates[0].name);
    }
  }

  let add = 0;
  let rename = 0;
  let alter = 0;

  // 2) добавления — всё, что не совпало по имени и не оказалось переименованием
  for (const card of cards) {
    if (originalByName.has(card.name) || renameFrom.has(card.name)) continue;
    ops.push({ op: 'addColumn', column: cardToColumnDef(card) });
    add += 1;
  }

  for (const [to, from] of renameFrom) {
    ops.push({ op: 'renameColumn', from, to });
    rename += 1;
  }

  for (const card of cards) {
    const before = originalByName.get(card.name);
    if (!before) continue;
    if (!sameColumnProps(card, before)) {
      ops.push({ op: 'alterColumn', name: card.name, column: cardToColumnDef(card) });
      alter += 1;
    }
  }

  // 3) первичный ключ сравниваем с учётом переименований: если ключ просто
  //    переименовали, ограничение поехало вместе с колонкой, и setPrimaryKey
  //    не нужен (и мог бы упасть, если ограничение с таким именем уже есть).
  //    renameFrom хранит «новое имя -> старое», здесь нужен обратный маппинг.
  const renameTo = new Map([...renameFrom].map(([to, from]) => [from, to]));
  const pkBefore = original
    .filter(c => c.primary)
    .map(c => renameTo.get(c.name) ?? c.name)
    .sort();
  const pkAfter = cards.filter(c => c.primary).map(c => c.name).sort();
  const pkChanged = pkBefore.join('\u0000') !== pkAfter.join('\u0000');
  if (pkChanged) {
    if (pkAfter.length) ops.push({ op: 'setPrimaryKey', columns: pkAfter });
    else ops.push({ op: 'dropPrimaryKey' });
  }

  // 4) удаляется только то, чего нет в холсте и что не было переименовано
  const drops = original.filter(card => !cardsByName.has(card.name) && !usedOriginals.has(card.name));
  for (const card of drops) {
    ops.push({ op: 'dropColumn', name: card.name });
  }

  return { ops, add, rename, alter, drop: drops.length, pkChanged };
}
