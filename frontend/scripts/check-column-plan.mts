// Проверка планировщика изменений структуры (frontend/src/core/columnPlan.ts).
//
// Модуль чистый, без React и без БД, поэтому его можно прогнать без браузера:
// node_modules для скрипта берутся из backend (там уже есть tsx). Запуск:
//   cd backend; npx tsx ../frontend/scripts/check-column-plan.mts
//
// Ошибка в планировщике означала бы, что панель показала одни изменения, а
// серверу отправила другие, — самый дорогой вид ошибки в конструкторе.
import {
  ColumnCard,
  LoadedColumn,
  cardFromLoaded,
  cardToColumnDef,
  composeType,
  planChanges,
  splitType
} from '../src/core/columnPlan.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

let seq = 0;
function card(partial: Partial<ColumnCard> & { name: string }): ColumnCard {
  seq += 1;
  return {
    key: `k${seq}`,
    name: partial.name,
    type: partial.type ?? 'INT',
    length: partial.length ?? '',
    nullable: partial.nullable ?? true,
    primary: partial.primary ?? false,
    autoInc: partial.autoInc ?? false,
    def: partial.def ?? ''
  };
}

// --- разбор и сборка типа ---------------------------------------------------
check('splitType varchar(64)', JSON.stringify(splitType('varchar(64)')) === JSON.stringify({ type: 'VARCHAR', length: '64' }));
check('splitType без длины', JSON.stringify(splitType('integer')) === JSON.stringify({ type: 'INTEGER', length: '' }));
check('splitType мусор не падает', splitType('int unsigned').type === 'INT UNSIGNED');
check('composeType с длиной', composeType({ type: 'varchar', length: '32' }) === 'VARCHAR(32)');
check('composeType без длины', composeType({ type: 'VARCHAR', length: '' }) === 'VARCHAR');
check('composeType CHAR', composeType({ type: 'CHAR', length: '2' }) === 'CHAR(2)');
check('composeType не VARCHAR', composeType({ type: 'INT', length: '11' }) === 'INT');

// --- первичный ключ не может быть NULL ---------------------------------------
const pkCard = cardToColumnDef(card({ name: 'id', primary: true, autoInc: true, nullable: true }));
check('PK сбрасывает nullable', pkCard.nullable === false, JSON.stringify(pkCard));
check('PK сохраняет autoInc', pkCard.autoInc === true);
check('autoInc без PK отбрасывается', cardToColumnDef(card({ name: 'x', autoInc: true })).autoInc === false);

// --- пустое изменение --------------------------------------------------------
const base = [card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false })];
const plan0 = planChanges([...base], [...base]);
check('без изменений нет операций', plan0.ops.length === 0, JSON.stringify(plan0.ops));

// --- добавление --------------------------------------------------------------
const planAdd = planChanges([...base, card({ name: 'title', type: 'VARCHAR', length: '64' })], [...base]);
check('добавление одной колонки', planAdd.ops.length === 1 && planAdd.ops[0].op === 'addColumn', JSON.stringify(planAdd.ops));
check('счётчик добавлений', planAdd.add === 1);

// --- переименование ----------------------------------------------------------
// Отличается только имя — это переименование, а не удаление плюс добавление
const renamed = planChanges([card({ name: 'ident', type: 'INT', primary: true, autoInc: true, nullable: false })], [...base]);
check('переименование', renamed.ops.length === 1 && renamed.ops[0].op === 'renameColumn', JSON.stringify(renamed.ops));
check('переименование не удаляет', renamed.drop === 0 && renamed.add === 0);

// --- изменение свойств -------------------------------------------------------
const altered = planChanges([card({ name: 'id', type: 'BIGINT', primary: true, autoInc: true, nullable: false })], [...base]);
check('изменение типа', altered.ops.length === 1 && altered.ops[0].op === 'alterColumn', JSON.stringify(altered.ops));

// --- удаление ----------------------------------------------------------------
const dropped = planChanges([card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false })], [
  ...base, card({ name: 'junk', type: 'TEXT' })
]);
check('удаление колонки', dropped.ops.length === 1 && dropped.ops[0].op === 'dropColumn', JSON.stringify(dropped.ops));

// --- смена первичного ключа --------------------------------------------------
const pkSwapped = planChanges([
  card({ name: 'uuid', type: 'VARCHAR', length: '36', primary: true, nullable: false }),
  card({ name: 'id', type: 'INT', autoInc: false })
], [...base]);
check('смена PK даёт setPrimaryKey', pkSwapped.pkChanged === true && pkSwapped.ops.some(op => op.op === 'setPrimaryKey'), JSON.stringify(pkSwapped.ops));
const pkDropped = planChanges([card({ name: 'id', type: 'INT' })], [...base]);
check('снятие PK даёт dropPrimaryKey', pkDropped.ops.some(op => op.op === 'dropPrimaryKey'), JSON.stringify(pkDropped.ops));

// --- порядок операций: удаление всегда последнее -----------------------------
// Смешанный случай неоднозначен: если в базе есть TEXT-колонка, а на холсте
// появилась новая TEXT-колонка, «переименование» и «удалить + добавить» дают
// одну и ту же итоговую схему. Проверяем не конкретную догадку, а гарантии:
// переименованное не удаляется, удаление идёт последним, счётчики сходятся.
const mixed = planChanges([
  card({ name: 'ident', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'extra', type: 'TEXT' })
], [...base, card({ name: 'gone', type: 'TEXT' })]);
const kinds = mixed.ops.map(op => op.op);
check('переименованное не удаляется', !kinds.includes('dropColumn'), kinds.join(','));
check('обе колонки холста учтены', mixed.rename + mixed.add === 2, `${mixed.add}/${mixed.rename}/${mixed.drop}`);

// --- неоднозначное переименование не выдумывается --------------------------
// Две одинаковые колонки в базе + одна новая: переименовать неоднозначно,
// поэтому честный ответ — добавить новую (удаление не придумываем).
const ambiguous = planChanges([
  card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'note_new', type: 'TEXT' })
], [
  card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'note_a', type: 'TEXT' }),
  card({ name: 'note_b', type: 'TEXT' })
]);
check('неоднозначное переименование не выдумывается', ambiguous.rename === 0 && ambiguous.add === 1, JSON.stringify(ambiguous.ops.map(o => o.op)));

// --- переименование уникальной колонки остаётся переименованием -------------
const uniqueRename = planChanges([
  card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'title', type: 'VARCHAR', length: '64' })
], [
  card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'name', type: 'VARCHAR', length: '64' })
]);
check('уникальное переименование распознано', uniqueRename.rename === 1 && uniqueRename.drop === 0, JSON.stringify(uniqueRename.ops.map(o => o.op)));

// --- удаление идёт после всего остального -----------------------------------
const withDrop = planChanges([
  card({ name: 'id', type: 'BIGINT', primary: true, autoInc: true, nullable: false })
], [
  card({ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }),
  card({ name: 'gone', type: 'TEXT' })
]);
const dropKinds = withDrop.ops.map(op => op.op);
check('drop после alter и setPrimaryKey', dropKinds[dropKinds.length - 1] === 'dropColumn', dropKinds.join(','));

// --- загрузка схемы ----------------------------------------------------------
const loaded: LoadedColumn = { name: 'user_id', type: 'int(11)', nullable: false, primary: true, autoInc: true, default: null, ordinal: 1 };
const fromLoaded = cardFromLoaded(loaded, 'k1');
check('тип из схемы разобран', fromLoaded.type === 'INT' && fromLoaded.length === '11', JSON.stringify(fromLoaded));
check('PK из схемы', fromLoaded.primary === true && fromLoaded.nullable === false);
check('составной текст без скобок', cardFromLoaded({ ...loaded, type: 'character varying(64)' }, 'k2').type === 'CHARACTER VARYING');
check('значение по умолчанию', cardFromLoaded({ ...loaded, default: 'now()' }, 'k3').def === 'now()');

// --- регрессия: одинаковые подписи, но разные свойства — это не переименование
const confusable = planChanges([
  card({ name: 'a', type: 'INT' }),
  card({ name: 'b', type: 'VARCHAR', length: '10' })
], [card({ name: 'c', type: 'INT' }), card({ name: 'd', type: 'VARCHAR', length: '10' })]);
check('одинаковые свойства -> переименование', confusable.rename === 2 && confusable.add === 0, JSON.stringify(confusable.ops.map(o => o.op)));
const different = planChanges([card({ name: 'x', type: 'INT' })], [card({ name: 'y', type: 'BIGINT' })]);
check('разные свойства -> добавление', different.add === 1 && different.rename === 0, JSON.stringify(different.ops.map(o => o.op)));

console.log(failures ? `COLUMN PLAN FAILURES: ${failures}` : 'COLUMN PLAN OK');
if (failures) process.exit(1);
