/**
 * Пользовательский порядок списков в боковой панели: и категорий СУБД,
 * и баз внутри категории. Одна реализация на оба, потому что механика
 * (перестановка, версионированный ключ, нормализация мусора) у них одна и та же,
 * а различаются только домен в ключе и пределы.
 *
 * Модуль намеренно без React: всё здесь проверяется скриптом
 * `scripts/check-order-store.mts`, разметку и обработчики держит Sidebar.tsx.
 *
 * Почему порядок живёт на клиенте, а не в настройках инстанса:
 *   - это вкусовое предпочтение конкретного человека, а не свойство панели;
 *     настройки `settings.json` общие для всех и менять их может только админ,
 *     а переставлять списки должен каждый сам;
 *   - сервер ничего не знает про порядок: категории приходят из константы
 *     SUPPORTED_KINDS, а базы — в том порядке, в котором их отдаёт СУБД
 *     (алфавитный гарантирован только у PostgreSQL);
 *   - порядок не должен ехать в настройку целиком: `PUT /api/settings`
 *     перезаписывает объект, и чужая правка затёрла бы не то поле.
 */

/** Версия схемы: в ключе storage, чтобы старый формат не читался как новый. */
export const ORDER_VERSION = 1;

/** Сколько элементов держим в одной группе. Больше — обрезаем. */
const MAX_PER_GROUP = 500;
/** Сколько групп держим. Их столько, сколько типов СУБД, запас — на будущее. */
const MAX_GROUPS = 32;
/** Предел длины ключа элемента и имени группы. */
const MAX_KEY_LENGTH = 512;

/**
 * Хранимый порядок: имя группы → список ключей в порядке пользователя.
 *
 * Для порядка категорий СУБД группа одна и фиктивная (см. kindOrder.ts): список
 * типов СУБД не вложен в категории, и прятать его в искусственную обёртку ради
 * переиспользования формы — значит усложнить чтение данных ради экономии
 * пятнадцати строк кода.
 */
export type Order = Record<string, string[]>;

/** Признак того, что значение в хранилище есть, но прочитать его нельзя. */
const CORRUPTED = Symbol('corrupted');

export interface ReadResult {
  order: Order;
  /** Значение было, но нечитаемое — вызывающий покажет предупреждение один раз. */
  corrupted: boolean;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Приватный режим браузера и заблокированное хранилище
    return null;
  }
}

/**
 * Нормализация: только строки, без дублей, с ограничениями по длине.
 * Мусор в хранилище (старый формат, правка руками, чужой скрипт) не должен
 * приводить к дублям в интерфейсе или к переполнению ключа.
 */
export function normalizeOrder(value: unknown): Order {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Order = {};
  for (const [group, list] of Object.entries(value as Record<string, unknown>)) {
    if (!group || group.length > MAX_KEY_LENGTH || !Array.isArray(list)) continue;
    if (Object.keys(out).length >= MAX_GROUPS) break;
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item || item.length > MAX_KEY_LENGTH) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      keys.push(item);
      if (keys.length >= MAX_PER_GROUP) break;
    }
    if (keys.length) out[group] = keys;
  }
  return out;
}

/**
 * Порядок строк по сохранённому списку ключей.
 *
 * Ключи, которых в хранилище нет (база появилась позже), идут ПОСЛЕ известных и
 * сохраняют порядок сервера: иначе новая база каждый раз прыгала бы наверх.
 * Пользовательский порядок при этом сохраняется: известные ключи идут по нему,
 * неизвестные — по исходному индексу.
 */
export function sortRows<T>(rows: T[], keyOf: (row: T) => string, order: string[]): T[] {
  if (!order.length || rows.length < 2) return rows;
  const rank = new Map<string, number>();
  order.forEach((key, index) => rank.set(key, index));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ra = rank.get(keyOf(a.row));
      const rb = rank.get(keyOf(b.row));
      if (ra === undefined && rb === undefined) return a.index - b.index;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb || a.index - b.index;
    })
    .map(x => x.row);
}

/**
 * Перестановка ключа `fromKey` относительно `toKey`.
 *
 * `position` решает, куда именно встать:
 *   - `before` — перед `toKey` (зачёркивается линия над строкой);
 *   - `after`  — после `toKey` (линия под строкой).
 *
 * Почему не только «вставить перед», как в TableDesigner: там карточки
 * высокие и переносят далеко. В узком списке боковой панели соседние строки
 * стоят в 20 пикселях друг от друга, и режим «только перед» делал бы
 * перенос на строку ниже пустым действием — стрелка вниз ничего бы не двигала.
 * Сторона выбирается по курсору: верхняя или нижняя половина строки.
 */
export function moveKey(
  order: string[],
  fromKey: string,
  toKey: string,
  position: 'before' | 'after' = 'before'
): string[] {
  if (fromKey === toKey) return order;
  const from = order.indexOf(fromKey);
  const target = order.indexOf(toKey) + (position === 'after' ? 1 : 0);
  const clamp = (n: number) => Math.max(0, Math.min(order.length, n));
  // Перетаскивание на неизвестный ключ (элемента ещё нет в сохранении) — это
  // добавление: без него порядок новых элементов никогда бы не запоминался.
  if (from < 0) {
    if (order.indexOf(toKey) < 0) return order;
    const next = [...order];
    next.splice(clamp(target), 0, fromKey);
    return next;
  }
  if (order.indexOf(toKey) < 0) {
    const next = [...order];
    next.splice(from, 1);
    next.push(fromKey);
    return next;
  }
  const next = [...order];
  const [moved] = next.splice(from, 1);
  // После удаления элемента все индексы правее from сдвинулись на единицу.
  next.splice(clamp(from < target ? target - 1 : target), 0, moved);
  return next;
}

/**
 * Перестановка на соседнюю позицию — для клавиатуры (стрелки ↑ и ↓).
 *
 * Возвращает ТОТ ЖЕ массив, если сдвинуть некуда: вызывающий по ссылке видит,
 * что порядок не изменился, и не пересохраняет хранилище. Это же позволяет не
 * гасить событие клавиши на краю списка — стрелка должна прокручивать панель,
 * а не быть съеденной впустую.
 */
export function moveKeyBy(order: string[], key: string, delta: number): string[] {
  const from = order.indexOf(key);
  if (from < 0 || !delta) return order;
  const to = from + (delta > 0 ? 1 : -1);
  if (to < 0 || to >= order.length) return order;
  // Вниз — стать ПОСЛЕ соседа, вверх — ПЕРЕД ним: если вниз вставлять «перед»,
  // элемент останется на месте, потому что он и так перед соседом.
  return moveKey(order, key, order[to], delta > 0 ? 'after' : 'before');
}

export interface OrderStoreOptions {
  /** Домен в ключе хранилища: разные списки не должны затирать друг друга. */
  domain: string;
  /** Имя группы по умолчанию, когда список не вложен в категории. */
  defaultGroup?: string;
}

/**
 * Хранилище порядка для одного домена. Разделено по доменам (`dborder`,
 * `kindorder`), потому что ключ версионирован и общий для них ключ означал бы,
 * что смена формата одного списка ломает чтение другого.
 */
export function createOrderStore(options: OrderStoreOptions) {
  const domain = options.domain;
  const defaultGroup = options.defaultGroup ?? '_';

  function storageKey(userKey: string): string {
    return `${domain}:v${ORDER_VERSION}:${userKey || 'anonymous'}`;
  }

  function readRaw(userKey: string, storage?: StorageLike | null): unknown {
    const store = storage === undefined ? safeLocalStorage() : storage;
    if (!store) return null;
    try {
      const text = store.getItem(storageKey(userKey));
      return text ? JSON.parse(text) : null;
    } catch {
      // Молча начинать с дефолтов нельзя: у пользователя порядок исчез бы без
      // объяснения. Помечаем значение как повреждённое и сообщаем об этом.
      return CORRUPTED;
    }
  }

  function load(userKey: string, storage?: StorageLike | null): ReadResult {
    const raw = readRaw(userKey, storage);
    if (raw === CORRUPTED) return { order: {}, corrupted: true };
    if (raw === null) return { order: {}, corrupted: false };
    const order = normalizeOrder(raw);
    // Разобранный, но бессмысленный объект — тоже повреждение: молча вернуть
    // «порядок по умолчанию» значило бы потерять настройку без единого слова.
    return { order, corrupted: Object.keys(order).length === 0 };
  }

  function save(userKey: string, order: Order, storage?: StorageLike | null): boolean {
    const store = storage === undefined ? safeLocalStorage() : storage;
    if (!store) return false;
    try {
      store.setItem(storageKey(userKey), JSON.stringify(normalizeOrder(order)));
      return true;
    } catch {
      // Переполненное или недоступное хранилище — не повод ломать интерфейс
      return false;
    }
  }

  function clear(userKey: string, storage?: StorageLike | null): void {
    const store = storage === undefined ? safeLocalStorage() : storage;
    if (!store) return;
    try {
      store.removeItem(storageKey(userKey));
    } catch {
      // см. save
    }
  }

  /** Порядок для плоского списка: одна группа, отдельные обёртки не нужны. */
  function flat(order: Order): string[] {
    return order[defaultGroup] ?? [];
  }

  return { domain, defaultGroup, storageKey, load, save, clear, flat };
}

export type OrderStore = ReturnType<typeof createOrderStore>;