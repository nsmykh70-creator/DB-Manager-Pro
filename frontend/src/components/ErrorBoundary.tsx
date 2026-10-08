import React from 'react';
import { translate, type Language } from '../contexts/LanguageContext';

/** Язык из localStorage (как в api.ts): классовый компонент хука не видит. */
function currentLang(): Language {
  const stored = localStorage.getItem('mydbroot_lang');
  return (stored === 'en' || stored === 'de' || stored === 'fr' || stored === 'es' || stored === 'zh' ? stored : 'ru') as Language;
}

/**
 * Ловит краши рендера дочернего дерева (например, после серии 401/502
 * подряд состояние может прийти в вид, который роняет React) и показывает
 * заглушку вместо белого экрана. Сброс — по смене resetKey или кнопке.
 */
interface Props {
  resetKey: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const t = (key: string) => translate(currentLang(), key);
      return (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <div className="max-w-sm rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e2330] shadow-xl p-6">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('app.crashTitle')}
            </p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 break-all">
              {this.state.error.message}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-2 text-sm font-medium text-white transition-colors"
            >
              {t('app.crashRetry')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
