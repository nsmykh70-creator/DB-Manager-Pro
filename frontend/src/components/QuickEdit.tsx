import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, X } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Быстрое редактирование значения поля во всплывающем окне.
 *
 * Зачем: длинные значения (имена колонок, выражения DEFAULT, EXTRA) неудобно
 * править в узкой ячейке таблицы — текст обрезается, а растягивать колонку
 * нельзя. Здесь значение остаётся в ячейке, а по клику рядом с ним появляется
 * окно с нормальным полем ввода и кнопками «Применить»/«Отмена».
 *
 * Особенности, которые важны:
 *  - окно переносится в document.body: внутри таблицы его обрезали бы
 *    прокручиваемые контейнеры (overflow-auto), а ещё оно должно быть выше
 *    модальных окон создания и изменения колонки;
 *  - позиция считается от ячейки и переворачивается вверх, если снизу не хватает
 *    места, а по горизонтали прижимается к краю окна;
 *  - Enter применяет, Escape отменяет, клик снаружи закрывает без изменений.
 */

export type QuickEditKind = 'text' | 'multiline' | 'number' | 'select' | 'boolean';

export interface QuickEditProps {
  /** Текущее значение: показывается в ячейке и попадает в поле ввода. */
  value: string | number | boolean;
  /** Тип редактора: строка, многострочное поле, число, список или переключатель. */
  kind?: QuickEditKind;
  /** Варианты для kind='select'. */
  options?: string[];
  /** Название поля — показывается в заголовке окна. */
  label?: string;
  /** Подсказка под полем: формат значения, ограничения СУБД. */
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Моноширинный шрифт: имя колонки, тип, SQL-выражение. */
  mono?: boolean;
  /** Значение, которое показывается, когда строка пустая. */
  emptyLabel?: string;
  /** Что подставлять в поле ввода, когда в ячейке пусто (например, текущая длина). */
  fallback?: string;
  onSave: (value: string | number | boolean) => void;
}

const POPOVER_WIDTH = 288;
const GAP = 6;

function display(value: QuickEditProps['value'], emptyLabel: string, mono: boolean | undefined): string {
  if (typeof value === 'boolean') return value ? '✓' : '—';
  const text = String(value ?? '');
  if (!text) return emptyLabel;
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
}

export function QuickEdit({
  value,
  kind = 'text',
  options,
  label,
  hint,
  placeholder,
  disabled,
  mono,
  emptyLabel = '—',
  fallback,
  onSave
}: QuickEditProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  const isEmpty = typeof value === 'string' && value === '';
  const shown = isEmpty && fallback !== undefined && kind === 'number' ? fallback : display(value, emptyLabel, mono);

  const openPopover = useCallback(() => {
    if (disabled) return;
    // В окно попадает фактическое значение, а не то, что показано в ячейке:
    // иначе пустая ячейка с подсказкой превратилась бы в текст подсказки.
    const text = typeof value === 'boolean' ? String(value) : isEmpty && fallback !== undefined ? fallback : String(value ?? '');
    setDraft(text);
    setOpen(true);
  }, [disabled, value, isEmpty, fallback]);

  const close = useCallback(() => setOpen(false), []);

  const apply = useCallback(() => {
    if (kind === 'boolean') {
      onSave(draft === 'true');
    } else if (kind === 'number') {
      const parsed = Number(draft);
      // Пустое числовое поле не превращаем в NaN: теряется исходное значение.
      onSave(draft.trim() === '' ? '' : (Number.isNaN(parsed) ? draft : parsed));
    } else {
      onSave(draft);
    }
    setOpen(false);
  }, [draft, kind, onSave]);

  // Позиция окна: считаем от ячейки, переворачиваем вверх при нехватке места
  // снизу и прижимаем по горизонтали, чтобы не вылезти за экран.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = pop.offsetHeight || 150;
      const below = window.innerHeight - rect.bottom - GAP;
      const above = rect.top - GAP;
      const flip = below < height && above > below;
      const top = flip ? Math.max(GAP, rect.top - height - GAP) : rect.bottom + GAP;
      const maxLeft = Math.max(GAP, window.innerWidth - POPOVER_WIDTH - GAP);
      const left = Math.min(Math.max(GAP, rect.left), maxLeft);
      pop.style.top = `${Math.round(top)}px`;
      pop.style.left = `${Math.round(left)}px`;
    };
    place();
    const input = inputRef.current;
    if (input && typeof input.focus === 'function') input.focus();
    if (input && 'select' in input && typeof input.select === 'function') (input as HTMLInputElement).select();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Клик снаружи и Escape закрывают окно без применения.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
      if (event.key === 'Enter' && !event.shiftKey && kind !== 'multiline') {
        event.preventDefault();
        apply();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, apply, kind]);

  const cell = (
    <span
      ref={anchorRef}
      className={`group/qe relative inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-left ${
        disabled
          ? 'cursor-default text-gray-400 dark:text-gray-600'
          : 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/25'
      } ${mono ? 'font-mono' : ''}`}
      onClick={openPopover}
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      onKeyDown={event => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPopover();
        }
      }}
      title={disabled ? undefined : t('quickEdit.open')}
    >
      <span className={`truncate ${isEmpty ? 'text-gray-300 dark:text-gray-600 italic' : ''}`}>{shown}</span>
      {!disabled && (
        // Карандаш виден всегда, а не только при наведении: иначе о его
        // существовании нельзя догадаться, пока не подведёшь курсор ко всем
        // подряд. Постоянно он приглушён, при наведении становится заметнее.
        <Pencil
          className="w-3 h-3 shrink-0 text-blue-500/60 transition-colors group-hover/qe:text-blue-500"
          aria-hidden
        />
      )}
    </span>
  );

  if (typeof document === 'undefined') return cell;

  return (
    <>
      {cell}
      {open &&
        createPortal(
          <div
            ref={popRef}
            style={{ zIndex: 55 }}
            // Цвет текста задан здесь обязательно: поповер выносится порталом в
            // document.body, то есть ВНЕ оболочки приложения, где в тёмной теме
            // задан светлый цвет. Без своего цвета поля наследовали чёрный от
            // <body> и оказывались нечитаемыми на тёмном фоне.
            className="fixed w-[288px] rounded-lg border border-gray-200 bg-white text-gray-900 shadow-xl dark:border-gray-700 dark:bg-[#1e2330] dark:text-gray-100"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <span className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
              <button
                type="button"
                onClick={close}
                title={t('quickEdit.cancel')}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-2 p-3">
              {kind === 'boolean' && (
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft === 'true'}
                    onChange={event => setDraft(String(event.target.checked))}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  {t('quickEdit.booleanLabel')}
                </label>
              )}
              {kind === 'select' && (
                <select
                  ref={node => { inputRef.current = node; }}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  {(options ?? []).map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              )}
              {kind === 'multiline' && (
                <textarea
                  ref={node => { inputRef.current = node; }}
                  value={draft}
                  placeholder={placeholder}
                  onChange={event => setDraft(event.target.value)}
                  rows={4}
                  spellCheck={false}
                  className={`w-full resize-y rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 ${mono ? 'font-mono' : ''}`}
                />
              )}
              {(kind === 'text' || kind === 'number') && (
                <input
                  ref={node => { inputRef.current = node; }}
                  type={kind === 'number' ? 'number' : 'text'}
                  value={draft}
                  placeholder={placeholder}
                  onChange={event => setDraft(event.target.value)}
                  spellCheck={false}
                  className={`w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 ${mono ? 'font-mono' : ''}`}
                />
              )}
              {hint && <p className="text-[11px] leading-snug text-gray-400 dark:text-gray-500">{hint}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
              <button
                type="button"
                onClick={close}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {t('quickEdit.cancel')}
              </button>
              <button
                type="button"
                onClick={apply}
                className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
              >
                <Check className="w-3 h-3" />
                {t('quickEdit.apply')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
/**
 * Значение с возможностью вызвать существующий редактор.
 *
 * Для уже существующих колонок правка меняет схему базы, поэтому её нельзя
 * делать мини-полем: нужен предпросмотр SQL, выбор диалекта и подтверждение.
 * Здесь значение остаётся текстом, а по клику открывается тот же модальный
 * редактор колонки, что и у кнопки с карандашом в строке.
 */
export interface QuickOpenProps {
  value: string;
  label?: string;
  mono?: boolean;
  /**
   * Действие недоступно (например, нет прав на изменение схемы). Значок при этом
   * не показывается: раньше он выглядел кликабельным, а клик молча ничего не
   * делал — выглядело как поломка интерфейса.
   */
  disabled?: boolean;
  onOpen: () => void;
}

export function QuickOpen({ value, label, mono, disabled, onOpen }: QuickOpenProps) {
  const { t } = useLanguage();
  const empty = !value || value === '-';
  if (disabled) {
    return (
      <span className={`inline-flex max-w-full items-center px-1.5 py-0.5 ${mono ? 'font-mono' : ''}`}>
        <span className={`truncate ${empty ? 'text-gray-300 dark:text-gray-600 italic' : ''}`}>{empty ? '—' : value}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label ? `${label}: ${t('quickEdit.open')}` : t('quickEdit.open')}
      className={`group/qo inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-left hover:bg-blue-50 dark:hover:bg-blue-900/25 ${mono ? 'font-mono' : ''}`}
    >
      <span className={`truncate ${empty ? 'text-gray-300 dark:text-gray-600 italic' : ''}`}>{empty ? '—' : value}</span>
      <Pencil
        className="w-3 h-3 shrink-0 text-blue-500/60 transition-colors group-hover/qo:text-blue-500"
        aria-hidden
      />
    </button>
  );
}
