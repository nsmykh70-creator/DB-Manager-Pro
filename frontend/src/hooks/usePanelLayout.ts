import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelLayout } from '../core/panelLayout';
import { GRID_GAP, ROW_HEIGHT, usedRows } from '../core/panelLayout';
import type { PanelWorkspace } from '../core/panels';
import { panelAllowed } from '../core/panelStore';
import {
  PanelAction,
  PanelStoreState,
  applyAction,
  loadLayout,
  saveLayout
} from '../core/panelStore';

/**
 * React-обёртка над хранилищем раскладки.
 *
 * Вся математика и работа с localStorage живут в core/panelStore и проверяются
 * скриптом без браузера. Здесь только состояние, запись в хранилище и измерение
 * ширины контейнера.
 */

export interface UsePanelLayoutResult {
  layout: PanelLayout;
  /** Проблемы, найденные при чтении компоновки (показать один раз). */
  issues: string[];
  dispatch: (action: PanelAction) => void;
  reset: () => void;
  detach: (id: string) => void;
  dock: (id: string) => void;
  dockAll: () => void;
  toggleCollapse: (id: string) => void;
  canDetach: (id: string) => boolean;
  canCollapse: (id: string) => boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  containerWidth: number;
  /** Сколько строк сетки реально помещается в видимую область. */
  visibleRows: number;
  /** Высота рабочей области по содержимому (может быть больше видимой). */
  containerHeight: number;
  registerContainer: (node: HTMLDivElement | null) => void;
  /** Родитель сетки: по нему измеряется доступная высота. */
  registerParent: (node: HTMLDivElement | null) => void;
}

export function usePanelLayout(workspace: PanelWorkspace, userKey: string, available: string[]): UsePanelLayoutResult {
  const availableKey = useMemo(() => [...available].sort().join(','), [available]);
  const availableIds = useMemo(() => availableKey ? availableKey.split(',') : [], [availableKey]);
  const [state, setState] = useState<PanelStoreState>(() => loadLayout({ userKey, workspace, available: availableIds }));
  const [containerWidth, setContainerWidth] = useState(1200);
  const [availableHeight, setAvailableHeight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerNode = useRef<HTMLDivElement | null>(null);
  const parentNode = useRef<HTMLDivElement | null>(null);

  // Смена пользователя, рабочей области или набора панелей = другая компоновка
  useEffect(() => {
    setState(loadLayout({ userKey, workspace, available: availableIds }));
  }, [userKey, workspace, availableKey]);

  const registerContainer = useCallback((node: HTMLDivElement | null) => {
    containerNode.current = node;
    containerRef.current = node;
  }, []);

  const registerParent = useCallback((node: HTMLDivElement | null) => {
    parentNode.current = node;
  }, []);

  // Доступная высота важна не для красоты: вся цепочка контейнеров панели имеет
  // overflow-hidden, поэтому сетка выше экрана не «достаётся» прокруткой сама —
  // её обрезало бы, и панели выглядели бы спрятанными под соседями. Видимые
  // строки считаем от реальной высоты области, а не от числа строк раскладки.
  useEffect(() => {
    const node = parentNode.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      const height = node?.getBoundingClientRect().height;
      if (height) setAvailableHeight(height);
      return;
    }
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height;
      if (height && Math.abs(height - availableHeight) > 1) setAvailableHeight(height);
    });
    observer.observe(node);
    setAvailableHeight(node.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [availableHeight]);

  // Ширина контейнера нужна для перевода единиц сетки в пиксели. Без
  // ResizeObserver панели не перестраивались бы при изменении размера окна.
  useEffect(() => {
    const node = containerNode.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      const width = node?.getBoundingClientRect().width;
      if (width) setContainerWidth(width);
      return;
    }
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width && Math.abs(width - containerWidth) > 1) setContainerWidth(width);
    });
    observer.observe(node);
    setContainerWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [containerWidth]);

  const dispatch = useCallback((action: PanelAction) => {
    setState(prev => {
      const next = applyAction(prev, action, containerWidth, availableIds);
      saveLayout({ userKey, workspace, available: availableIds }, next.layout);
      return next;
    });
  }, [availableIds, containerWidth, userKey, workspace]);

  const rows = useMemo(() => Math.max(1, usedRows(state.layout)), [state.layout]);
  const containerHeight = rows * (ROW_HEIGHT + GRID_GAP) - GRID_GAP;
  const visibleRows = useMemo(() => {
    if (!availableHeight) return rows;
    return Math.max(1, Math.floor((availableHeight + GRID_GAP) / (ROW_HEIGHT + GRID_GAP)));
  }, [availableHeight, rows]);

  return {
    layout: state.layout,
    issues: state.issues,
    dispatch,
    reset: () => dispatch({ type: 'reset' }),
    detach: (id: string) => dispatch({ type: 'detach', id, containerWidth }),
    dock: (id: string) => dispatch({ type: 'dock', id }),
    dockAll: () => dispatch({ type: 'dockAll' }),
    toggleCollapse: (id: string) => dispatch({ type: 'toggleCollapse', id }),
    canDetach: (id: string) => panelAllowed(id, 'detach'),
    canCollapse: (id: string) => panelAllowed(id, 'collapse'),
    containerRef,
    containerWidth,
    visibleRows,
    containerHeight,
    registerContainer,
    registerParent
  };
}
