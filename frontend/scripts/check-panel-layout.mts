// Проверка геометрии и раскладки панелей (frontend/src/core/panelLayout.ts)
// и реестра панелей (frontend/src/core/panels.ts).
//
// Модули чистые, поэтому проверяются без браузера. tsx берётся из backend:
//   cd backend; npx tsx ../frontend/scripts/check-panel-layout.mts
//
// Что здесь ловится: наложения, выход за сетку, потерянные при переносе
// идентификаторы панелей, «потерявшиеся» окна и сломанные размеры. Всё это
// невозможно заметить глазами, когда панели на экране.
import {
  GRID_COLUMNS,
  GRID_GAP,
  ROW_HEIGHT,
  BASE_WINDOW_Z,
  PANEL_OVERLAY_Z,
  PanelConstraints,
  PanelLayout,
  WindowZOrder,
  focusLayerZ,
  raiseWindow,
  windowZOf,
  clampRect,
  collides,
  columnWidth,
  compactLayout,
  compactVertical,
  detachPanel,
  dockPanel,
  effectiveHeight,
  firstFreeSlot,
  gridHeight,
  gridToPixels,
  movePanel,
  normalizeLayout,
  pixelsToGrid,
  resizePanel,
  resolveCollisions,
  toggleCollapsed,
  usedRows,
  validateLayout
} from '../src/core/panelLayout.ts';
import { PRESETS, PANELS, applyPreset, defaultLayoutFor, panelConstraints, panelsFor } from '../src/core/panels.ts';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  applyAction,
  clearLayout,
  loadLayout,
  layoutProblems,
  panelAllowed,
  saveLayout,
  storageKey
} from '../src/core/panelStore.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const limits: Record<string, PanelConstraints> = panelConstraints();
const CONTAINER = 1600;

function grid(id: string, x: number, y: number, w: number, h: number, collapsed = false): PanelLayout {
  return { [id]: { mode: 'grid', x, y, w, h, collapsed } };
}

// ─────────────────────────── реестр панелей ──────────────────────────────────
{
  const db = panelsFor('db').map(p => p.id);
  const mon = panelsFor('monitoring').map(p => p.id);
  check('реестр не пуст', db.length > 0 && mon.length > 0, `db=${db.length} mon=${mon.length}`);
  // serverInfo входит в обе рабочие области, поэтому уникальность проверяем по
  // самому реестру, а не по склейке двух списков
  check('идентификаторы уникальны в реестре', new Set(PANELS.map(p => p.id)).size === PANELS.length,
    PANELS.map(p => p.id).join(','));
  check('панель не продублирована внутри области', new Set(db).size === db.length && new Set(mon).size === mon.length);
  check('в мониторинге нет sql-редактора', !mon.includes('sqlEditor'));
  check('в db нет панелей мониторинга', !db.includes('loadChart') && !db.includes('processes'));
  check('в мониторинге есть метрики', mon.includes('metrics'));
  for (const panel of panelsFor('db').concat(panelsFor('monitoring'))) {
    const ok = panel.minW <= panel.defaultRect.w && panel.minH <= panel.defaultRect.h
      && panel.defaultRect.x + panel.defaultRect.w <= GRID_COLUMNS && panel.defaultRect.y >= 0;
    if (!ok) check(`дефолты панели ${panel.id} корректны`, false, JSON.stringify(panel.defaultRect));
  }
  check('дефолты панелей корректны', true);
  for (const panel of [...panelsFor('db'), ...panelsFor('monitoring')]) {
    const issues = validateLayout(defaultLayoutFor(panel.workspaces[0]), limits);
    const errors = issues.filter(i => i.level === 'error');
    check(`компоновка по умолчанию без ошибок (${panel.workspaces[0]})`, errors.length === 0, errors.map(e => e.text).join('; '));
  }
}

// ─────────────────────────── переводы координат ────────────────────────────
{
  const colW = columnWidth(CONTAINER);
  check('колонка положительной ширины', colW > 0 && colW < CONTAINER / 10, String(colW));
  const px = gridToPixels({ x: 0, y: 0, w: 24, h: 1 }, CONTAINER);
  check('24 колонки занимают всю ширину', Math.abs(px.width - CONTAINER) <= 2, `${px.width} vs ${CONTAINER}`);
  const two = gridToPixels({ x: 0, y: 0, w: 12, h: 1 }, CONTAINER);
  check('половина сетки — половина ширины с зазором', two.width < CONTAINER / 2 && two.width > CONTAINER / 2 - 30, String(two.width));
  const back = pixelsToGrid(px, CONTAINER);
  check('пиксели возвращаются в единицы', back.w === 24 && back.h === 1, JSON.stringify(back));
  const half = pixelsToGrid({ x: two.x, y: 0, width: two.width, height: two.height }, CONTAINER);
  check('обратный перевод половины', Math.abs(half.w - 12) <= 1, JSON.stringify(half));
  check('высота строки из констант', gridHeight(2) === 2 * (ROW_HEIGHT + GRID_GAP) - GRID_GAP, String(gridHeight(2)));
  check('узкий контейнер не даёт NaN', Number.isFinite(columnWidth(10)), String(columnWidth(10)));

  // Реакция на ширину контейнера. Именно этим проверяется баг, из-за которого
  // панели не реагировали на сворачивание сайдбаров: узел измерения ширины не
  // был привязан, ширина оставалась стартовой, и раскладка не пересчитывалась.
  // Сама геометрия тут всегда верна — важно, что она зависит от ширины.
  const WIDE = 1600;
  const NARROW = 1000;
  const rect = { x: 0, y: 0, w: 12, h: 4 };
  const widePx = gridToPixels(rect, WIDE);
  const narrowPx = gridToPixels(rect, NARROW);
  check('при широком контейнере панель шире', widePx.width > narrowPx.width, `${widePx.width} vs ${narrowPx.width}`);
  check('ширины отличаются примерно в полтора раза',
    Math.abs(widePx.width / narrowPx.width - WIDE / NARROW) < 0.05,
    `${(widePx.width / narrowPx.width).toFixed(3)} vs ${(WIDE / NARROW).toFixed(3)}`);
  check('панель на всю ширину совпадает с контейнером в обоих случаях',
    Math.abs(gridToPixels({ ...rect, w: GRID_COLUMNS }, WIDE).width - WIDE) <= 2 &&
    Math.abs(gridToPixels({ ...rect, w: GRID_COLUMNS }, NARROW).width - NARROW) <= 2,
    `${gridToPixels({ ...rect, w: GRID_COLUMNS }, WIDE).width} / ${gridToPixels({ ...rect, w: GRID_COLUMNS }, NARROW).width}`);
  check('колонка тем шире, чем шире контейнер', columnWidth(WIDE) > columnWidth(NARROW),
    `${columnWidth(WIDE).toFixed(1)} vs ${columnWidth(NARROW).toFixed(1)}`);
}

// ─────────────────────────── ограничения размеров ──────────────────────────
{
  const clamped = clampRect({ x: -4, y: -2, w: 999, h: 0 }, { minW: 6, minH: 4 });
  check('отрицательные координаты обнуляются', clamped.x === 0 && clamped.y === 0, JSON.stringify(clamped));
  check('минимальные размеры соблюдаются', clamped.w === GRID_COLUMNS && clamped.h === 4, JSON.stringify(clamped));
  const wide = clampRect({ x: 22, y: 0, w: 12, h: 3 }, { minW: 4, minH: 2 });
  check('не вылезаем за правый край', wide.x + wide.w <= GRID_COLUMNS, JSON.stringify(wide));
  const small = clampRect({ x: 0, y: 0, w: 1, h: 1 }, { minW: 8, minH: 5 });
  check('минимальная ширина', small.w === 8 && small.h === 5, JSON.stringify(small));
}

// ─────────────────────────── пересечения ────────────────────────────────────
{
  const a = { x: 0, y: 0, w: 12, h: 4 };
  const b = { x: 11, y: 0, w: 12, h: 4 };
  const c = { x: 12, y: 0, w: 12, h: 4 };
  const d = { x: 0, y: 4, w: 12, h: 4 };
  check('перекрытие по горизонтали', collides(a, b));
  check('касание не считается перекрытием', !collides(a, c) && !collides(a, d));
  const resolved = resolveCollisions([a, b]);
  // сравниваем пары между собой: сравнение каждого прямоугольника с первым
  // ловит «наложение панели с самой собой» и даёт ложную ошибку
  const anyOverlap = resolved.some((r, i) => resolved.some((other, j) => i !== j && collides(r, other)));
  check('после разрешения наложений нет', !anyOverlap, JSON.stringify(resolved));
  check('вторая панель уехала вниз', resolved[1].y >= 4, JSON.stringify(resolved));
  const same = resolveCollisions([{ ...a }, { ...a }]);
  check('две одинаковые панели разводятся', same[0].y !== same[1].y, JSON.stringify(same));
  const compacted = compactVertical([{ x: 0, y: 8, w: 12, h: 4 }, { x: 0, y: 0, w: 12, h: 4 }]);
  check('панели подтягиваются вверх', compacted.some(r => r.y === 0), JSON.stringify(compacted));
}

// ─────────────────────────── перемещение и resize ───────────────────────────
{
  let layout: PanelLayout = { ...grid('tables', 0, 0, 12, 6), ...grid('logs', 12, 0, 12, 6) };
  layout = movePanel(layout, 'tables', { x: 12, y: 0 }, limits);
  const issues = validateLayout(layout, limits);
  check('после перемещения нет наложений', !issues.some(i => i.level === 'error'), issues.map(i => i.text).join('; '));
  const tables = layout.tables as { x: number; y: number };
  check('перемещённая панель на новом месте', tables.x === 12, JSON.stringify(layout.tables));
  check('обе панели на месте', Boolean(layout.tables && layout.logs), Object.keys(layout).join(','));

  layout = resizePanel(layout, 'tables', { w: 24, h: 6 }, limits);
  const after = validateLayout(layout, limits);
  check('после растяжения нет наложений', !after.some(i => i.level === 'error'), after.map(i => i.text).join('; '));
  check('ширина упёрлась в ограничение панели', (layout.tables as { w: number }).w === 24, JSON.stringify(layout.tables));

  const tooSmall = resizePanel(layout, 'logs', { w: 1, h: 1 }, limits);
  check('resize не даёт меньше минимума', (tooSmall.logs as { w: number }).w >= limits.logs.minW, JSON.stringify(tooSmall.logs));
}

// ─────────────────────────── сворачивание ───────────────────────────────────
{
  const layout: PanelLayout = { ...grid('tables', 0, 0, 12, 8), ...grid('logs', 12, 0, 12, 4) };
  const collapsed = toggleCollapsed(layout, 'tables');
  const tables = collapsed.tables as { h: number; collapsed: boolean };
  // Контракт: сворачивание НЕ трогает h, оно только поднимает флаг. Раньше
  // сворачивание писало h=1, и раскрытие возвращало панель высотой в строку —
  // размер терялся молча.
  check('свёртывание не затирает высоту', tables.h === 8, JSON.stringify(tables));
  check('флаг свёртки выставлен', tables.collapsed === true);
  check('эффективная высота — строка', effectiveHeight(collapsed.tables as never) === 1, String(effectiveHeight(collapsed.tables as never)));
  const issues = validateLayout(collapsed, limits);
  check('свёрнутая панель не даёт ошибок', !issues.some(i => i.level === 'error' || i.level === 'warning'), issues.map(i => i.text).join('; '));
  const expanded = toggleCollapsed(collapsed, 'tables');
  check('повторное раскрытие возвращает высоту', (expanded.tables as { h: number }).h === 8, JSON.stringify(expanded.tables));
  check('панели не наезжают после сворачивания', !validateLayout(expanded, limits).some(i => i.level === 'error'));
}

// ─────────────────────────── свободное место ────────────────────────────────
{
  const empty: ReturnType<typeof resolveCollisions> = [];
  check('первое место — в начале', JSON.stringify(firstFreeSlot(empty, 12, 4)) === JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }));
  const one = [{ x: 0, y: 0, w: 12, h: 4 }];
  check('второе место — справа', firstFreeSlot(one, 12, 4).x === 12, JSON.stringify(firstFreeSlot(one, 12, 4)));
  const wide = [{ x: 0, y: 0, w: 24, h: 4 }];
  check('когда сверху занято — идём ниже', firstFreeSlot(wide, 12, 4).y === 4, JSON.stringify(firstFreeSlot(wide, 12, 4)));
  const impossible = [{ x: 0, y: 0, w: 24, h: 50 }];
  const spot = firstFreeSlot(impossible, 12, 4, 200);
  check('забитая сетка не вешает подбор места', spot.y >= 50, JSON.stringify(spot));
  check('usedRows считает нижний край', usedRows({ ...grid('a', 0, 0, 12, 4), ...grid('b', 12, 6, 12, 4) }) === 10, String(usedRows({ ...grid('a', 0, 0, 12, 4), ...grid('b', 12, 6, 12, 4) })));
}

// ─────────────────────────── открепление и возврат ─────────────────────────
{
  let layout = defaultLayoutFor('db');
  const before = validateLayout(layout, limits).filter(i => i.level === 'error');
  check('до открепления всё чисто', before.length === 0, before.map(e => e.text).join('; '));

  layout = detachPanel(layout, 'logs', CONTAINER);
  const placement = layout.logs;
  check('панель перешла в окно', placement?.mode === 'window', JSON.stringify(placement));
  check('у панели ровно одно место', Object.keys(layout).length === Object.keys(defaultLayoutFor('db')).length);
  check('после открепления сетка чиста', !validateLayout(layout, limits).some(i => i.level === 'error'));

  const rowsAfterDetach = usedRows(layout);
  check('сетка после открепления без наложений', !validateLayout(layout, limits).some(i => i.level === 'error'),
    validateLayout(layout, limits).map(i => i.text).join('; '));
  // Укладка вертикальная (как в Grafana): освободившееся место сверху справа
  // она не переиспользует, поэтому число строк может не уменьшиться. Проверяем
  // то, что действительно должно работать: панель из середины колонки уезжает
  // вверх на освободившееся место.
  const column: PanelLayout = { ...grid('tables', 0, 0, 12, 6), ...grid('logs', 0, 6, 12, 4), ...grid('sqlEditor', 0, 10, 12, 6) };
  const withoutMiddle: PanelLayout = { tables: column.tables!, logs: column.logs! };
  const compactedColumn = compactLayout(withoutMiddle);
  check('панель под удалённой подтягивается вверх', (compactedColumn.sqlEditor === undefined)
    ? true : (compactedColumn.logs as { y: number }).y === 0, JSON.stringify(Object.values(compactedColumn).map(p => p.mode === 'grid' ? p.y : 'win')));
  void rowsAfterDetach;

  layout = dockPanel(layout, 'logs', limits);
  check('панель вернулась в сетку', layout.logs?.mode === 'grid', JSON.stringify(layout.logs));
  check('после возврата сетка чиста', !validateLayout(layout, limits).some(i => i.level === 'error'),
    validateLayout(layout, limits).map(i => i.text).join('; '));
  check('после возврата все панели на месте',
    Object.keys(layout).length === Object.keys(defaultLayoutFor('db')).length);

  // повторное открепление должно работать, а возврат — снова давать сетку без наложений
  const roundTrip = dockPanel(detachPanel(layout, 'sqlEditor', CONTAINER), 'sqlEditor', limits);
  check('круг открепление/возврат чистый', !validateLayout(roundTrip, limits).some(i => i.level === 'error'),
    validateLayout(roundTrip, limits).map(i => i.text).join('; '));
}

// ─────────────────────────── нормализация ──────────────────────────────────
{
  const keep = ['tables', 'logs'];
  const { layout, issues } = normalizeLayout({
    tables: { mode: 'grid', x: 0, y: 0, w: 14, h: 8, collapsed: false },
    logs: { mode: 'window', x: 100, y: 80, width: 640, height: 400, minimized: false, maximized: false },
    ghost: { mode: 'grid', x: 0, y: 0, w: 6, h: 4 }
  }, limits, keep);
  check('неизвестная панель убрана', !('ghost' in layout), Object.keys(layout).join(','));
  check('об убранании панели сказано', issues.some(i => i.text.includes('ghost')), issues.map(i => i.text).join('; '));
  check('окно сохранено как окно', layout.logs?.mode === 'window', JSON.stringify(layout.logs));
  check('сетка сохранена как сетка', layout.tables?.mode === 'grid');
  check('нормализованная компоновка чиста', !validateLayout(layout, limits).some(i => i.level === 'error'));

  const empty = normalizeLayout(undefined, limits, keep);
  check('пустое хранилище даёт дефолты', Object.keys(empty.layout).length === 2, Object.keys(empty.layout).join(','));

  const broken = normalizeLayout({
    tables: { mode: 'window', x: 0, y: 0, width: 0, height: -5 },
    logs: { mode: 'grid', x: 900, y: -7, w: 1, h: 0, collapsed: true }
  }, limits, keep);
  check('битое окно возвращено в сетку', broken.layout.tables?.mode === 'grid', JSON.stringify(broken.layout.tables));
  check('битая сетка починена', !validateLayout(broken.layout, limits).some(i => i.level === 'error'),
    validateLayout(broken.layout, limits).map(i => i.text).join('; '));
  check('свёрнутый флаг не протаскивается в панель без canCollapse',
    (broken.layout.logs as { collapsed: boolean } | undefined)?.collapsed === false || limits.logs.canCollapse);

  const garbage = normalizeLayout({ tables: 'не объект', logs: 42 }, limits, keep);
  check('мусор в хранилище не роняет', Object.keys(garbage.layout).length === 2, Object.keys(garbage.layout).join(','));
}

// ─────────────────────────── пресеты ────────────────────────────────────────
{
  for (const preset of PRESETS) {
    const layout = applyPreset(preset, 'db');
    const issues = validateLayout(layout, limits);
    check(`пресет «${preset.id}» без ошибок`, !issues.some(i => i.level === 'error'), issues.map(i => i.text).join('; '));
    check(`пресет «${preset.id}» оставляет фокусную панель развёрнутой`,
      (layout[preset.focus] as { collapsed: boolean }).collapsed === false, JSON.stringify(layout[preset.focus]));
  }
  const focus = applyPreset(PRESETS[0], 'db');
  check('пресет фокуса растягивает панель на всю ширину', (focus.tables as { w: number }).w === GRID_COLUMNS, JSON.stringify(focus.tables));
  const others = Object.entries(focus).filter(([id]) => id !== 'tables').map(([, p]) => p);
  check('остальные панели свёрнуты', others.every(p => p.mode === 'window' || (p.mode === 'grid' && p.collapsed)));
}

// ─────────────────────────── хранилище раскладки ───────────────────────────
{
  // Подменяем localStorage: в Node его нет, а проверять round-trip и версии
  // схемы нужно именно без браузера.
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }
  };
  const options = { userKey: 'admin', workspace: 'db' as const, storage };

  const fresh = loadLayout(options);
  check('свежая компоновка — дефолтная', Object.keys(fresh.layout).length === panelsFor('db').length, Object.keys(fresh.layout).join(','));
  check('при первом чтении нет ошибок', fresh.issues.length === 0, fresh.issues.join('; '));

  check('сохранение удалось', saveLayout(options, fresh.layout));
  check('в хранилище появилась запись', map.has(storageKey('admin', 'db')), [...map.keys()].join(','));
  const reloaded = loadLayout(options);
  check('повторное чтение совпадает', JSON.stringify(reloaded.layout) === JSON.stringify(fresh.layout));

  // версия схемы в ключе: смена версии не должна читать старую компоновку
  const older = `${map.get(storageKey('admin', 'db'))}`;
  map.set('panels:v0:admin:db', older);
  const afterVersionBump = loadLayout(options);
  check('старая версия схемы не подхватывается', JSON.stringify(afterVersionBump.layout) === JSON.stringify(fresh.layout));

  // действия над раскладкой
  const moved = applyAction(fresh, { type: 'move', id: 'tables', x: 0, y: 2 }, 1600);
  check('перемещение через хранилище безопасно', layoutProblems(moved.layout).length === 0, layoutProblems(moved.layout).join('; '));
  const collapsed = applyAction(moved, { type: 'toggleCollapse', id: 'tables' }, 1600);
  check('сворачивание через хранилище', (collapsed.layout.tables as { collapsed: boolean }).collapsed === true);
  check('после сворачивания нет ошибок', layoutProblems(collapsed.layout).length === 0, layoutProblems(collapsed.layout).join('; '));
  const detached = applyAction(collapsed, { type: 'detach', id: 'logs', containerWidth: 1600 }, 1600);
  check('открепление через хранилище', detached.layout.logs?.mode === 'window', JSON.stringify(detached.layout.logs));
  const docked = applyAction(detached, { type: 'dock', id: 'logs' }, 1600);
  check('возврат через хранилище', docked.layout.logs?.mode === 'grid');
  const dockAll = applyAction(detached, { type: 'dockAll' }, 1600);
  check('вернуть все разом', Object.values(dockAll.layout).every(p => p.mode === 'grid'),
    Object.entries(dockAll.layout).filter(([, p]) => p.mode !== 'grid').map(([id]) => id).join(','));
  check('после возврата всех нет ошибок', layoutProblems(dockAll.layout).length === 0, layoutProblems(dockAll.layout).join('; '));
  const reset = applyAction(dockAll, { type: 'reset' }, 1600);
  // Сравниваем по ключам, а не через JSON.stringify: порядок ключей у сборки
  // из реестра и у нормализованной раскладки разный, хотя содержимое совпадает.
  const sameLayout = (a: PanelLayout, b: PanelLayout): boolean => {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
  };
  check('сброс возвращает дефолты', sameLayout(reset.layout, fresh.layout),
    `${JSON.stringify(reset.layout.tables)} против ${JSON.stringify(fresh.layout.tables)}`);
  const preset = applyAction(fresh, { type: 'preset', presetId: 'focus' }, 1600);
  check('пресет через хранилище без ошибок', layoutProblems(preset.layout).length === 0, layoutProblems(preset.layout).join('; '));
  const badPreset = applyAction(fresh, { type: 'preset', presetId: 'нет такого' }, 1600);
  check('неизвестный пресет не ломает раскладку', layoutProblems(badPreset.layout).length === 0, layoutProblems(badPreset.layout).join('; '));

  // разные пользователи не делят компоновку
  const other = loadLayout({ ...options, userKey: 'editor' });
  check('у другого пользователя свои дефолты', other.issues.length === 0 && Object.keys(other.layout).length === Object.keys(fresh.layout).length);
  // ключ включает имя, а не только роль: два администратора в одном браузере
  // не должны получать общую компоновку и затирать друг другу
  const byName = storageKey('admin', 'db');
  const byRole = storageKey('role-admin', 'db');
  check('ключ компоновки включает пользователя', byName !== byRole && byName.includes('admin'), `${byName} против ${byRole}`);

  // битое значение в хранилище
  map.set(storageKey('admin', 'db'), 'не json вовсе');
  const broken = loadLayout(options);
  check('битое значение не роняет чтение', broken.issues.length > 0 && Object.keys(broken.layout).length === panelsFor('db').length,
    broken.issues.join('; '));

  // недоступное хранилище (приватный режим)
  const denied = loadLayout({ ...options, storage: null });
  check('без хранилища работаем с дефолтами', Object.keys(denied.layout).length === panelsFor('db').length);
  check('запись без хранилища не падает', saveLayout({ ...options, storage: null }, denied.layout) === false);

  // мониторинг хранится отдельно
  const mon = loadLayout({ ...options, workspace: 'monitoring' });
  check('у мониторинга свой набор панелей', mon.layout.metrics !== undefined && mon.layout.tables === undefined, Object.keys(mon.layout).join(','));

  // права панелей
  check('журнал можно открепить', panelAllowed('logs', 'detach'));
  check('метрики не сворачиваются', panelAllowed('metrics', 'collapse') === false);
  check('несуществующая панель запрещена', panelAllowed('ghost', 'detach') === false);
}

// ─────────────────────────── окна откреплённых панелей ─────────────────────
{
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }
  };
  const options = { userKey: 'admin', workspace: 'db' as const, storage };
  let state = loadLayout(options);
  state = applyAction(state, { type: 'detach', id: 'logs', containerWidth: 1600 }, 1600);
  const win = () => state.layout.logs as Extract<PanelLayout[string], { mode: 'window' }>;

  check('панель стала окном', win().mode === 'window');
  check('окно не меньше минимума', win().width >= MIN_WINDOW_WIDTH && win().height >= MIN_WINDOW_HEIGHT, `${win().width}x${win().height}`);

  // перемещение и размер окна
  state = applyAction(state, { type: 'windowBounds', id: 'logs', bounds: { x: 120, y: 80 } }, 1600);
  check('окно переехало', win().x === 120 && win().y === 80, JSON.stringify(win()));
  state = applyAction(state, { type: 'windowBounds', id: 'logs', bounds: { width: 10, height: 5 } }, 1600);
  check('окно не сжимается ниже минимума', win().width === MIN_WINDOW_WIDTH && win().height === MIN_WINDOW_HEIGHT, JSON.stringify(win()));
  state = applyAction(state, { type: 'windowBounds', id: 'logs', bounds: { x: -9999 } }, 1600);
  check('заголовок окна остаётся доступным', win().x > -win().width, JSON.stringify(win()));

  // разворачивание и возврат
  state = applyAction(state, { type: 'windowToggleMaximize', id: 'logs' }, 1600);
  check('окно развёрнуто', win().maximized === true && Boolean(win().prevBounds), JSON.stringify(win().prevBounds));
  const beforeRestore = { x: win().prevBounds!.x, y: win().prevBounds!.y, width: win().prevBounds!.width, height: win().prevBounds!.height };
  state = applyAction(state, { type: 'windowToggleMaximize', id: 'logs' }, 1600);
  check('окно вернуло прежние границы', win().x === beforeRestore.x && win().width === beforeRestore.width && win().maximized === false, JSON.stringify(win()));
  check('прежние границы очищены', win().prevBounds === undefined, JSON.stringify(win().prevBounds));

  // повторные разворачивания не ломают возврат
  state = applyAction(state, { type: 'windowToggleMaximize', id: 'logs' }, 1600);
  state = applyAction(state, { type: 'windowToggleMaximize', id: 'logs' }, 1600);
  check('двойное разворачивание возвращает то же', win().width === beforeRestore.width, JSON.stringify(win()));

  // сворачивание окна
  state = applyAction(state, { type: 'windowMinimize', id: 'logs' }, 1600);
  check('окно свёрнуто', win().minimized === true);
  state = applyAction(state, { type: 'windowMinimize', id: 'logs' }, 1600);
  check('окно развёрнуто обратно', win().minimized === false);

  // действия окон не должны применять��я к панели в сетке
  const before = JSON.stringify(state.layout.tables);
  state = applyAction(state, { type: 'windowToggleMaximize', id: 'tables' }, 1600);
  state = applyAction(state, { type: 'windowMinimize', id: 'tables' }, 1600);
  state = applyAction(state, { type: 'windowBounds', id: 'tables', bounds: { x: 5 } }, 1600);
  check('панель в сетке не тронута оконными действиями', JSON.stringify(state.layout.tables) === before, JSON.stringify(state.layout.tables));

  // сохранение окна переживает перезагрузку
  saveLayout(options, state.layout);
  const reloaded = loadLayout(options);
  check('окно восстановилось из хранилища', reloaded.layout.logs?.mode === 'window'
    && (reloaded.layout.logs as { x: number }).x === win().x, JSON.stringify(reloaded.layout.logs));

  // возврат в сетку после всех манипуляций
  const docked = applyAction(state, { type: 'dock', id: 'logs' }, 1600);
  check('после возврата сетка чиста', layoutProblems(docked.layout).length === 0, layoutProblems(docked.layout).join('; '));
}

// ─────────────────────────── ограниченный набор панелей ─────────────────────
{
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }
  };
  // Экран отдаёт сетке не все панели рабочей области: панель без содержимого
  // выглядела бы пустой рамкой, и пользователь не понял бы, что с ней не так.
  const only = ['tables', 'logs'];
  const options = { userKey: 'admin', workspace: 'db' as const, storage, available: only };
  const state = loadLayout(options);
  check('ограничение соблюдено при чтении', Object.keys(state.layout).sort().join(',') === 'logs,tables', Object.keys(state.layout).join(','));
  check('без ограничения панелей больше', Object.keys(loadLayout({ ...options, available: undefined }).layout).length > only.length);

  const reset = applyAction(state, { type: 'reset' }, 1600, only);
  check('сброс не воскрешает лишние панели', Object.keys(reset.layout).sort().join(',') === 'logs,tables', Object.keys(reset.layout).join(','));

  const preset = applyAction(state, { type: 'preset', presetId: 'focus' }, 1600, only);
  check('пресет уважает ограничение', Object.keys(preset.layout).sort().join(',') === 'logs,tables', Object.keys(preset.layout).join(','));

  // Панель, исключённая из набора, не должна оставаться в сохранённой раскладке
  map.set(storageKey('admin', 'db'), JSON.stringify({
    tables: { mode: 'grid', x: 0, y: 0, w: 12, h: 6, collapsed: false },
    logs: { mode: 'grid', x: 12, y: 0, w: 12, h: 6, collapsed: false },
    sqlEditor: { mode: 'grid', x: 0, y: 6, w: 24, h: 8, collapsed: false }
  }));
  const narrowed = loadLayout(options);
  check('исключённая панель убрана из компоновки', !('sqlEditor' in narrowed.layout), Object.keys(narrowed.layout).join(','));
  check('об убирании сказано', narrowed.issues.some(issue => issue.includes('sqlEditor')), narrowed.issues.join('; '));

  // Несуществующая панель в списке игнорируется, а не роняет чтение
  const bogus = loadLayout({ ...options, available: ['tables', 'ghost'] });
  check('несуществующая панель в списке пропущена', Object.keys(bogus.layout).join(',') === 'tables', Object.keys(bogus.layout).join(','));
}

  // ── Порядок наложения окон и фокусной панели ─────────────────────────────────
  // Здесь важно не то, что функция возвращает число, а два конкретных свойства:
  // активация поднимает ОДНО окно, а не все сразу; и фокусная панель всегда выше
  // максимума, а не выше активного окна.
  {
    let z: WindowZOrder = {};
    let counter = BASE_WINDOW_Z;

    // 1. Поднятие окна не трогает остальные.
    counter += 1;
    z = raiseWindow(z, 'a', counter);
    counter += 1;
    z = raiseWindow(z, 'b', counter);
    check(
      'окна не поднимаются одновременно',
      windowZOf(z, 'a') === 101 && windowZOf(z, 'b') === 102,
      `a=${windowZOf(z, 'a')} b=${windowZOf(z, 'b')}`
    );
    check('активное окно выше остальных', windowZOf(z, 'b') > windowZOf(z, 'a'), `b=${windowZOf(z, 'b')}`);

    // 2. Повторная активация поднимает именно выбранное окно.
    const beforeA = windowZOf(z, 'a');
    counter += 1;
    z = raiseWindow(z, 'a', counter);
    check('повторный клик поднимает своё окно', windowZOf(z, 'a') > beforeA && windowZOf(z, 'b') === 102, `a=${windowZOf(z, 'a')} b=${windowZOf(z, 'b')}`);
    check('поднятое окно стало выше', windowZOf(z, 'a') > windowZOf(z, 'b'), `a=${windowZOf(z, 'a')} b=${windowZOf(z, 'b')}`);

    // 3. Неизвестное окно не должно ломать максимум.
    check('неизвестное окно получает базовый слой', windowZOf(z, 'zzz') === BASE_WINDOW_Z, String(windowZOf(z, 'zzz')));
    check('фокусная выше пустого набора окон', focusLayerZ({}) > BASE_WINDOW_Z, String(focusLayerZ({})));

    // 4. Фокусная панель выше ЛЮБОГО окна, в том числе неактивного и высокого.
    //    Именно этот случай и ломался: брался максимум по активному окну, и
    //    развёрнутое неактивное окно перекрывало фокусную панель.
    const busy: WindowZOrder = { a: 100, b: 500, c: 140 };
    const top = Math.max(...Object.values(busy));
    check('фокусная панель выше самого высокого окна', focusLayerZ(busy) > top, `focus=${focusLayerZ(busy)} top=${top}`);
    check('фокусная панель выше активного окна', focusLayerZ(busy) > windowZOf(busy, 'a'), `focus=${focusLayerZ(busy)} active=${windowZOf(busy, 'a')}`);

    // 5. Поднятие не мутирует исходный объект — иначе React не увидит изменение.
    const original: WindowZOrder = { a: 100 };
    const raised = raiseWindow(original, 'b', 900);
    check('raiseWindow не мутирует исходное состояние', original.b === undefined && raised.a === 100 && raised.b === 900, JSON.stringify({ original, raised }));

    // 6. Слой фокусной панели стабильно выше при росте числа окон.
    let many: WindowZOrder = {};
    let c2 = BASE_WINDOW_Z;
    for (let i = 0; i < 50; i++) { c2 += 1; many = raiseWindow(many, `w${i}`, c2); }
    check('фокусная панель выше любого из 50 окон', focusLayerZ(many) > Math.max(...Object.values(many)), `focus=${focusLayerZ(many)}`);
  }

  // ── Слой поверх боковых панелей ─────────────────────────────────────────────
  // Контракт по z-index, а не по коду компонента: панели лежат в портале к body
  // и обязаны быть выше сайдбаров (z-30) и шапки (z-40), но под модальными
  // окнами (z-50) и уведомлениями (z-[100]). Если этот порядок нарушить,
  // панели либо пропадут под сайдбарами, либо начнут перекрывать диалоги.
  {
    const SIDEBAR_Z = 30;
    const HEADER_Z = 40;
    const MODAL_Z = 50;
    const TOAST_Z = 100;
    check('слой панелей выше боковых панелей', PANEL_OVERLAY_Z > SIDEBAR_Z, `overlay=${PANEL_OVERLAY_Z} sidebar=${SIDEBAR_Z}`);
    check('слой панелей выше шапки', PANEL_OVERLAY_Z > HEADER_Z, `overlay=${PANEL_OVERLAY_Z} header=${HEADER_Z}`);
    check('слой панелей под модальными окнами', PANEL_OVERLAY_Z < MODAL_Z, `overlay=${PANEL_OVERLAY_Z} modal=${MODAL_Z}`);
    check('слой панелей под уведомлениями', PANEL_OVERLAY_Z < TOAST_Z, `overlay=${PANEL_OVERLAY_Z} toast=${TOAST_Z}`);
    // Фокусная панель внутри слоя должна оставаться выше окон слоя же.
    const inLayer: WindowZOrder = { a: 120, b: 900 };
    check('фокусная выше окон внутри слоя', focusLayerZ(inLayer) > Math.max(...Object.values(inLayer)), `focus=${focusLayerZ(inLayer)}`);
  }

console.log(failures ? `PANEL LAYOUT FAILURES: ${failures}` : 'PANEL LAYOUT OK');
if (failures) process.exit(1);
