import type { PanelConstraints, PanelLayout } from './panelLayout';
import { compactLayout, resolveCollisions, resolveLayout } from './panelLayout';

/**
 * Реестр панелей: что вообще можно размещать в рабочей области.
 *
 * До этого списка не существовало — окна были зашиты в компонент как
 * перечисление из трёх названий, и любая новая панель требовала правки типа,
 * рендера и панели задач. Здесь только метаданные: иконки и содержимое
 * живут в компонентах, чтобы модуль оставался пригодным для проверки скриптом.
 *
 * `workspaces` отделяет рабочую область базы от мониторинга: наборы панелей
 * разные, и компоновки хранятся раздельно.
 */

export type PanelWorkspace = 'db' | 'monitoring';

export interface PanelDef extends PanelConstraints {
  id: string;
  /** Ключ перевода заголовка — сам текст живёт в locales. */
  titleKey: string;
  /** Короткое имя для пресетов и подсказок. */
  short: string;
  workspaces: PanelWorkspace[];
  /** Панель нельзя закрыть (в отличие от просто скрытой). */
  essential?: boolean;
  /** Порядок в списке панелей и в таскбаре. */
  order: number;
}

export const PANELS: PanelDef[] = [
  {
    id: 'tables',
    titleKey: 'main.panels.tables',
    short: 'Таблицы',
    workspaces: ['db'],
    essential: true,
    order: 10,
    minW: 6, minH: 4,
    defaultRect: { x: 0, y: 0, w: 14, h: 8 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'logs',
    titleKey: 'main.panels.logs',
    short: 'Журнал',
    workspaces: ['db'],
    order: 20,
    minW: 6, minH: 3,
    defaultRect: { x: 14, y: 0, w: 10, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'sqlEditor',
    titleKey: 'main.panels.sqlEditor',
    short: 'SQL',
    workspaces: ['db'],
    order: 30,
    minW: 8, minH: 5,
    defaultRect: { x: 14, y: 6, w: 10, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'search',
    titleKey: 'main.panels.search',
    short: 'Поиск',
    workspaces: ['db'],
    order: 40,
    minW: 8, minH: 4,
    defaultRect: { x: 0, y: 8, w: 12, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'designer',
    titleKey: 'main.panels.designer',
    short: 'Конструктор',
    workspaces: ['db'],
    order: 50,
    minW: 10, minH: 6,
    defaultRect: { x: 0, y: 8, w: 24, h: 10 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'serverInfo',
    titleKey: 'main.panels.serverInfo',
    short: 'Сервер',
    workspaces: ['db', 'monitoring'],
    order: 60,
    minW: 6, minH: 4,
    defaultRect: { x: 0, y: 0, w: 8, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'dbUsers',
    titleKey: 'main.panels.dbUsers',
    short: 'Пользователи БД',
    workspaces: ['db'],
    order: 70,
    minW: 8, minH: 5,
    defaultRect: { x: 8, y: 0, w: 16, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'metrics',
    titleKey: 'main.panels.metrics',
    short: 'Метрики',
    workspaces: ['monitoring'],
    essential: true,
    order: 10,
    minW: 6, minH: 3,
    defaultRect: { x: 0, y: 0, w: 24, h: 4 },
    canCollapse: false,
    canDetach: true
  },
  {
    id: 'loadChart',
    titleKey: 'main.panels.loadChart',
    short: 'Нагрузка',
    workspaces: ['monitoring'],
    order: 20,
    minW: 6, minH: 5,
    defaultRect: { x: 0, y: 4, w: 12, h: 8 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'queryChart',
    titleKey: 'main.panels.queryChart',
    short: 'Запросы',
    workspaces: ['monitoring'],
    order: 30,
    minW: 6, minH: 5,
    defaultRect: { x: 12, y: 4, w: 12, h: 8 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'processes',
    titleKey: 'main.panels.processes',
    short: 'Процессы',
    workspaces: ['monitoring'],
    order: 40,
    minW: 6, minH: 4,
    defaultRect: { x: 0, y: 12, w: 24, h: 6 },
    canCollapse: true,
    canDetach: true
  },
  {
    id: 'dbSizes',
    titleKey: 'main.panels.dbSizes',
    short: 'Размеры БД',
    workspaces: ['monitoring'],
    order: 50,
    minW: 6, minH: 4,
    defaultRect: { x: 0, y: 18, w: 12, h: 6 },
    canCollapse: true,
    canDetach: true
  }
];

/** Ограничения панелей в виде, который ждёт panelLayout. */
export function panelConstraints(): Record<string, PanelConstraints> {
  return Object.fromEntries(PANELS.map(({ id, minW, minH, defaultRect, canCollapse, canDetach }) =>
    [id, { minW, minH, defaultRect, canCollapse, canDetach }]));
}

/** Панели рабочей области, отсортированные как в интерфейсе. */
export function panelsFor(workspace: PanelWorkspace): PanelDef[] {
  return PANELS.filter(panel => panel.workspaces.includes(workspace)).sort((a, b) => a.order - b.order);
}

export function panelById(id: string): PanelDef | undefined {
  return PANELS.find(panel => panel.id === id);
}

/**
 * Компоновка по умолчанию для набора панелей.
 *
 * Прямоугольники в реестре — это пожелание, а не готовая раскладка: они
 * пересекаются (панели-праймари занимают один и тот же верх), и разводить их
 * должен сам модуль раскладки. Иначе каждый новый панель приходилось бы
 * вручную укладывать в координаты — и рано или поздно они наезжали друг на
 * друга, что и случилось до появления проверки.
 *
 * `only` ограничивает набор: экран может отдать сетке не все панели рабочей
 * области (мониторинг, например), и пустые рамки без содержимого рисовать
 * незачем.
 */
export function defaultLayoutFor(workspace: PanelWorkspace, only?: string[]): PanelLayout {
  const allowed = only ? new Set(only) : null;
  const panels = panelsFor(workspace).filter(panel => !allowed || allowed.has(panel.id));
  if (!panels.length) return {};
  // Сортируем ДО разведения: resolveCollisions возвращает панели в порядке (y, x),
  // а не в порядке реестра. Без сортировки панели получали бы чужие координаты —
  // ровно тот случай, когда компоновка выглядит рабочей, а принадлежит не тем
  // панелям.
  const ordered = [...panels].sort((a, b) =>
    a.defaultRect.y - b.defaultRect.y || a.defaultRect.x - b.defaultRect.x);
  const resolved = resolveCollisions(ordered.map(panel => ({ ...panel.defaultRect })));
  const layout: PanelLayout = {};
  ordered.forEach((panel, index) => {
    layout[panel.id] = { mode: 'grid', ...resolved[index], collapsed: false };
  });
  return compactLayout(layout);
}

/**
 * Пресеты компоновки. Сворачивание всех панелей кроме одной — самая частая
 * просьба после первой установки: «таблицы на весь экран».
 */
export interface LayoutPreset {
  id: string;
  titleKey: string;
  /** Панель, которую растягиваем, остальные убираем в свёрнутое состояние. */
  focus: string;
}

export const PRESETS: LayoutPreset[] = [
  { id: 'focus', titleKey: 'main.panels.presetFocus', focus: 'tables' },
  { id: 'sideBySide', titleKey: 'main.panels.presetSideBySide', focus: 'tables' }
];

export function applyPreset(preset: LayoutPreset, workspace: PanelWorkspace, only?: string[]): PanelLayout {
  const layout = defaultLayoutFor(workspace, only);
  for (const id of Object.keys(layout)) {
    if (id === preset.focus) continue;
    const placement = layout[id];
    if (placement.mode === 'grid') layout[id] = { ...placement, collapsed: true };
  }
  const focus = layout[preset.focus];
  if (preset.id === 'focus' && focus?.mode === 'grid') {
    layout[preset.focus] = { ...focus, collapsed: false, x: 0, y: 0, w: 24, h: 14 };
  }
  // Свёрнутые панели остались на прежних местах, а фокусная заняла всю ширину:
  // без повторного разрешения они наехали бы друг на друга.
  return resolveLayout(layout);
}
