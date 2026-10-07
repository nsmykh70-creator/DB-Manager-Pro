import type { PanelConstraints, PanelLayout, PanelPlacement, WindowBounds } from './panelLayout';
import {
  compactLayout,
  detachPanel,
  dockPanel,
  movePanel,
  normalizeLayout,
  resolveLayout,
  resizePanel,
  toggleCollapsed,
  validateLayout
} from './panelLayout';
import { PanelWorkspace, applyPreset, defaultLayoutFor, panelById, panelConstraints, panelsFor } from './panels';

/**
 * Хранилище раскладки панелей. Модуль намеренно без React: это редьюсеры плюс
 * работа с localStorage, которые проверяются скриптом (scripts/check-panel-layout.mts).
 * React-обёртка — отдельный usePanelLayout, который подписывается на это.
 *
 * Почему не «просто localStorage в компоненте»: компоновку читают и пишут сразу
 * несколько мест (сетка, таскбар откреплённых окон, кнопка сброса), и раскладка
 * должна нормализоваться ровно один раз при чтении, а не при каждом обращении.
 */

export const PANEL_LAYOUT_VERSION = 1;

export interface PanelStoreState {
  workspace: PanelWorkspace;
  layout: PanelLayout;
  /** Проблемы, найденные при чтении: показать один раз и забыть. */
  issues: string[];
}

export interface PanelStoreOptions {
  /** Кто смотрит панель: компоновка не должна переезжать между пользователями. */
  userKey: string;
  workspace: PanelWorkspace;
  /** Подмена хранилища для проверок. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /**
   * Панели, которые реально отданы экрану. Сетка рисует рамку каждой панели из
   * раскладки, поэтому панель без содержимого выглядела бы пустой рамкой, и
   * пользователь не понял бы, что с ней не так. По умолчанию — все панели
   * рабочей области.
   */
  available?: string[];
}

export function storageKey(userKey: string, workspace: PanelWorkspace): string {
  return `panels:v${PANEL_LAYOUT_VERSION}:${userKey || 'anonymous'}:${workspace}`;
}

/** Признак того, что значение в хранилище есть, но прочитать его нельзя. */
const CORRUPTED = Symbol('corrupted');

function readRaw(options: PanelStoreOptions): unknown {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  if (!storage) return null;
  try {
    const text = storage.getItem(storageKey(options.userKey, options.workspace));
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    // Молча начинать с дефолтов нельзя: у пользователя компоновка исчезла бы
    // без объяснения. Помечаем значение как повреждённое и сообщаем об этом.
    return CORRUPTED;
  }
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Приватный режим браузера и заблокированное хранилище
    return null;
  }
}

/** Чтение с нормализацией: неизвестные панели убираются, недостающие добавляются. */
export function loadLayout(options: PanelStoreOptions): PanelStoreState {
  const limits = panelConstraints();
  const keep = availablePanelIds(options);
  const raw = readRaw(options);
  const corrupted = raw === CORRUPTED;
  const { layout, issues } = normalizeLayout(corrupted ? null : raw, limits, keep);
  const messages = issues.map(issue => issue.text);
  if (corrupted) messages.push('сохранённая компоновка не читается, применены значения по умолчанию');
  return { workspace: options.workspace, layout, issues: messages };
}

/** Панели, которыми реально располагает экран. */
export function availablePanelIds(options: Pick<PanelStoreOptions, 'workspace' | 'available'>): string[] {
  if (options.available) return options.available.filter(id => panelById(id) !== undefined);
  return panelsFor(options.workspace).map(panel => panel.id);
}

export function saveLayout(options: PanelStoreOptions, layout: PanelLayout): boolean {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  if (!storage) return false;
  try {
    storage.setItem(storageKey(options.userKey, options.workspace), JSON.stringify(layout));
    return true;
  } catch {
    // Переполненное или недоступное хранилище — не повод ломать интерфейс
    return false;
  }
}

export function clearLayout(options: PanelStoreOptions): void {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  if (!storage) return;
  try {
    storage.removeItem(storageKey(options.userKey, options.workspace));
  } catch {
    // см. saveLayout
  }
}

// ───────────────────────────── действия над раскладкой ─────────────────────

export type PanelAction =
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'resize'; id: string; w: number; h: number }
  | { type: 'toggleCollapse'; id: string }
  | { type: 'detach'; id: string; containerWidth: number }
  | { type: 'dock'; id: string }
  | { type: 'dockAll' }
  | { type: 'reset' }
  | { type: 'preset'; presetId: string }
  | { type: 'windowBounds'; id: string; bounds: Partial<Pick<WindowBounds, 'x' | 'y' | 'width' | 'height'>> }
  | { type: 'windowMinimize'; id: string }
  | { type: 'windowToggleMaximize'; id: string };

/** Минимально допустимое окно: меньше панель не показать, но и нельзя потерять. */
export const MIN_WINDOW_WIDTH = 320;
export const MIN_WINDOW_HEIGHT = 180;

function moveWindowBounds(placement: Extract<PanelPlacement, { mode: 'window' }>, bounds: Partial<WindowBounds>) {
  const next = { ...placement, ...bounds };
  next.width = Math.max(MIN_WINDOW_WIDTH, Math.round(next.width));
  next.height = Math.max(MIN_WINDOW_HEIGHT, Math.round(next.height));
  // Окно не должно уезжать целиком за левый край: заголовок должен оставаться
  // доступным, иначе панель уже не вернуть в сетку.
  next.x = Math.max(-(next.width - 80), Math.round(next.x));
  next.y = Math.max(0, Math.round(next.y));
  return next;
}

/**
 * Единственное место, где раскладка меняется. Проверка инвариантов стоит здесь,
 * а не в компонентах: иначе одна из шести точек изменения рано или поздно её
 * обойдёт, и панели молча наедут друг на друга.
 */
export function applyAction(state: PanelStoreState, action: PanelAction, containerWidth: number, available?: string[]): PanelStoreState {
  const limits = panelConstraints();
  let layout: PanelLayout = state.layout;

  switch (action.type) {
    case 'move':
      layout = movePanel(layout, action.id, { x: action.x, y: action.y }, limits);
      break;
    case 'resize':
      layout = resizePanel(layout, action.id, { w: action.w, h: action.h }, limits);
      break;
    case 'toggleCollapse':
      layout = toggleCollapsed(layout, action.id);
      break;
    case 'detach':
      layout = detachPanel(layout, action.id, containerWidth);
      break;
    case 'dock':
      layout = dockPanel(layout, action.id, limits);
      break;
    case 'dockAll': {
      // Возвращаем все откреплённые окна в сетку по очереди: так каждая встаёт
      // на своё свободное место, а не все сразу ищут одно и то же.
      let next = layout;
      for (const id of Object.keys(layout)) {
        if (next[id]?.mode === 'window') next = dockPanel(next, id, limits);
      }
      layout = next;
      break;
    }
    case 'reset':
      layout = defaultLayoutFor(state.workspace, available);
      break;
    case 'preset': {
      const preset = ['focus', 'sideBySide'].includes(action.presetId) ? action.presetId : 'focus';
      layout = applyPreset({ id: preset, titleKey: `main.panels.preset${preset}`, focus: 'tables' }, state.workspace, available);
      break;
    }
    // ── окна ────────────────────────────────────────────────────────────────
    case 'windowBounds': {
      const placement = layout[action.id];
      if (placement?.mode !== 'window') return state;
      layout = { ...layout, [action.id]: moveWindowBounds(placement, action.bounds) };
      break;
    }
    case 'windowMinimize': {
      const placement = layout[action.id];
      if (placement?.mode !== 'window') return state;
      layout = { ...layout, [action.id]: { ...placement, minimized: !placement.minimized } };
      break;
    }
    case 'windowToggleMaximize': {
      const placement = layout[action.id];
      if (placement?.mode !== 'window') return state;
      // Границы до разворачивания запоминаем один раз: иначе «свернуть» после
      // разворачивания вернуло бы окно в развёрнутом виде.
      if (placement.maximized) {
        const restore = placement.prevBounds;
        layout = {
          ...layout,
          [action.id]: {
            ...placement,
            maximized: false,
            ...(restore ? { x: restore.x, y: restore.y, width: restore.width, height: restore.height } : {}),
            prevBounds: undefined
          }
        };
        break;
      }
      layout = {
        ...layout,
        [action.id]: {
          ...placement,
          maximized: true,
          prevBounds: { x: placement.x, y: placement.y, width: placement.width, height: placement.height, minimized: placement.minimized, maximized: false }
        }
      };
      break;
    }
  }

  return { ...state, layout };
}

/** Ошибки раскладки для отладочной панели: в проде их быть не должно. */
export function layoutProblems(layout: PanelLayout): string[] {
  return validateLayout(layout, panelConstraints()).map(issue => `${issue.panelId ?? '—'}: ${issue.text}`);
}

/** Панели, доступные для добавления в текущую область. */
export function availablePanels(workspace: PanelWorkspace) {
  return panelsFor(workspace);
}

/** Есть ли у панели право на открепление/сворачивание — UI спрашивает здесь. */
export function panelAllowed(id: string, action: 'detach' | 'collapse'): boolean {
  const panel = panelById(id);
  if (!panel) return false;
  return action === 'detach' ? panel.canDetach : panel.canCollapse;
}

export { compactLayout, resolveLayout, panelConstraints };
