import React, { useRef, ReactNode, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ChevronDown, Pin } from 'lucide-react';
import { AppWindowState } from '../types';

interface WindowFrameProps {
  windowState: AppWindowState;
  icon: ReactNode;
  children: ReactNode;
  isActive: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onDock: () => void;
  onUpdateBounds: (bounds: Partial<AppWindowState>) => void;
  badge?: ReactNode;
}

export const WindowFrame: React.FC<WindowFrameProps> = ({
  windowState,
  icon,
  children,
  isActive,
  containerRef,
  onFocus,
  onMinimize,
  onToggleMaximize,
  onDock,
  onUpdateBounds,
  badge,
}) => {
  const { t } = useLanguage();
  const { isMaximized, isMinimized, x, y, width, height, zIndex, title } = windowState;
  const isDraggingRef = useRef(false);
  const isResizingRef = useRef<string | null>(null);
  const dragDataRef = useRef({
    startX: 0,
    startY: 0,
    winX: 0,
    winY: 0,
    winW: 0,
    winH: 0,
  });

  // Windows 11 double click or drag handler
  const handleTitleBarMouseDown = (e: React.MouseEvent) => {
    // Only left click, and ignore clicks on buttons or controls
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onFocus();

    if (isMaximized) {
      return;
    }

    isDraggingRef.current = true;
    dragDataRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: x,
      winY: y,
      winW: width,
      winH: height,
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      moveEvent.preventDefault();

      const dx = moveEvent.clientX - dragDataRef.current.startX;
      const dy = moveEvent.clientY - dragDataRef.current.startY;

      // Allow dragging freely across the entire viewport (over left sidebar, right sidebar, header)
      const screenW = window.innerWidth;
      const screenH = window.innerHeight;

      // Keep at least 60px of the title bar visible on screen so it can never be lost
      const targetX = Math.max(-dragDataRef.current.winW + 80, Math.min(screenW - 80, dragDataRef.current.winX + dx));
      const targetY = Math.max(0, Math.min(screenH - 40, dragDataRef.current.winY + dy));

      onUpdateBounds({ x: targetX, y: targetY });
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: false });
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 8-Direction Resizing
  const handleResizeMouseDown = (direction: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus();

    if (isMaximized) return;

    isResizingRef.current = direction;
    dragDataRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: x,
      winY: y,
      winW: width,
      winH: height,
    };

    document.body.style.userSelect = 'none';
    const cursorMap: Record<string, string> = {
      n: 'n-resize',
      s: 's-resize',
      e: 'e-resize',
      w: 'w-resize',
      ne: 'ne-resize',
      nw: 'nw-resize',
      se: 'se-resize',
      sw: 'sw-resize',
    };
    document.body.style.cursor = cursorMap[direction] || 'se-resize';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      moveEvent.preventDefault();

      const dx = moveEvent.clientX - dragDataRef.current.startX;
      const dy = moveEvent.clientY - dragDataRef.current.startY;

      const screenW = window.innerWidth;
      const screenH = window.innerHeight;

      let newW = dragDataRef.current.winW;
      let newH = dragDataRef.current.winH;
      let newX = dragDataRef.current.winX;
      let newY = dragDataRef.current.winY;

      // Handle horizontal sizing
      if (direction.includes('e')) {
        newW = Math.max(340, Math.min(screenW - dragDataRef.current.winX, dragDataRef.current.winW + dx));
      } else if (direction.includes('w')) {
        const potentialW = dragDataRef.current.winW - dx;
        if (potentialW >= 340) {
          newW = potentialW;
          newX = dragDataRef.current.winX + dx;
        }
      }

      // Handle vertical sizing
      if (direction.includes('s')) {
        newH = Math.max(200, Math.min(screenH - dragDataRef.current.winY, dragDataRef.current.winH + dy));
      } else if (direction.includes('n')) {
        const potentialH = dragDataRef.current.winH - dy;
        if (potentialH >= 200) {
          newH = potentialH;
          newY = Math.max(0, dragDataRef.current.winY + dy);
        }
      }

      onUpdateBounds({ x: newX, y: newY, width: newW, height: newH });
    };

    const handleMouseUp = () => {
      isResizingRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: false });
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  if (isMinimized) {
    return null;
  }

  return (
    <div
      onMouseDown={onFocus}
      style={{
        zIndex,
        ...(isMaximized
          ? {
              top: '4px',
              left: '4px',
              right: '4px',
              bottom: '48px',
              width: 'auto',
              height: 'auto',
            }
          : {
              top: `${y}px`,
              left: `${x}px`,
              width: `${width}px`,
              height: `${height}px`,
            }),
      }}
      className={`pointer-events-auto absolute flex flex-col transition-shadow duration-150 overflow-hidden ${
        isMaximized ? 'rounded-md' : 'rounded-xl'
      } ${
        isActive
          ? 'shadow-[0_20px_50px_rgba(0,0,0,0.3)] dark:shadow-[0_24px_70px_rgba(0,0,0,0.8)] ring-1 ring-blue-500/50 border border-black/20 dark:border-white/20'
          : 'shadow-[0_12px_36px_rgba(0,0,0,0.18)] dark:shadow-[0_16px_45px_rgba(0,0,0,0.6)] border border-black/10 dark:border-white/10 opacity-98'
      } bg-[#f9f9f9]/95 dark:bg-[#202020]/95 backdrop-blur-xl`}
    >
      {/* Windows 11 Title Bar */}
      <div
        onMouseDown={handleTitleBarMouseDown}
        onDoubleClick={onToggleMaximize}
        className={`h-[36px] flex items-center justify-between cursor-move select-none shrink-0 border-b transition-colors ${
          isActive
            ? 'bg-[#f3f3f3]/90 dark:bg-[#2a2a2a]/90 border-black/[0.08] dark:border-white/[0.08] text-gray-900 dark:text-gray-100'
            : 'bg-[#fafafa]/80 dark:bg-[#1f1f1f]/80 border-black/[0.05] dark:border-white/[0.05] text-gray-500 dark:text-gray-400'
        }`}
      >
        {/* Left: Window Icon & Title (Segoe UI style) */}
        <div className="flex items-center gap-2 pl-3 min-w-0 pr-2 pointer-events-none">
          <span className="shrink-0 scale-90 text-blue-600 dark:text-blue-400">
            {icon}
          </span>
          <span className="text-[12px] font-normal tracking-tight truncate font-sans">
            {title}
          </span>
          {badge && <div className="shrink-0">{badge}</div>}
        </div>

        {/* Right: Caption Buttons (Windows 11 Style) */}
        <div className="flex items-center h-full">
          {/* Orange Chevron / Dock Button to return window into panel */}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDock();
            }}
            title={t('window.dockBack')}
            className="h-[36px] px-2.5 flex items-center gap-1 text-orange-600 dark:text-orange-400 hover:bg-orange-500/15 active:bg-orange-500/25 transition-colors text-[11px] font-medium"
          >
            <ChevronDown className="w-3.5 h-3.5 stroke-[2.5]" />
            <span className="hidden sm:inline">{t('window.pin')}</span>
          </button>

          {/* Minimize Button */}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMinimize();
            }}
            title={t('window.collapse')}
            className="w-[46px] h-[36px] flex items-center justify-center text-gray-700 dark:text-gray-300 hover:bg-black/[0.07] dark:hover:bg-white/[0.08] active:bg-black/[0.12] transition-colors"
          >
            <svg width="10" height="1" viewBox="0 0 10 1" className="fill-current">
              <rect width="10" height="1" />
            </svg>
          </button>

          {/* Maximize / Restore Button (Windows 11 Snap Style) */}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize();
            }}
            title={isMaximized ? t('window.restore') : t('window.maximize')}
            className="w-[46px] h-[36px] flex items-center justify-center text-gray-700 dark:text-gray-300 hover:bg-black/[0.07] dark:hover:bg-white/[0.08] active:bg-black/[0.12] transition-colors"
          >
            {isMaximized ? (
              // Windows 11 Restore Icon (two overlapping squares)
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-current">
                <path d="M2.5 7.5H1.5C0.947715 7.5 0.5 7.05228 0.5 6.5V1.5C0.5 0.947715 0.947715 0.5 1.5 0.5H6.5C7.05228 0.5 7.5 0.947715 7.5 1.5V2.5" strokeWidth="1" />
                <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" strokeWidth="1" />
              </svg>
            ) : (
              // Windows 11 Maximize Icon (single square)
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-current">
                <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" strokeWidth="1" />
              </svg>
            )}
          </button>

          {/* Close / Dock Button (Windows 11 Red Hover Style) */}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDock();
            }}
            title={t('window.closeDock')}
            className="w-[46px] h-[36px] flex items-center justify-center text-gray-700 dark:text-gray-300 hover:bg-[#c42b1c] hover:text-white active:bg-[#a82315] active:text-white transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-current">
              <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Window Body (Content) */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white dark:bg-[#1a1f2c]">
        {children}
      </div>

      {/* 8-Directional Resize Handles (only when not maximized) */}
      {!isMaximized && (
        <>
          {/* Top edge */}
          <div
            onMouseDown={(e) => handleResizeMouseDown('n', e)}
            className="absolute top-0 left-2 right-2 h-1 cursor-n-resize z-40 hover:bg-blue-500/30"
          />
          {/* Bottom edge */}
          <div
            onMouseDown={(e) => handleResizeMouseDown('s', e)}
            className="absolute bottom-0 left-2 right-2 h-1.5 cursor-s-resize z-40 hover:bg-blue-500/30"
          />
          {/* Left edge */}
          <div
            onMouseDown={(e) => handleResizeMouseDown('w', e)}
            className="absolute top-2 bottom-2 left-0 w-1.5 cursor-w-resize z-40 hover:bg-blue-500/30"
          />
          {/* Right edge */}
          <div
            onMouseDown={(e) => handleResizeMouseDown('e', e)}
            className="absolute top-2 bottom-2 right-0 w-1.5 cursor-e-resize z-40 hover:bg-blue-500/30"
          />

          {/* Corners */}
          <div
            onMouseDown={(e) => handleResizeMouseDown('nw', e)}
            className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize z-50"
          />
          <div
            onMouseDown={(e) => handleResizeMouseDown('ne', e)}
            className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize z-50"
          />
          <div
            onMouseDown={(e) => handleResizeMouseDown('sw', e)}
            className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize z-50"
          />
          <div
            onMouseDown={(e) => handleResizeMouseDown('se', e)}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-50 flex items-end justify-end p-0.5"
          >
            <div className="w-1.5 h-1.5 border-r border-b border-gray-400 dark:border-gray-500" />
          </div>
        </>
      )}
    </div>
  );
};
