import { useLanguage } from './contexts/LanguageContext';

/**
 * Форматирование чисел и дат по языку интерфейса.
 *
 * Раньше вызовы шли с фиксированной локалью `toLocaleString('ru-RU')` — число
 * или дата выводились по-русски даже в английском интерфейсе, и языки
 * пересекались прямо на экране. Здесь локаль берётся из выбранного языка.
 */
const LOCALE_TAGS: Record<string, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  zh: 'zh-CN'
};

export function localeTag(lang: string): string {
  return LOCALE_TAGS[lang] ?? 'en-US';
}

export function formatNumber(value: number, lang: string): string {
  return value.toLocaleString(localeTag(lang));
}

export function formatDateTime(value: number | string | Date, lang: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(localeTag(lang));
}

export function formatTime(value: number | string | Date, lang: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(localeTag(lang), { hour: '2-digit', minute: '2-digit' });
}

/** Готовые форматтеры, привязанные к текущему языку: удобно в компонентах,
 * где-language уже доступен через useLanguage. */
export function useFormatters() {
  const { lang } = useLanguage();
  return {
    lang,
    num: (value: number) => formatNumber(value, lang),
    dateTime: (value: number | string | Date) => formatDateTime(value, lang),
    time: (value: number | string | Date) => formatTime(value, lang)
  };
}