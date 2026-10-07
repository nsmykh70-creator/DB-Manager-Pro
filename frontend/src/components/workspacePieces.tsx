import React from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { PaneControls, type PaneId, type PaneState } from './PaneControls';

/**
 * Мелкие части рабочей области: свёрнутая панель, вертикальная граница и
 * заглушка правой панели. Отдельный файл, потому что в `MainContent` их
 * растворяло среди разметки вкладок, а поведением у них ничего общего.
 */

/**
 * Свёрнутая панель: остаётся только шапка с кнопками. Содержимое не
 * рисуется вовсе, а не прячется через hidden, — иначе тяжёлые таблицы
 * продолжали бы перерисовываться впустую.
 */
export function CollapsedPane({ paneId, title, onChange, canDetach }: {
  paneId: PaneId; title: string;
  onChange: (id: PaneId, patch: Partial<PaneState>) => void;
  canDetach: boolean;
}) {
  return (
    <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 rounded-t-lg min-w-0">
      <span className="text-xs font-medium truncate">{title}</span>
      <PaneControls paneId={paneId} state={{ mode: 'grid', collapsed: true }} onChange={onChange} canDetach={canDetach} />
    </div>
  );
}

/**
 * Вертикальная граница между колонками. Вынесена отдельной компонентой,
 * потому что в сетке 2×2 она нужна дважды — в верхней и нижней строках, —
 * и обе половины обязаны тянуть одну и ту же долю ширины: иначе колонки
 * разъезжаются и «столбцы» перестают быть столбцами.
 */
export function VerticalSplit({ onStart, label }: {
  onStart: (type: 'side-split', e: React.MouseEvent) => void;
  label: string;
}) {
  return (
    <div
      onMouseDown={(e) => onStart('side-split', e)}
      className="w-2.5 shrink-0 bg-gray-200/60 hover:bg-blue-400/80 active:bg-blue-600 dark:bg-gray-800 dark:hover:bg-blue-500 cursor-col-resize flex items-center justify-center transition-colors group select-none z-10"
      title={label}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-split="side"
    >
      <div className="h-8 w-1 rounded bg-gray-400 dark:bg-gray-500 group-hover:bg-white" />
    </div>
  );
}

/** Правая верхняя панель до выбора таблицы: место не пустует, но и не врёт. */
export function EmptyTablePanel() {
  const { t } = useLanguage();
  return (
    <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center p-6 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-white/40 dark:bg-white/[0.02]">
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm">{t('main.pickTableToEdit')}</p>
    </div>
  );
}