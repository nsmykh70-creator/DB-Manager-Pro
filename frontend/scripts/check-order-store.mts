// Статическая проверка пользовательских порядков в боковой панели:
// и категорий СУБД, и баз внутри категории.
//
// Ядро (frontend/src/core/orderStore.ts) намеренно без React: перестановка и
// работа с localStorage проверяются здесь, а в браузере проверяется только то,
// что нельзя проверить без DOM — обработчики перетаскивания и клавиш
// (e2e-sidebar-order.mjs).
//
// Запуск: npm run check:order-store (входит в verify).
import {
  ORDER_VERSION,
  createOrderStore,
  moveKey,
  moveKeyBy,
  normalizeOrder,
  sortRows
} from '../src/core/orderStore';
import { dbOrderStore, dbRowKey, DB_ORDER_VERSION } from '../src/core/dbOrder';
import { kindOrderStore, KIND_GROUP, KIND_ORDER_VERSION } from '../src/core/kindOrder';

let failures = 0;
const results: boolean[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` | ${extra}` : ''}`);
  results.push(ok);
  if (!ok) failures++;
}

/** Хранилище в памяти: localStorage в Node недоступен, а проверка должна быть чистой. */
function memStore(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set('seed', seed);
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }
  };
}

// ── 1. Ключи хранилища: версия схемы, пользователь и домен ─────────────────
// Ключ без версии означал бы, что смена формата читает старое значение как
// новое; без пользователя — что порядок переезжает между людьми; домен в ключе
// нужен, чтобы порядок категорий и порядок баз не затирали друг друга.
{
  const dbKey = dbOrderStore.storageKey('admin');
  const kindKey = kindOrderStore.storageKey('admin');
  check('ключ баз содержит версию схемы', dbKey === `dborder:v${DB_ORDER_VERSION}:admin`, dbKey);
  check('ключ категорий содержит версию схемы', kindKey === `kindorder:v${KIND_ORDER_VERSION}:admin`, kindKey);
  check('версии совпадают с общей', DB_ORDER_VERSION === ORDER_VERSION && KIND_ORDER_VERSION === ORDER_VERSION);
  check('домены разные: списки не затирают друг друга', dbKey !== kindKey, `${dbKey} / ${kindKey}`);
  check('ключ различает пользователей', dbOrderStore.storageKey('admin') !== dbOrderStore.storageKey('editor'));
  check('без логина ключ не пустой', dbOrderStore.storageKey('') === `dborder:v${DB_ORDER_VERSION}:anonymous`, dbOrderStore.storageKey(''));
}

// ── 2. Составной ключ строки базы ───────────────────────────────────────────
// Одна и та же база встречается у нескольких подключений одного типа, поэтому
// ключ обязан их различать — иначе перестановка была бы неоднозначной.
check('ключ строки различает подключения', dbRowKey('c1', 'shop') !== dbRowKey('c2', 'shop'));
check('ключ строки стабилен', dbRowKey('c1', 'shop') === dbRowKey('c1', 'shop'));

// ── 3. Нормализация мусора ─────────────────────────────────────────────────
{
  const n = normalizeOrder({
    postgresql: ['a:1', 'a:1', '', 42, null, { x: 1 }, 'b:2'],
    mysql: 'не массив',
    '': ['ok:1'],
    [`g${'x'.repeat(600)}`]: ['ok:1']
  });
  check('дубли убраны', JSON.stringify(n.postgresql) === JSON.stringify(['a:1', 'b:2']), JSON.stringify(n.postgresql));
  check('не-строки отброшены', JSON.stringify(n.postgresql) === JSON.stringify(['a:1', 'b:2']), JSON.stringify(n.postgresql));
  check('не-массив в значении не ломает', n.mysql === undefined, JSON.stringify(n));
  check('пустое имя группы не принимается', n[''] === undefined, JSON.stringify(Object.keys(n)));
  check('слишком длинное имя группы не принимается', !Object.keys(n).some(k => k.length > 512), JSON.stringify(Object.keys(n)));
  check('не-объект даёт пустой порядок', JSON.stringify(normalizeOrder(['a'])) === '{}');
  check('null даёт пустой порядок', JSON.stringify(normalizeOrder(null)) === '{}');

  const huge = normalizeOrder({ postgresql: Array.from({ length: 900 }, (_, i) => `c:${i}`) });
  check('длина списка ограничена', huge.postgresql?.length === 500, String(huge.postgresql?.length));
}

// ── 4. Чтение и запись (на примере порядка категорий) ───────────────────────
{
  const store = memStore();
  const kinds = ['oracle', 'mysql', 'sqlite'];
  check('пустое хранилище — пустой порядок', JSON.stringify(kindOrderStore.load('admin', store).order) === '{}');
  check('пустое хранилище не считается повреждением', kindOrderStore.load('admin', store).corrupted === false);

  kindOrderStore.save('admin', { [KIND_GROUP]: kinds }, store);
  const back = kindOrderStore.load('admin', store);
  check('порядок категорий сохранился', JSON.stringify(back.order) === JSON.stringify({ [KIND_GROUP]: kinds }), JSON.stringify(back.order));
  check('плоский список читается как есть', JSON.stringify(kindOrderStore.flat(back.order)) === JSON.stringify(kinds), JSON.stringify(kindOrderStore.flat(back.order)));
  check('чужой пользователь не видит порядок', JSON.stringify(kindOrderStore.load('editor', store).order) === '{}');

  kindOrderStore.clear('admin', store);
  check('сброс очистил хранилище', JSON.stringify(kindOrderStore.load('admin', store).order) === '{}');
}
{
  // Порядок баз и порядок категорий не должны путаться между собой.
  const store = memStore();
  kindOrderStore.save('admin', { [KIND_GROUP]: ['sqlite'] }, store);
  dbOrderStore.save('admin', { postgresql: ['c:a'] }, store);
  // map.size, а не Object.keys: у Map собственные свойства — это внутренние
  // поля, а не ключи хранилища.
  check('оба домена лежат рядом', store.map.size === 2, JSON.stringify([...store.map.keys()]));
  check('базы не попали в порядок категорий', JSON.stringify(kindOrderStore.flat(kindOrderStore.load('admin', store).order)) === JSON.stringify(['sqlite']));
  check('категории не попали в порядок баз', JSON.stringify(dbOrderStore.load('admin', store).order.postgresql) === JSON.stringify(['c:a']));
}
{
  // Битое значение: молча вернуть «как по умолчанию» — значит потерять настройку
  // молча. Пользователь должен узнать об этом.
  const store = memStore();
  store.map.set(kindOrderStore.storageKey('admin'), '{ это не json');
  const broken = kindOrderStore.load('admin', store);
  check('битое значение помечается', broken.corrupted === true && Object.keys(broken.order).length === 0, JSON.stringify(broken));
}
{
  // Разобранный, но бессмысленный объект — тоже повреждение.
  const store = memStore();
  store.map.set(kindOrderStore.storageKey('admin'), JSON.stringify({ [KIND_GROUP]: [1, 2, 3] }));
  const parsedJunk = kindOrderStore.load('admin', store);
  check('мусор внутри JSON помечается', parsedJunk.corrupted === true, JSON.stringify(parsedJunk));
}
{
  // localStorage может быть недоступен (приватный режим): это не исключение.
  const brokenStore = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); }
  };
  check('недоступное хранилище не ломает чтение', JSON.stringify(kindOrderStore.load('admin', brokenStore).order) === '{}');
  check('недоступное хранилище не ломает запись', kindOrderStore.save('admin', { [KIND_GROUP]: ['a'] }, brokenStore) === false);
  check('null-хранилище не ломает ничего', JSON.stringify(kindOrderStore.load('admin', null).order) === '{}' && kindOrderStore.save('admin', {}, null) === false);
}

// ── 5. Перестановка мышью ────────────────────────────────────────────────────
// Семантика — «вставить до/после строки»: сторона выбирается курсором, потому
// что в списке высотой 28 пикселей режим «только перед» делал бы перенос на
// соседнюю строку пустым действием.
{
  const order = ['a', 'b', 'c', 'd'];
  const M = (from: string, to: string, pos?: 'before' | 'after') => JSON.stringify(moveKey(order, from, to, pos));
  check('вверх: a перед b', M('a', 'b') === JSON.stringify(['a', 'b', 'c', 'd']), M('a', 'b'));
  check('вверх: d перед b', M('d', 'b') === JSON.stringify(['a', 'd', 'b', 'c']), M('d', 'b'));
  check('вниз: a после b', M('a', 'b', 'after') === JSON.stringify(['b', 'a', 'c', 'd']), M('a', 'b', 'after'));
  check('вниз: b после a', M('b', 'a', 'after') === JSON.stringify(['a', 'b', 'c', 'd']), M('b', 'a', 'after'));
  check('вниз на последнюю строку', M('a', 'd', 'after') === JSON.stringify(['b', 'c', 'd', 'a']), M('a', 'd', 'after'));
  check('вверх с последней строки', M('d', 'a', 'before') === JSON.stringify(['d', 'a', 'b', 'c']), M('d', 'a', 'before'));
  check('в середину после', M('d', 'b', 'after') === JSON.stringify(['a', 'b', 'd', 'c']), M('d', 'b', 'after'));
  check('перенос на себя — без изменений', moveKey(order, 'b', 'b') === order);
  check('перенос на себя с after — без изменений', moveKey(order, 'b', 'b', 'after') === order);
  check('исходный массив не мутируется', JSON.stringify(order) === JSON.stringify(['a', 'b', 'c', 'd']), JSON.stringify(order));
  check('неизвестный источник вставляется', M('z', 'c') === JSON.stringify(['a', 'b', 'z', 'c', 'd']), M('z', 'c'));
  check('неизвестный источник с after', M('z', 'c', 'after') === JSON.stringify(['a', 'b', 'c', 'z', 'd']), M('z', 'c', 'after'));
  check('неизвестная цель — в конец', M('a', 'zz') === JSON.stringify(['b', 'c', 'd', 'a']), M('a', 'zz'));
  check('оба неизвестны — без изменений', moveKey(order, 'q', 'w') === order);
  check('перенос первого в конец', JSON.stringify(moveKey(['a', 'b', 'c'], 'a', 'zz')) === JSON.stringify(['b', 'c', 'a']));
  check('перенос в пустой список', JSON.stringify(moveKey([], 'a', 'b')) === JSON.stringify([]));
}

// ── 6. Перестановка стрелками (клавиатура) ───────────────────────────────────
// Возврат ТОГО ЖЕ массива — не просто оптимизация: по нему вызывающий понимает,
// что сдвинуть некуда, и не гасит событие клавиши (стрелка должна прокручивать).
{
  const order = ['a', 'b', 'c'];
  check('стрелка вниз', JSON.stringify(moveKeyBy(order, 'a', 1)) === JSON.stringify(['b', 'a', 'c']), JSON.stringify(moveKeyBy(order, 'a', 1)));
  check('стрелка вверх', JSON.stringify(moveKeyBy(order, 'c', -1)) === JSON.stringify(['a', 'c', 'b']), JSON.stringify(moveKeyBy(order, 'c', -1)));
  check('вверх на первом — без изменений', moveKeyBy(order, 'a', -1) === order);
  check('вниз на последнем — без изменений', moveKeyBy(order, 'c', 1) === order);
  check('нулевой сдвиг — без изменений', moveKeyBy(order, 'b', 0) === order);
  check('неизвестный ключ — без изменений', moveKeyBy(order, 'zz', 1) === order);
  check('исходный массив не мутируется', JSON.stringify(order) === JSON.stringify(['a', 'b', 'c']));
  const back = moveKeyBy(moveKeyBy(order, 'a', 1), 'a', -1);
  check('туда и обратно', JSON.stringify(back) === JSON.stringify(['a', 'b', 'c']), JSON.stringify(back));
  check('сдвиг на два через соседей', JSON.stringify(moveKeyBy(moveKeyBy(order, 'a', 1), 'a', 1)) === JSON.stringify(['b', 'c', 'a']));
}

// ── 7. Применение порядка к строкам ──────────────────────────────────────────
{
  const rows = [
    { conn: 'c1', db: 'a' },
    { conn: 'c1', db: 'b' },
    { conn: 'c1', db: 'c' }
  ];
  const key = (r: { conn: string; db: string }) => dbRowKey(r.conn, r.db);
  const by = (list: string[]) => sortRows(rows, key, list).map(r => r.db).join(',');
  check('порядок применяется', by(['c1:c', 'c1:a', 'c1:b']) === 'c,a,b', by(['c1:c', 'c1:a', 'c1:b']));
  check('пустой порядок оставляет как есть', by([]) === 'a,b,c', by([]));
  check('одна строка не трогается', sortRows(rows.slice(0, 1), key, ['c1:c']).map(r => r.db).join(',') === 'a');
  // Новая база (ключа нет в хранилище) идёт в конец и не вытесняет выбранное:
  // иначе она прыгала бы наверх при каждом обновлении списка.
  check('новая база уходит в конец', by(['c1:c', 'c1:a']) === 'c,a,b', by(['c1:c', 'c1:a']));
  check('несколько новых сохраняют порядок сервера', by(['c1:c']) === 'c,a,b', by(['c1:c']));
  check('исходный массив не мутируется', rows.map(r => r.db).join(',') === 'a,b,c');
}

// ── 8. Порядок категорий поверх SUPPORTED_KINDS ────────────────────────────
// Тип, добавленный позже (Oracle), без явного перемещения обязан оказаться в
// конце, а не вытеснить то, что пользователь уже расставил.
{
  const supported = ['mysql', 'mariadb', 'postgresql', 'sqlite', 'mongodb', 'redis', 'oracle'];
  const ordered = (order: string[]) => sortRows(supported, k => k, order);
  check('без сохранения порядок как в SUPPORTED_KINDS', ordered([]).join(',') === supported.join(','), ordered([]).join(','));
  check('сохранённый порядок главный', ordered(['sqlite', 'mysql']).slice(0, 2).join(',') === 'sqlite,mysql', ordered(['sqlite', 'mysql']).join(','));
  check('Oracle без перемещения уходит в конец', ordered(['sqlite', 'mysql']).indexOf('oracle') === supported.length - 1, ordered(['sqlite', 'mysql']).join(','));
  check('перемещённый Oracle встаёт куда надо', ordered(['oracle', 'sqlite', 'mysql']).slice(0, 3).join(',') === 'oracle,sqlite,mysql', ordered(['oracle', 'sqlite', 'mysql']).join(','));
  // Тип, выключенный в настройках, просто отсутствует в списке — и фильтруется
  // ДО сортировки, поэтому сохранённый порядок не может его «восстановить».
  const visible = supported.filter(k => k !== 'redis');
  check('выключенный тип не возвращается порядком', sortRows(visible, k => k, ['redis', 'mysql']).join(',') === 'mysql,mariadb,postgresql,sqlite,mongodb,oracle', sortRows(visible, k => k, ['redis', 'mysql']).join(','));
}

// ── 9. Порядок переживает перечитывание ─────────────────────────────────────
// Ключ строки строится из id подключения и имени базы, а не из позиции: после
// refresh те же базы обязаны встать в то же место.
{
  const rows = [
    { conn: 'c1', db: 'shop' },
    { conn: 'c1', db: 'main' }
  ];
  const key = (r: { conn: string; db: string }) => dbRowKey(r.conn, r.db);
  // Первое перетаскивание: в хранилище пусто, поэтому база для перестановки —
  // текущий видимый список (именно так поступает Sidebar.handleDrop).
  const visible = rows.map(key);
  const saved = moveKey(visible, dbRowKey('c1', 'main'), dbRowKey('c1', 'shop'), 'before');
  const fresh = sortRows(rows, key, saved).map(r => r.db).join(',');
  check('первое перетаскивание запоминается', fresh === 'main,shop', fresh);
  check('сохранённый порядок применён к новому ответу списка', JSON.stringify(saved) === JSON.stringify(['c1:main', 'c1:shop']), JSON.stringify(saved));

  // Возврат: shop ставим перед main. Обратите внимание — «после main» было бы
  // пустым действием (там он и стоит), поэтому сторона выбирается сознательно.
  const moved = moveKey(saved, dbRowKey('c1', 'shop'), dbRowKey('c1', 'main'), 'before');
  check('перестановка назад тем же способом', sortRows(rows, key, moved).map(r => r.db).join(',') === 'shop,main', JSON.stringify(moved));
  check('«после себя же» — пустое действие', JSON.stringify(moveKey(saved, dbRowKey('c1', 'shop'), dbRowKey('c1', 'main'), 'after')) === JSON.stringify(saved));
}

const bad = results.filter(x => !x).length;
console.log(bad ? `\nORDER STORE: ${bad} ПРОВАЛЕНО из ${results.length}` : `\nORDER STORE ALL GREEN (${results.length})`);
process.exit(bad ? 1 : 0);