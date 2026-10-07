/**
 * Геометрия и раскладка панелей. Модуль намеренно чистый: без React, без DOM и
 * без обращений к API — иначе его нельзя проверить скриптом, а проверять тут
 * есть что (см. scripts/check-panel-layout.mts).
 *
 * Модель размеров — как в Grafana: сетка из 24 колонок, высота строки фиксирована,
 * панель хранит `{x, y, w, h}` в grid-единицах, а не в пикселях. Благодаря этому
 * при изменении ширины окна панели перестраиваются, а не растягиваются случайным
 * образом, и компоновка переживает другой монитор.
 *
 * «Место» панели описано размеченным объединением (discriminated union): либо
 * ячейка сетки, либо плавающее окно. Одновременно иметь оба нельзя by
 * construction — именно это требование мы уже нарушали, когда окна и сетка
 * жили отдельно.
 */

export const GRID_COLUMNS = 24;
/** Высота одной строки сетки в пикселях (шапка + содержимое). */
export const ROW_HEIGHT = 40;
/** Зазор между панелями в пикселях. */
export const GRID_GAP = 8;
/** Шаг, с которым панели опускаются при разрешении пересечений. */
export const COLLISION_STEP = 1;

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  /** Границы до разворачивания: нужны, чтобы вернуть окно на место. */
  prevBounds?: WindowBounds;
}

export type PanelPlacement =
  | ({ mode: 'grid' } & GridRect & { collapsed: boolean })
  | ({ mode: 'window' } & WindowBounds);
export type PanelLayout = Record<string, PanelPlacement>;

export interface PanelConstraints {
  minW: number;
  minH: number;
  defaultRect: GridRect;
  /** Сворачиваемая ли панель. */
  canCollapse: boolean;
  /** Можно ли вынести в отдельное окно. */
  canDetach: boolean;
}

// ───────────────────────────── пиксели и сетка ─────────────────────────────

/** Ширина одной колонки при заданной ширине контейнера. */
export function columnWidth(containerWidth: number): number {
  const usable = containerWidth - GRID_GAP * (GRID_COLUMNS - 1);
  return Math.max(1, usable / GRID_COLUMNS);
}

/** Переводит прямоугольник сетки в пиксели для контейнера заданной ширины. */
export function gridToPixels(rect: GridRect, containerWidth: number): WindowBounds {
  const colW = columnWidth(containerWidth);
  return {
    x: Math.round(rect.x * (colW + GRID_GAP)),
    y: rect.y * (ROW_HEIGHT + GRID_GAP),
    width: Math.round(rect.w * (colW + GRID_GAP) - GRID_GAP),
    height: rect.h * (ROW_HEIGHT + GRID_GAP) - GRID_GAP,
    minimized: false,
    maximized: false
  };
}

/** Обратное преобразование: пиксели -> единицы сетки (для окон, ставших в сетку). */
export function pixelsToGrid(bounds: { x: number; y: number; width: number; height: number }, containerWidth: number): GridRect {
  const colW = columnWidth(containerWidth);
  return {
    x: Math.max(0, Math.round(bounds.x / (colW + GRID_GAP))),
    y: Math.max(0, Math.round(bounds.y / (ROW_HEIGHT + GRID_GAP))),
    w: Math.max(1, Math.round((bounds.width + GRID_GAP) / (colW + GRID_GAP))),
    h: Math.max(1, Math.round((bounds.height + GRID_GAP) / (ROW_HEIGHT + GRID_GAP)))
  };
}

/** Прямоугольник в пикселях -> сколько строк сетки он занимает (для расчёта контейнера). */
export function gridHeight(rows: number): number {
  return rows * (ROW_HEIGHT + GRID_GAP) - GRID_GAP;
}

// ─────────────────────────── ограничения и нормализация ─────────────────────

export function clampRect(rect: GridRect, limits: Pick<PanelConstraints, 'minW' | 'minH'>): GridRect {
  // Ширину считаем первой: x должен влезать относительно ИТОГОВОЙ w, иначе
  // панель, растянутая с x=12 до w=24, уезжает за правый край сетки.
  const w = Math.max(limits.minW, Math.min(GRID_COLUMNS, Math.round(rect.w)));
  const h = Math.max(limits.minH, Math.round(rect.h));
  return {
    x: Math.max(0, Math.min(GRID_COLUMNS - w, Math.round(rect.x))),
    y: Math.max(0, Math.round(rect.y)),
    w,
    h
  };
}

export function collides(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ───────────────────────────── разрешение пересечений ───────────────────────

/**
 * Опускает панели, пока они не перестанут пересекаться (поведение Grafana).
 * Сортировка по y, затем по x: панель, которая и так ниже, не заставляет
 * подниматься тех, кто выше неё.
 *
 * ВАЖНО: возвращает панели в порядке (y, x), а не в порядке аргумента.
 * Вызывающий, который сопоставляет результат с исходным списком по индексу,
 * обязан заранее отсортировать вход так же — иначе панели поменяются местами
 * без единой ошибки.
 */
export function resolveCollisions(rects: GridRect[]): GridRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: GridRect[] = [];
  for (const item of sorted) {
    let rect = { ...item };
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of placed) {
        if (collides(rect, other)) {
          rect = { ...rect, y: other.y + other.h };
          moved = true;
          break;
        }
      }
    }
    placed.push(rect);
  }
  return placed;
}

/** Подтягивает панели вверх, где есть свободное место. */
export function compactVertical(rects: GridRect[]): GridRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: GridRect[] = [];
  for (const item of sorted) {
    let rect = { ...item };
    let moved = true;
    while (moved) {
      moved = false;
      // поднимаемся, пока не упрёмся в панель прямо над нами
      for (const other of placed) {
        if (!collides(rect, other)) continue;
        if (other.y + other.h <= rect.y) {
          const candidate = { ...rect, y: other.y + other.h };
          if (candidate.y < rect.y && !placed.some(p => collides(candidate, p))) {
            rect = candidate;
            moved = true;
            break;
          }
        }
      }
    }
    placed.push(rect);
  }
  return placed;
}

// ───────────────────────────── операции с панелью ──────────────────────────

/**
 * Перемещение панели с выталкиванием остальных вниз.
 */
export function movePanel(layout: PanelLayout, id: string, to: { x: number; y: number }, limits: Record<string, PanelConstraints>): PanelLayout {
  const current = layout[id];
  if (!current || current.mode !== 'grid') return layout;
  const moved = clampRect({ ...current, x: to.x, y: to.y }, limits[id] ?? { minW: 1, minH: 1 });
  return withResolvedRects(layout, id, moved);
}

/** Изменение размера панели с выталкиванием. */
export function resizePanel(layout: PanelLayout, id: string, to: { w: number; h: number }, limits: Record<string, PanelConstraints>): PanelLayout {
  const current = layout[id];
  if (!current || current.mode !== 'grid') return layout;
  const sized = clampRect({ ...current, w: to.w, h: to.h }, limits[id] ?? { minW: 1, minH: 1 });
  return withResolvedRects(layout, id, sized);
}

/** Прямоугольники панелей сетки вместе с их идентификаторами и флагом свёртки. */
function gridRects(layout: PanelLayout): (GridRect & { id: string; collapsed: boolean })[] {
  return Object.entries(layout)
    .filter((entry): entry is [string, Extract<PanelPlacement, { mode: 'grid' }>] => entry[1].mode === 'grid')
    .map(([id, placement]) => ({
      id,
      collapsed: placement.collapsed,
      x: placement.x,
      y: placement.y,
      w: placement.w,
      // Свёрнутая панель в расчётах занимает одну строку, но её развёрнутая
      // высота остаётся в placement.h и используется при раскрытии.
      h: effectiveHeight(placement)
    }));
}

/** Порядокок, в котором resolveCollisions сортирует панели. */
function byPosition(a: GridRect, b: GridRect): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * Подставляет новый прямоугольник панели и записывает обратно результат
 * разрешения пересечений.
 *
 * resolveCollisions теряет идентификаторы (сортирует по y,x), поэтому результат
 * сопоставляется с панелями в том же порядке сортировки. Именно это раньше
 * приходилось делать вручную в каждом месте — и одна копия разъехалась с
 * другой, что ломало компоновку всюду, где меняли размер.
 */
function withResolvedRects(layout: PanelLayout, id: string, rect: GridRect): PanelLayout {
  const ordered = gridRects(layout).sort(byPosition);
  if (!ordered.some(item => item.id === id)) return layout;
  const withOverride = ordered.map(item => (item.id === id ? { ...item, ...rect } : item));
  const resolved = resolveCollisions(withOverride.map(({ id: _, collapsed: _c, ...rest }) => rest));
  const next: PanelLayout = { ...layout };
  for (let i = 0; i < withOverride.length; i++) {
    const item = withOverride[i];
    const resolvedRect = resolved[i];
    const placement = next[item.id];
    if (placement?.mode !== 'grid' || !resolvedRect) continue;
    // Свёрнутой панели возвращаем её развёрнутую высоту: resolvedRect.h — это
    // одна строка, и записав её в h, мы бы потеряли размер при раскрытии.
    const h = item.collapsed ? placement.h : resolvedRect.h;
    next[item.id] = { ...placement, x: resolvedRect.x, y: resolvedRect.y, w: resolvedRect.w, h, collapsed: item.collapsed };
  }
  return next;
}

/** Свободное место в сетке под панель указанного размера — для возврата окна. */
export function firstFreeSlot(rects: GridRect[], w: number, h: number, maxRows = 200): GridRect {
  const width = Math.min(GRID_COLUMNS, w);
  const height = Math.max(1, h);
  for (let y = 0; y < maxRows; y++) {
    for (let x = 0; x + width <= GRID_COLUMNS; x++) {
      const candidate: GridRect = { x, y, w: width, h: height };
      if (!rects.some(rect => collides(candidate, rect))) return candidate;
    }
  }
  // Сетка кончилась — уходим вниз, пересечения разрешит resolveCollisions.
  return { x: 0, y: maxRows, w: width, h: height };
}

/** Сколько строк сетки занято раскладкой (для высоты контейнера). */
export function usedRows(layout: PanelLayout): number {
  return gridRects(layout).reduce((max, rect) => Math.max(max, rect.y + rect.h), 0);
}

// ───────────────────────────── переходы между слоями ───────────────────────

/** Открепить панель в плавающее окно, освободив место в сетке. */
export function detachPanel(
  layout: PanelLayout,
  id: string,
  containerWidth: number,
  options: { bounds?: Partial<WindowBounds> } = {}
): PanelLayout {
  const current = layout[id];
  if (!current || current.mode !== 'grid') return layout;
  const rect = current.collapsed ? { ...current, h: 1 } : current;
  const pixels = gridToPixels(rect, containerWidth);
  const next: PanelLayout = { ...layout };
  next[id] = {
    mode: 'window',
    x: options.bounds?.x ?? pixels.x,
    y: options.bounds?.y ?? pixels.y,
    width: options.bounds?.width ?? Math.max(320, pixels.width),
    height: options.bounds?.height ?? Math.max(180, pixels.height),
    minimized: false,
    maximized: false,
    prevBounds: undefined
  };
  return compactLayout(next);
}

/** Возвращает окно в сетку на первое свободное место. */
export function dockPanel(layout: PanelLayout, id: string, limits: Record<string, PanelConstraints>): PanelLayout {
  const current = layout[id];
  if (!current || current.mode !== 'window') return layout;
  const others = gridRects(layout).map(({ id: _, collapsed: _c, ...rect }) => rect);
  const limitsFor = limits[id] ?? { minW: 1, minH: 1 };
  // Место ищем под размер окна в колонках, но не уже минимального: окно могло
  // быть узким, а панель — нет, иначе вернулось бы крошечное.
  const wantedW = Math.max(limitsFor.minW, 6);
  const rect = clampRect(firstFreeSlot(others, wantedW, limitsFor.minH), limitsFor);
  const next: PanelLayout = { ...layout };
  next[id] = { mode: 'grid', ...rect, collapsed: false };
  return compactLayout(next);
}

/**
 * Свёртывание не трогает h: высота остаётся записанной в раскладке, а
 * «свёрнутость» — это флаг, по которому всё считает высоту равной 1 строке.
 * Раньше сворачивание писало h = 1, и повторное раскрытие возвращало панель
 * высотой в строку: пользователь терял размер молча, без всякой ошибки.
 */
export function toggleCollapsed(layout: PanelLayout, id: string): PanelLayout {
  const current = layout[id];
  if (!current || current.mode !== 'grid') return layout;
  const next: PanelLayout = { ...layout };
  next[id] = { ...current, collapsed: !current.collapsed };
  return compactLayout(next);
}

/** Высота панели в строках сетки с учётом свёртки. */
export function effectiveHeight(placement: Extract<PanelPlacement, { mode: 'grid' }>): number {
  return placement.collapsed ? 1 : placement.h;
}

/** Убрать пустые места над панелями после изменений. */
export function compactLayout(layout: PanelLayout): PanelLayout {
  // Порядок до укладки обязателен: compactVertical сортирует вход по (y, x) и
  // возвращает панели в этом же порядке. Без сортировки индекс i в ответе
  // принадлежал бы другой панели, и молча менялись бы местами целые блоки.
  const rects = gridRects(layout).sort(byPosition);
  if (rects.length < 2) return layout;
  const compacted = compactVertical(rects);
  const next: PanelLayout = { ...layout };
  for (let i = 0; i < rects.length; i++) {
    const placement = next[rects[i].id];
    if (placement?.mode !== 'grid') continue;
    const h = rects[i].collapsed ? placement.h : compacted[i].h;
    next[rects[i].id] = { ...placement, x: compacted[i].x, y: compacted[i].y, w: compacted[i].w, h };
  }
  return next;
}

/**
 * Полное разрешение раскладки: сначала вниз (пересечения), потом вверх
 * (пустоты). Нужен там, где компоновка меняется сразу у нескольких панелей —
 * пресеты, загрузка из хранилища, массовое сворачивание.
 */
export function resolveLayout(layout: PanelLayout): PanelLayout {
  const rects = gridRects(layout);
  if (!rects.length) return layout;
  const down = resolveCollisions(rects.map(({ id: _i, collapsed: _c, ...rect }) => rect));
  const ordered = [...rects].sort(byPosition);
  const merged: PanelLayout = { ...layout };
  for (let i = 0; i < ordered.length; i++) {
    const placement = merged[ordered[i].id];
    if (placement?.mode !== 'grid') continue;
    const h = ordered[i].collapsed ? placement.h : down[i].h;
    merged[ordered[i].id] = { ...placement, ...down[i], h };
  }
  return compactLayout(merged);
}

// ───────────────────────────── нормализация и валидация ─────────────────────

export interface LayoutIssue {
  level: 'error' | 'warning' | 'info';
  panelId?: string;
  text: string;
}

/**
 * Приводит сохранённую раскладку в порядок: убирает неизвестные панели, добавляет
 * недостающие, чинит выход за границы сетки и нарушения минимальных размеров.
 * Нужна при чтении из localStorage: формат меняется вместе с приложением, а
 * ломать компоновку у всех сразу нельзя.
 */
export function normalizeLayout(
  stored: unknown,
  known: Record<string, PanelConstraints>,
  keep: string[]
): { layout: PanelLayout; issues: LayoutIssue[] } {
  const issues: LayoutIssue[] = [];
  const layout: PanelLayout = {};
  const source = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const allowed = new Set(keep);
  // Отличаем «хранилища ещё не было» от «хранилище есть, но панели в нём нет».
  // Без этого первое же открытие панели рапортовало бы предупреждением на каждую
  // панель, и список проблем перестал бы что-то значить.
  const hadStorage = Object.keys(source).length > 0;

  for (const id of keep) {
    const limits = known[id];
    if (!limits) {
      issues.push({ level: 'warning', panelId: id, text: `нет ограничений для панели ${id}` });
      continue;
    }
    const raw = source[id];
    if (!raw || typeof raw !== 'object') {
      layout[id] = { mode: 'grid', ...limits.defaultRect, collapsed: false };
      if (hadStorage) issues.push({ level: 'warning', panelId: id, text: 'панель добавлена со значениями по умолчанию' });
      continue;
    }
    const value = raw as Partial<PanelPlacement> & Record<string, unknown>;
    if (value.mode === 'window') {
      const width = Number(value.width);
      const height = Number(value.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        layout[id] = { mode: 'grid', ...limits.defaultRect, collapsed: false };
        issues.push({ level: 'warning', panelId: id, text: 'размеры окна некорректны, панель возвращена в сетку' });
        continue;
      }
      layout[id] = {
        mode: 'window',
        x: Number(value.x) || 0,
        y: Number(value.y) || 0,
        width: Math.max(limits.minW, width),
        height: Math.max(limits.minH, height),
        minimized: value.minimized === true,
        maximized: value.maximized === true,
        prevBounds: (value.prevBounds as WindowBounds | undefined) ?? undefined
      };
      continue;
    }
    const rect = clampRect({
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      w: Number(value.w) || limits.defaultRect.w,
      h: Number(value.h) || limits.defaultRect.h
    }, limits);
    const collapsed = value.collapsed === true && limits.canCollapse;
    layout[id] = { mode: 'grid', ...rect, collapsed };
  }

  for (const id of Object.keys(source)) {
    if (allowed.has(id)) continue;
    issues.push({ level: 'info', panelId: id, text: `панель ${id} больше не существует, из компоновки убрана` });
  }

  // Дефолты панелей в реестре пересекаются (панели-праймари занимают один верх),
  // и клампинг этого не исправляет — он лишь сдвигает x. Поэтому собранную
  // раскладку прогоняем через то же разведение, что и при создании: иначе
  // компоновка из хранилища и компоновка по умолчанию для одних и тех же панелей
  // расходились бы, и «сброс компоновки» менял бы вёрстку вместо возврата к
  // исходной.
  return { layout: compactLayout(resolveLayout(layout)), issues };
}

/**
 * Инварианты раскладки. Нужен не для красоты: «у панели ровно одно место»
 * выполняется by construction (union), а вот наложения и выход за сетку —
 * реальные классы ошибок, которые надо ловить, а не замечать глазами.
 */
export function validateLayout(layout: PanelLayout, limits: Record<string, PanelConstraints>): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const rects = gridRects(layout);
  for (const item of rects) {
    const panelLimits = limits[item.id];
    if (!panelLimits) {
      issues.push({ level: 'error', panelId: item.id, text: 'панели нет в реестре' });
      continue;
    }
    // Свёрнутая панель занимает одну строку по определению, поэтому её размеры
    // вообще не сверяются с минимумом — иначе каждое сворачивание давало бы
    // предупреждение, а это штатное состояние, а не проблема.
    if (!item.collapsed && (item.w < panelLimits.minW || item.h < panelLimits.minH)) {
      issues.push({ level: 'warning', panelId: item.id, text: `размер меньше минимального (${item.w}×${item.h})` });
    }
    if (item.collapsed && item.w < panelLimits.minW) {
      issues.push({ level: 'warning', panelId: item.id, text: `ширина меньше минимальной (${item.w})` });
    }
    if (item.x < 0 || item.x + item.w > GRID_COLUMNS) {
      issues.push({ level: 'error', panelId: item.id, text: 'панель выходит за ширину сетки' });
    }
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (collides(rects[i], rects[j])) {
        issues.push({ level: 'error', panelId: rects[i].id, text: `наложение с панелью ${rects[j].id}` });
      }
    }
  }
  return issues;
}

/** Порядок наложения всплывающих окон. У каждого окна своя высота слоя, и
 * активация поднимает ровно одно окно. Общий счётчик у всех окон здесь был бы
 * ошибкой: он обновлял бы z у всех разом, порядок не менялся бы вовсе, и
 * активное окно оставалось бы ПОД остальными (в DOM решает последний, а не
 * активный). Старая система в MainContent хранила z в состоянии каждого окна. */
export type WindowZOrder = Record<string, number>;

export const BASE_WINDOW_Z = 100;

export function raiseWindow(z: WindowZOrder, id: string, next: number): WindowZOrder {
  return { ...z, [id]: next };
}

export function windowZOf(z: WindowZOrder, id: string): number {
  return z[id] ?? BASE_WINDOW_Z;
}

/** Слой фокусной панели: она обязана быть впереди ЛЮБОГО окна, поэтому берётся
 * максимум по всем окнам, а не по активному. */
export function focusLayerZ(z: WindowZOrder): number {
  const max = Object.values(z).reduce((top, value) => (value > top ? value : top), BASE_WINDOW_Z);
  return max + 1000;
}

/** Слой, в котором рисуются откреплённые окна и фокусная панель.
 *
 * Он вынесен в портал на уровень document.body, а остался внутри рабочей области
 * раньше — и тогда окна физически не могли выйти поверх боковых панелей: все
 * контейнеры вокруг сетки имеют overflow-hidden, то есть обрезали слой по краям
 * рабочей области. Панель уезжала под сайдбар и выглядела спрятанной, хотя
 * z-index был правильным — увеличивать его было бесполезно.
 *
 * Значение выбрано между сайдбарами (z-30) и шапкой (z-40) снизу, модальными
 * окнами (z-50) и уведомлениями (z-[100]) сверху: окна поверх интерфейса, но
 * под диалогами. Внутри слоя порядок задаётся windowZOf/focusLayerZ. */
export const PANEL_OVERLAY_Z = 45;
