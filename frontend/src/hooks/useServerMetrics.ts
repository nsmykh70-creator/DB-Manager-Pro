import { useEffect, useRef, useState } from 'react';
import { api, ServerStatus, SystemStatus } from '../api';
import { formatTime } from '../intl';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Опрос метрик сервера. Вынесен из Monitoring, потому что набор панелей
 * мониторинга теперь общий с рабочей областью, а опрашивать сервер должна одна
 * штука на экран, а не каждая панель.
 *
 * Логика недоступного сервера перенесена без изменений: 10 секунд, потом
 * 20/40/… до 5 минут, 404 (подключение удалили) — опрос прекращаем, успех
 * сбрасывает паузу, кнопка «Повторить» тоже.
 */

export interface ChartPoint {
  time: string;
  load?: number;
  qps?: number;
}

export interface ServerMetrics {
  system: SystemStatus | null;
  server: ServerStatus | null;
  cpuData: ChartPoint[];
  queryData: ChartPoint[];
  qps: number;
  loading: boolean;
  error: string;
  retryHint: string;
  retry: () => void;
}

// Локаль приходит параметром: функция объявлена вне компонента, и глобальная
// переменная языка здесь была бы той самой жёсткой привязкой, которую убрали.
function nowLabel(lang: string): string {
  return formatTime(new Date(), lang);
}

export function useServerMetrics(connId?: string | null): ServerMetrics {
  // Язык интерфейса: подписи осей на графиках должны быть в нём же, а не
  // по-русски при любом выборе.
  const { lang } = useLanguage();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [cpuData, setCpuData] = useState<ChartPoint[]>([]);
  const [queryData, setQueryData] = useState<ChartPoint[]>([]);
  const [qps, setQps] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryHint, setRetryHint] = useState('');
  const previousQueries = useRef<{ at: number; value: number } | null>(null);
  const retryNonce = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!connId) {
      setSystem(null);
      setServer(null);
      setCpuData([]);
      setQueryData([]);
      setQps(0);
      previousQueries.current = null;
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const gone = { current: false };
    const delay = () => Math.min(300_000, 10_000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
    const schedule = () => {
      if (!cancelled && !gone.current) timer = window.setTimeout(load, delay());
    };
    const load = async () => {
      setLoading(true);
      try {
        const [nextSystem, nextServer] = await Promise.all([
          api.systemStatus(),
          api.serverStatus(connId),
        ]);
        if (cancelled) return;
        failures = 0;
        setSystem(nextSystem);
        setServer(nextServer);
        setError('');
        setRetryHint('');
        const now = Date.now();
        const previous = previousQueries.current;
        const currentQueries = nextServer.queries ?? 0;
        const nextQps = previous && currentQueries >= previous.value
          ? Math.max(0, Math.round((currentQueries - previous.value) / Math.max(1, (now - previous.at) / 1000)))
          : 0;
        previousQueries.current = { at: now, value: currentQueries };
        setQps(nextQps);
        const point = { time: nowLabel(lang), load: nextSystem.cpuLoad, qps: nextQps };
        setCpuData(prev => [...prev.slice(-19), point]);
        setQueryData(prev => [...prev.slice(-19), point]);
      } catch (e: any) {
        if (cancelled) return;
        gone.current = e?.status === 404;
        failures += 1;
        setError(e.message || 'Не удалось загрузить мониторинг');
        setRetryHint(gone.current
          ? 'Подключение удалено в другой вкладке — выберите другое'
          : delay() > 10_000 ? `Повтор через ${Math.round(delay() / 1000)} с (сервер недоступен)` : '');
      } finally {
        if (!cancelled) setLoading(false);
        schedule();
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [connId, retryTick]);

  return {
    system,
    server,
    cpuData,
    queryData,
    qps,
    loading,
    error,
    retryHint,
    retry: () => { retryNonce.current += 1; setRetryTick(retryNonce.current); }
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1073741824).toFixed(2)} GiB`;
}
