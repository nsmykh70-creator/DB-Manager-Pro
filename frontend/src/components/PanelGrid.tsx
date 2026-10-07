import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, GripVertical, LayoutPanelTop, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import {
  BASE_WINDOW_Z,
  PANEL_OVERLAY_Z,
  focusLayerZ,
  raiseWindow,
  windowZOf,
  type GridRect,
  type PanelPlacement,
  type WindowZOrder
} from '../core/panelLayout';
import { GRID_GAP, ROW_HEIGHT, columnWidth, effectiveHeight, gridToPixels } from '../core/panelLayout';
import type { PanelWorkspace } from '../core/panels';
import { panelById, panelsFor } from '../core/panels';
import { usePanelLayout } from '../hooks/usePanelLayout';
import { useLanguage } from '../contexts/LanguageContext';
import { WindowFrame } from './WindowFrame';
import type { AppWindowState } from '../types';

/** Состояние откреплённой панели: окно со свободными границами. */
type WindowPlacement = Extract<PanelPlacement, { mode: 'window' }>;

/**
 * Сетка панелей: перетаскивание, изменение размера и сворачивание, как в Grafana.
 *
 * Перетаскивание и resize идут на Pointer Events, а движение ограничено
 * requestAnimationFrame: события указателя приходят чаще, чем кадры, и без
 * ограничения панель дёргалась бы при десяти панелях на экране.
 *
 * Область намеренно узкая: только прикреплённые панели. Открепление в окно
 * переезжает сюда в следующей фазе вместе с переносом состояния окон из
 * MainContent в хранилище — до этого кнопка открепления была бы обещанием,
 * за которым стояла бы заглушка.
 */

export interface PanelGridProps {
  workspace: PanelWorkspace;
  /** Контент панели по её идентификатору. */
  panels: Partial<Record<string, () => React.ReactNode>>;
  /** Кто смотрит: компоновка не переезжает между пользователями. */
  userKey: string;
  addToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  className?: string;
}

type DragMode = {
  kind: 'move' | 'resize';
  id: string;
  edge?: string;
  startX: number;
  startY: number;
  origin: GridRect;
};

const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

const RESIZE_CLASS: Record<string, string> = {
  n: 'top-0 left-2 right-2 h-1 cursor-n-resize',
  s: 'bottom-0 left-2 right-2 h-1 cursor-s-resize',
  e: 'right-0 top-2 bottom-2 w-1 cursor-e-resize',
  w: 'left-0 top-2 bottom-2 w-1 cursor-w-resize',
  ne: 'top-0 right-0 w-2 h-2 cursor-ne-resize',
  nw: 'top-0 left-0 w-2 h-2 cursor-nw-resize',
  se: 'bottom-0 right-0 w-2 h-2 cursor-se-resize',
  sw: 'bottom-0 left-0 w-2 h-2 cursor-sw-resize'
};

function cursorFor(edge?: string): string {
  switch (edge) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'nwse-resize';
  }
}

/** Прямоугольник после смещения указателя, в единицах сетки. */
export function nextRect(mode: DragMode, dx: number, dy: number, unitX: number, unitY: number): GridRect {
  const origin = mode.origin;
  if (mode.kind === 'move') {
    return { ...origin, x: origin.x + Math.round(dx / unitX), y: origin.y + Math.round(dy / unitY) };
  }
  const rect: GridRect = { ...origin };
  const edge = mode.edge ?? '';
  if (edge.includes('e')) rect.w = origin.w + Math.round(dx / unitX);
  if (edge.includes('s')) rect.h = origin.h + Math.round(dy / unitY);
  if (edge.includes('w')) {
    // Тянем за левый край: панель растёт влево, поэтому x тоже меняется.
    const w = origin.w - Math.round(dx / unitX);
    rect.x = origin.x + (origin.w - w);
    rect.w = w;
  }
  if (edge.includes('n')) {
    const h = origin.h - Math.round(dy / unitY);
    rect.y = origin.y + (origin.h - h);
    rect.h = h;
  }
  return rect;
}

export function PanelGrid({ workspace, panels, userKey, addToast, className }: PanelGridProps) {
  const { t } = useLanguage();
  // Сетка управляет только теми панелями, для которых экран дал содержимое:
  // пустая рамка без содержимого выглядела бы поломкой интерфейса.
  const available = useMemo(() => Object.keys(panels).filter(id => panels[id]), [panels]);
  const {
    layout, issues, dispatch, reset, detach, dock, dockAll, toggleCollapse,
    canDetach, canCollapse, containerWidth, containerHeight, visibleRows,
    registerContainer, registerParent
  } = usePanelLayout(workspace, userKey, available);

  const [preview, setPreview] = useState<{ id: string; rect: GridRect } | null>(null);
  // Фокусная панель живёт в отдельном слое поверх сетки, а не среди соседей.
  // Раньше она была обычным элементом списка с z-классом, и её положение
  // зависело от порядка панелей и от того, перекрывается ли она соседями по
  // координатам: фокус менялся, а панель оставалась на втором плане. Отдельный
  // слой с явным z-index снимает эту зависимость целиком.
  const [focused, setFocused] = useState<string | null>(null);
  const inFocusMode = Boolean(focused);
  // В фокусе сетка занимает ровно видимую область: полоса вкладок плюс панель.
  // Считаем по строкам, которые реально помещаются, — иначе панель высотой во
  // всю раскладку уходила под обрез родителя и выглядела спрятанной.
  const surfaceHeight = inFocusMode
    ? Math.max(ROW_HEIGHT + GRID_GAP, visibleRows * (ROW_HEIGHT + GRID_GAP) - GRID_GAP)
    : containerHeight;

  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  // У каждого окна СВОЙ z-index, и активация поднимает именно его: общий
  // счётчик обновлял бы z у всех окон разом, и активное окно осталось бы под
  // остальными. Логика вынесена в panelLayout.ts, чтобы её можно было проверить.
  const zRef = useRef(BASE_WINDOW_Z);
  const [windowZ, setWindowZ] = useState<WindowZOrder>({});
  const frameRef = useRef(0);
  const dragRef = useRef<DragMode | null>(null);

  const colW = columnWidth(containerWidth);
  const unitX = colW + GRID_GAP;
  const unitY = ROW_HEIGHT + GRID_GAP;

  const known = useMemo(() => new Set(available), [available]);

  const beginDrag = useCallback((mode: DragMode) => {
    dragRef.current = mode;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = mode.kind === 'move' ? 'grabbing' : cursorFor(mode.edge);

    const onMove = (event: PointerEvent) => {
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const current = dragRef.current;
        if (!current) return;
        setPreview({ id: current.id, rect: nextRect(current, event.clientX - current.startX, event.clientY - current.startY, unitX, unitY) });
      });
    };
    const onUp = (event: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0; }
      const current = dragRef.current;
      dragRef.current = null;
      if (!current) return;
      const rect = nextRect(current, event.clientX - current.startX, event.clientY - current.startY, unitX, unitY);
      setPreview(null);
      const same = rect.x === current.origin.x && rect.y === current.origin.y
        && rect.w === current.origin.w && rect.h === current.origin.h;
      if (same) return;
      dispatch(current.kind === 'move'
        ? { type: 'move', id: current.id, x: rect.x, y: rect.y }
        : { type: 'resize', id: current.id, w: rect.w, h: rect.h });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [dispatch, unitX, unitY]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  /** Панель на весь экран сетки и обратно. */
  const toggleFocus = useCallback((id: string) => {
    setFocused(current => (current === id ? null : id));
  }, []);

  /**
   * Управление с клавиатуры: стрелки двигают панель, Shift со стрелками меняет
   * размер, Escape снимает фокус. Без этого панель можно было бы только мышью,
   * а перестановка мышью — операция, которую трудно сделать точно.
   */
  const onPanelKey = useCallback((event: React.KeyboardEvent, id: string, rect: GridRect) => {
    const step = event.shiftKey ? 1 : 2;
    const move = (x: number, y: number) => dispatch({ type: 'move', id, x, y });
    const size = (w: number, h: number) => dispatch({ type: 'resize', id, w, h });
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        if (event.shiftKey) size(Math.max(1, rect.w - step), rect.h); else move(rect.x - step, rect.y);
        break;
      case 'ArrowRight':
        if (event.shiftKey) size(rect.w + step, rect.h); else move(rect.x + step, rect.y);
        break;
      case 'ArrowUp':
        if (event.shiftKey) size(rect.w, Math.max(1, rect.h - step)); else move(rect.x, Math.max(0, rect.y - step));
        break;
      case 'ArrowDown':
        if (event.shiftKey) size(rect.w, rect.h + step); else move(rect.x, rect.y + step);
        break;
      case 'Escape':
        setFocused(null);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }, [dispatch]);

  const { detached, docked } = useMemo(() => {
    const dockedEntries: { id: string; rect: GridRect; collapsed: boolean }[] = [];
    const detachedEntries: { id: string; placement: WindowPlacement }[] = [];
    for (const [id, placement] of Object.entries(layout)) {
      if (!known.has(id)) continue;
      if (placement.mode === 'grid') {
        dockedEntries.push({
          id,
          rect: { x: placement.x, y: placement.y, w: placement.w, h: effectiveHeight(placement) },
          collapsed: placement.collapsed
        });
      } else {
        detachedEntries.push({ id, placement });
      }
    }
    return { detached: detachedEntries, docked: dockedEntries };
  }, [known, layout]);

  // Панель в фокусе рисуется отдельным слоем, поэтому в общем списке её нет.
  const focusedPanel = useMemo(
    () => (focused ? docked.find(item => item.id === focused) ?? null : null),
    [docked, focused]
  );

  const focusWindow = useCallback((id: string) => {
    setActiveWindow(id);
    // Поднимается только это окно, а не все сразу: если бы z обновлялся у всех,
    // порядок не менялся бы вовсе.
    zRef.current += 1;
    const next = zRef.current;
    setWindowZ(prev => raiseWindow(prev, id, next));
  }, []);

  // Окна рисуются поверх сетки, поэтому им нужна вся область панелей, а не
  // только видимая часть: иначе развёрнутое окно обрезалось бы по высоте.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const bindSurface = useCallback((node: HTMLDivElement | null) => {
    surfaceRef.current = node;
  }, []);

  // Слой окон выносится в портал к body: все контейнеры вокруг сетки имеют
  // overflow-hidden, поэтому внутри них окно обрезалось бы ровно по краям
  // рабочей области и не могло выйти поверх боковых панелей. В body таких
  // ограничений нет, а положение окон пересчитывается в координаты экрана.
  const [surfaceOffset, setSurfaceOffset] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSurfaceOffset(prev =>
        Math.abs(prev.left - rect.left) < 0.5 && Math.abs(prev.top - rect.top) < 0.5
          ? prev
          : { left: rect.left, top: rect.top }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      window.addEventListener('scroll', measure, true);
      return () => {
        window.removeEventListener('resize', measure);
        window.removeEventListener('scroll', measure, true);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', measure, true);
    };
  }, []);

  // Слой окон остаётся в дереве компонентов и позиционируется как fixed.
  // Портал в body тут не нужен и ломал приложение: StrictMode вызывает эффекты
  // дважды, контейнер портала удалялся и создавался заново, и React пытался
  // удалить узел из уже отсоединённого контейнера — NotFoundError
  // «the node to be removed is not a child of this node», приложение падало.
  // Причина ошибки в пересоздании контейнера, а не в document.body.
  //
  // Почему fixed внутри дерева не обрезается: overflow: hidden у предков
  // обрезает только потомков в потоке, а position: fixed позиционируется
  // относительно экрана. Прямых предков с transform/filter/contain, которые
  // ломали бы fixed, здесь нет.
  // Окно в слое позиционируется в координатах экрана, а хранится в
  // координатах рабочей области: пересчитываем в обе стороны, иначе окно
  // уезжало бы на размеры сайдбаров при каждом открытии.
  const toScreenX = useCallback((x: number) => x + surfaceOffset.left, [surfaceOffset.left]);
  const toScreenY = useCallback((y: number) => y + surfaceOffset.top, [surfaceOffset.top]);
  const toLocalX = useCallback((x: number) => x - surfaceOffset.left, [surfaceOffset.left]);
  const toLocalY = useCallback((y: number) => y - surfaceOffset.top, [surfaceOffset.top]);

  // Ширина контейнера нужна сетке для перевода единиц в пиксели. Раньше
  // registerContainer вообще не вешали ни на один узел, поэтому ширина оставалась
  // равной стартовым 1200px: при сворачивании сайдбаров панели не растягивались,
  // а пустое место справа оставалось пустым. Узел измерения — тот же слой сетки,
  // который и рисует панели, иначе ширина слоя и ширина измерения разойдутся.
  const bindGridSurface = useCallback((node: HTMLDivElement | null) => {
    bindSurface(node);
    registerContainer(node);
  }, [bindSurface, registerContainer]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {focused ? t('main.panels.focusHint') : t('main.panels.hint')}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="hidden md:inline text-[11px] text-gray-500 dark:text-gray-400">{t('main.panels.keyboardHint')}</span>
          {detached.length > 0 && (
            <button
              onClick={dockAll}
              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {t('main.panels.dockAll')} ({detached.length})
            </button>
          )}
          <button
            onClick={() => { reset(); addToast?.(t('main.panels.resetDone'), 'success'); }}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> {t('main.panels.reset')}
          </button>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="mb-2 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700 rounded p-2">
          {issues.join('; ')}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div ref={registerParent} className="h-full overflow-auto">
          <div ref={bindGridSurface} className="relative w-full" style={{ height: surfaceHeight }}>
            {docked.map(item => {
          const panel = panelById(item.id);
          if (!panel) return null;
          // Фокусная панель рисуется отдельным слоем ниже, здесь её пропускаем,
          // иначе она была бы дважды.
          if (focused === item.id) return null;
          const asChip = inFocusMode;
          const stripCount = Math.max(1, docked.length - 1);
          const chipW = Math.max(3, Math.floor(24 / stripCount));
          const chipIndex = docked.findIndex(other => other.id === item.id);
          const rect = asChip
            ? { x: Math.min(23, chipIndex * chipW), y: 0, w: chipW, h: 1 }
            : (preview && preview.id === item.id ? preview.rect : item.rect);
          const pixels = gridToPixels(rect, containerWidth);
          const render = panels[item.id];
          return (
            <section
              key={item.id}
              data-panel={item.id}
              className={`absolute flex flex-col overflow-hidden rounded-lg border bg-white dark:bg-[#1a1f2b] shadow-sm ${
                asChip ? 'border-gray-300 dark:border-gray-700' : 'border-gray-200 dark:border-gray-800'
              }`}
              style={{ left: pixels.x, top: pixels.y, width: pixels.width, height: pixels.height }}
            >
              <header
                onPointerDown={event => {
                  // В режиме фокуса перетаскивание бессмысленно: панель занимает
                  // всё поле, а её соседи свернуты в полоску.
                  if (asChip) return;
                  if (event.button !== 0) return;
                  if ((event.target as HTMLElement).closest('button')) return;
                  beginDrag({ kind: 'move', id: item.id, startX: event.clientX, startY: event.clientY, origin: rect });
                }}
                onDoubleClick={() => toggleFocus(item.id)}
                onClick={asChip ? () => toggleFocus(item.id) : undefined}
                onKeyDown={event => onPanelKey(event, item.id, rect)}
                tabIndex={0}
                role="group"
                aria-label={t(panel.titleKey)}
                className={`h-8 shrink-0 flex items-center gap-1.5 px-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-800 select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  asChip ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
                }`}
              >
                {!asChip && <GripVertical className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0" />}
                <span className="text-xs font-medium truncate">{t(panel.titleKey)}</span>
                {asChip ? (
                  <span className="ml-auto text-[11px] text-gray-400 dark:text-gray-500">{t('main.panels.chipHint')}</span>
                ) : (
                  <span className="ml-auto flex items-center gap-0.5">
                    {canCollapse(item.id) && (
                      <button
                        onClick={() => toggleCollapse(item.id)}
                        title={item.collapsed ? t('main.panels.expand') : t('main.panels.collapse')}
                        className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        {item.collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    <button
                      onClick={() => toggleFocus(item.id)}
                      title={t('main.panels.focus')}
                      className="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                    {canDetach(item.id) && (
                      <button
                        onClick={() => { detach(item.id); focusWindow(item.id); }}
                        title={t('main.panels.detach')}
                        className="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </span>
                )}
              </header>
              {!item.collapsed && !asChip && (
                <>
                  <div className="flex-1 min-h-0 overflow-auto">{render ? render() : null}</div>
                  {RESIZE_EDGES.map(edge => (
                    <div
                      key={edge}
                      onPointerDown={event => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        beginDrag({ kind: 'resize', id: item.id, edge, startX: event.clientX, startY: event.clientY, origin: rect });
                      }}
                      className={`absolute z-10 ${RESIZE_CLASS[edge]}`}
                    />
                  ))}
                </>
              )}
            </section>
          );
        })}
          </div>
        </div>

      </div>

      {/* Слой окон и фокусной панели. fixed внутри дерева не обрезается
          overflow: hidden предков, поэтому портал не нужен, а пересоздание
          его контейнера в StrictMode роняло приложение. */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: PANEL_OVERLAY_Z }}>
        <div className="absolute inset-0 pointer-events-none">
          {detached.map(item => {
            const panel = panelById(item.id);
            if (!panel) return null;
            const render = panels[item.id];
            return (
              <WindowFrame
                key={`win-${item.id}`}
                windowState={{
                  id: item.id,
                  title: t(panel.titleKey),
                  isDetached: true,
                  isMinimized: item.placement.minimized,
                  isMaximized: item.placement.maximized,
                  x: toScreenX(item.placement.x),
                  y: toScreenY(item.placement.y),
                  width: item.placement.width,
                  height: item.placement.height,
                  prevBounds: item.placement.prevBounds,
                  zIndex: windowZOf(windowZ, item.id)
                }}
                icon={<LayoutPanelTop className="w-4 h-4 text-blue-500" />}
                isActive={activeWindow === item.id}
                onFocus={() => focusWindow(item.id)}
                onMinimize={() => dispatch({ type: 'windowMinimize', id: item.id })}
                onToggleMaximize={() => dispatch({ type: 'windowToggleMaximize', id: item.id })}
                onDock={() => dock(item.id)}
                onUpdateBounds={bounds => dispatch({
                  type: 'windowBounds',
                  id: item.id,
                  bounds: {
                    // Окно отдаёт координаты экрана, а хранилище ждёт координаты
                    // рабочей области: без пересчёта окно съезжало бы на ширину
                    // сайдбаров при каждом движении мыши.
                    ...(bounds.x !== undefined ? { x: toLocalX(bounds.x) } : {}),
                    ...(bounds.y !== undefined ? { y: toLocalY(bounds.y) } : {}),
                    ...(bounds.width !== undefined ? { width: bounds.width } : {}),
                    ...(bounds.height !== undefined ? { height: bounds.height } : {})
                  }
                })}
                containerRef={surfaceRef}
              >
                {render ? render() : null}
              </WindowFrame>
            );
          })}
        </div>

        {/* Слой фокусной панели. Три условия, без которых она оказывалась не
            сверху, и все три проверены:
            1) это отдельный слой, а не элемент списка панелей — иначе её положение
               зависело от порядка панелей и от перекрытия координатами;
            2) z-index задаётся числом ВЫШЕ всех откреплённых окон — иначе её
               перекрывало бы развёрнутое окно;
            3) сама панель начинается НИЖЕ полосы вкладок (top), а не с нуля —
               раньше её шапка накрывала полосу, и переключать панели было
               нечем. */}
        {focusedPanel && (
          // Слой не должен перехватывать клики: он накрывает всю область, и без
          // pointer-events-none полоса вкладок под ним стала бы недоступной —
          // переключить панель было бы нечем. Содержимое слой не перехватывает.
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: focusLayerZ(windowZ) }}>
            <section
              className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-blue-400 dark:border-blue-600 bg-white dark:bg-[#1a1f2b] shadow-lg"
              style={{
                // В портале координаты экранные, поэтому положение и размер
                // берём от области сетки, а не от ноля: иначе фокусная панель
                // уехала бы в угол окна мимо панелей.
                left: surfaceOffset.left,
                top: surfaceOffset.top + ROW_HEIGHT + GRID_GAP,
                width: containerWidth,
                height: Math.max(ROW_HEIGHT, surfaceHeight - (ROW_HEIGHT + GRID_GAP))
              }}
            >
              <header
                onDoubleClick={() => setFocused(null)}
                onKeyDown={event => {
                  // В фокусе стрелки не двигают панель: она занимает всё поле, и
                  // перестановка в раскладке была бы невидимым эффектом.
                  if (event.key === 'Escape') { setFocused(null); event.preventDefault(); }
                }}
                tabIndex={0}
                role="group"
                aria-label={t(panelById(focusedPanel.id)?.titleKey ?? focusedPanel.id)}
                className="h-8 shrink-0 flex items-center gap-1.5 px-2 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800 cursor-default select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <span className="text-xs font-medium truncate">{t(panelById(focusedPanel.id)?.titleKey ?? focusedPanel.id)}</span>
                <span className="ml-auto flex items-center gap-0.5">
                  <button
                    onClick={() => setFocused(null)}
                    title={t('main.panels.unfocus')}
                    className="p-1 text-gray-500 dark:text-gray-400 hover:text-blue-700 dark:hover:text-blue-300"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                  </button>
                  {canDetach(focusedPanel.id) && (
                    <button
                          onClick={() => {
                            const id = focusedPanel.id;
                            setFocused(null);
                            detach(id);
                            focusWindow(id);
                          }}
                      title={t('main.panels.detach')}
                      className="p-1 text-gray-500 dark:text-gray-400 hover:text-blue-700 dark:hover:text-blue-300"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </span>
              </header>
              <div className="flex-1 min-h-0 overflow-auto">
                {panels[focusedPanel.id] ? panels[focusedPanel.id]!() : null}
              </div>
            </section>
          </div>
        )}
        </div>
    </div>
  );
}
