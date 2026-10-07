import React from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Maximize2, Minimize2, Shrink, LayoutPanelTop } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { WindowFrame } from './WindowFrame';

/**
 * Состояние одной панели рабочей области.
 *
 *  grid    — панель занимает своё место в сетке 2×2;
 *  full    — развёрнута на всю рабочую область, остальные панели под ней;
 *  window  — откреплена в отдельное перетаскиваемое окно.
 *
 * Отдельный тип вместо булеваых флагов: с двумя флагами «развёрнута» и
 * «в окне» появляется невозможное сочетание, а по факту состояния
 * взаимоисключающие — панель либо в сетке, либо поверх неё, либо в окне.
 */
export type PaneMode = 'grid' | 'full' | 'window';

export interface PaneWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

export interface PaneState {
  mode: PaneMode;
  /** Свернута ли панель в самой сетке (шапка остаётся, содержимое скрыто). */
  collapsed: boolean;
  /** Границы окна, если панель откреплена. Сохраняются между раскладками. */
  win?: PaneWindowBounds;
}

export type PaneId = 'tables' | 'card' | 'logs' | 'sql';

export const DEFAULT_PANE: PaneState = { mode: 'grid', collapsed: false };

export const DEFAULT_WINDOW: PaneWindowBounds = {
  x: 140, y: 100, width: 760, height: 480, z: 130, minimized: false, maximized: false,
};

export type PaneStates = Record<PaneId, PaneState>;

const ORDER: PaneId[] = ['tables', 'card', 'logs', 'sql'];
/** Порядок панелей в сетке — им же определяется слой развёрнутой панели. */
export const PANE_ORDER = ORDER;
/** Нижняя граница z для откреплённых окон: выше панелей сетки (45), ниже окон (50). */
export const DETACHED_Z_MIN = 100;

/** Принимает только известные панели и допустимые режимы — мусор из хранилища не должен ломать экран. */
function sanitize(raw: unknown): PaneStates {
  const out = { ...DEFAULT_PANES } as PaneStates;
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const id of ORDER) {
    const p = src[id] as Partial<PaneState> | undefined;
    if (!p || typeof p !== 'object') continue;
    const mode: PaneMode = p.mode === 'full' || p.mode === 'window' ? p.mode : 'grid';
    const win = p.win && typeof p.win === 'object' ? p.win as Partial<PaneWindowBounds> : undefined;
    out[id] = {
      mode,
      collapsed: Boolean(p.collapsed),
      ...(win ? {
        win: {
          x: Number.isFinite(win.x) ? Number(win.x) : DEFAULT_WINDOW.x,
          y: Number.isFinite(win.y) ? Number(win.y) : DEFAULT_WINDOW.y,
          width: Number.isFinite(win.width) ? Math.max(320, Number(win.width)) : DEFAULT_WINDOW.width,
          height: Number.isFinite(win.height) ? Math.max(180, Number(win.height)) : DEFAULT_WINDOW.height,
          z: Number.isFinite(win.z) ? Number(win.z) : DEFAULT_WINDOW.z,
          minimized: Boolean(win.minimized),
          maximized: Boolean(win.maximized),
        },
      } : {}),
    };
  }
  return out;
}

const DEFAULTS: Record<PaneId, PaneState> = {
  tables: { mode: 'grid', collapsed: false },
  card: { mode: 'grid', collapsed: false },
  logs: { mode: 'grid', collapsed: false },
  sql: { mode: 'grid', collapsed: false },
};
export const DEFAULT_PANES: PaneStates = { ...DEFAULTS };

/** Читает раскладку панелей из хранилища; битые данные не приводят к падению. */
export function loadPaneStates(key: string): { states: PaneStates; corrupted: boolean } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { states: { ...DEFAULT_PANES }, corrupted: false };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { states: { ...DEFAULT_PANES }, corrupted: true };
    return { states: sanitize(parsed), corrupted: false };
  } catch {
    return { states: { ...DEFAULT_PANES }, corrupted: true };
  }
}

export function savePaneStates(key: string, states: PaneStates) {
  try { localStorage.setItem(key, JSON.stringify(states)); } catch { /* приватный режим */ }
}

interface PaneControlsProps {
  paneId: PaneId;
  state: PaneState;
  onChange: (paneId: PaneId, patch: Partial<PaneState>) => void;
  /** Открепить панель можно не всегда: например, у пустой панели нечего показывать. */
  canDetach?: boolean;
}

/** Кнопки управления панелью в её шапке: свернуть, развернуть, открепить. */
export function PaneControls({ paneId, state, onChange, canDetach = true }: PaneControlsProps) {
  const { t } = useLanguage();
  const btn = 'p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-40';
  const detached = state.mode === 'window';
  const full = state.mode === 'full';
  return (
    // data-pane-id нужен и для стилизации, и для проверок: по нему панель
    // опознаётся однозначно, а не по порядку кнопок на странице.
    <span data-pane-id={paneId} className="ml-auto flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => onChange(paneId, { collapsed: !state.collapsed })}
        title={state.collapsed ? t('main.pane.expand') : t('main.pane.collapse')}
        aria-label={state.collapsed ? t('main.pane.expand') : t('main.pane.collapse')}
        className={btn}
      >
        {state.collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
      </button>
      <button
        onClick={() => onChange(paneId, { mode: full ? 'grid' : 'full', collapsed: false })}
        title={full ? t('main.pane.unfull') : t('main.pane.full')}
        aria-label={full ? t('main.pane.unfull') : t('main.pane.full')}
        className={btn}
      >
        {full ? <Shrink className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
      <button
        onClick={() => onChange(paneId, { mode: detached ? 'grid' : 'window', collapsed: false, win: detached ? state.win ?? { ...DEFAULT_WINDOW } : { ...DEFAULT_WINDOW } })}
        title={detached ? t('main.pane.dock') : t('main.pane.detach')}
        aria-label={detached ? t('main.pane.dock') : t('main.pane.detach')}
        disabled={!canDetach}
        className={btn}
      >
        {detached ? <LayoutPanelTop className="w-3.5 h-3.5" /> : <ExternalLink className="w-3.5 h-3.5" />}
      </button>
    </span>
  );
}

interface FloatingPaneProps {
  paneId: PaneId;
  title: string;
  state: PaneState;
  onChange: (paneId: PaneId, patch: Partial<PaneState>) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onFocus: () => void;
  children: React.ReactNode;
}

/**
 * Открепленная панель: перетаскиваемое окно с рамкой, сворачиванием,
 * разворачиванием и кнопкой «вернуть в рабочую область».
 */
export function FloatingPane({ paneId, title, state, onChange, containerRef, onFocus, children }: FloatingPaneProps) {
  const { t } = useLanguage();
  const win = state.win ?? DEFAULT_WINDOW;
  const dock = () => onChange(paneId, { mode: 'grid' });
  return (
    <WindowFrame
      windowState={{
        id: paneId,
        title,
        isDetached: true,
        isMinimized: win.minimized,
        isMaximized: win.maximized,
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
        zIndex: win.z,
      }}
      icon={<LayoutPanelTop className="w-4 h-4 text-blue-500" />}
      isActive
      containerRef={containerRef}
      onFocus={onFocus}
      onMinimize={() => onChange(paneId, { win: { ...win, minimized: true, maximized: false } })}
      onToggleMaximize={() => onChange(paneId, { win: { ...win, minimized: false, maximized: !win.maximized } })}
      onDock={dock}
      onUpdateBounds={(b) => onChange(paneId, { win: { ...win, ...b } })}
      badge={<span className="text-[10px]">{t('main.pane.detached')}</span>}
    >
      {win.minimized ? null : <div className="h-full min-h-0 flex flex-col">{children}</div>}
    </WindowFrame>
  );
}