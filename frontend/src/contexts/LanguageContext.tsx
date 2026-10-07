import React, { createContext, useContext, useState, ReactNode } from 'react';
import { translations } from '../locales';

export type Language = 'ru' | 'en' | 'de' | 'fr' | 'es' | 'zh';

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const LANGS: readonly string[] = ['ru', 'en', 'de', 'fr', 'es', 'zh'];
const LANG_KEY = 'mydbroot_lang';

// Выбранный язык запоминаем: по умолчанию английский, но переключение не
// должно слетать при каждой перезагрузке — иначе русский или немецкий
// приходилось бы выбирать заново каждый раз.
function initialLang(): Language {
  try {
    const saved = window.localStorage.getItem(LANG_KEY);
    if (saved && LANGS.includes(saved)) return saved as Language;
  } catch {
    // localStorage бывает недоступен (приватный режим, запрет хранилища) —
    // тогда просто остаётся язык по умолчанию.
  }
  return 'en';
}

/** Перевод по конкретному языку — для кода вне компонентов.
 *
 * Хук `t()` берёт язык из контекста, но вспомогательные функции вроде
 * timeAgo() объявлены на уровне модуля и хука не видят. Без этого приходилось
 * либо оставлять русские строки, либо передавать язык вручную по всей цепочке
 * вызовов. */
export function translate(lang: Language, key: string, vars?: Record<string, string | number>): string {
  const keys = key.split('.');
  let value: any = translations[lang];
  for (const k of keys) {
    if (value && value[k]) {
      value = value[k];
    } else {
      return key; // fallback
    }
  }
  if (typeof value !== 'string') return key;
  if (!vars) return value;
  // Подстановка {placeholder} — чтобы счётчики и имена не приходилось
  // склеивать вручную в компонентах
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Английский по умолчанию: интерфейс должен читаться без догадок о языке
  // пользователя. Русский выбирается из меню языка.
  const [lang, setLangState] = useState<Language>(initialLang);

  const setLang = (next: Language) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Запомнить не удалось — выбор всё равно применяется в этой сессии.
    }
  };

  const t = (key: string, vars?: Record<string, string | number>): string => translate(lang, key, vars);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
};
