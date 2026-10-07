import React, { useState } from 'react';
import { Activity, RefreshCcw } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { useServerMetrics } from '../hooks/useServerMetrics';
import { api, PanelUser } from '../api';
import { PanelGrid } from './PanelGrid';
import { LoadChartPanel, MetricsPanel, QueryChartPanel } from './monitoring/MetricsPanels';
import { DbSizesPanel, ProcessesPanel } from './monitoring/ServerPanels';

/**
 * Мониторинг на той же сетке, что и рабочая область.
 *
 * Опрос метрик вынесен в хук: панели получают готовые данные, поэтому шесть
 * панелей на экране не превращаются в шесть одинаковых запросов каждые десять
 * секунд. Компоновка мониторинга хранится отдельно от рабочей области — набор
 * панелей другой, и смешивать их в одну раскладку незачем.
 */
export function MonitoringGrid({ connId, userRole, connectionReadOnly, userName }: {
  connId?: string | null;
  userRole?: PanelUser['role'];
  connectionReadOnly?: boolean;
  /** Имя пользователя: компоновка панелей личная, а не общая для всех роли. */
  userName?: string;
}) {
  const { t } = useLanguage();
  const metrics = useServerMetrics(connId);
  const [killing, setKilling] = useState(false);
  const canKill = userRole === 'admin' && !connectionReadOnly;

  if (!connId) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">{t('main.selectConn')}</div>;
  }

  const statusLabel = metrics.error ? t('monitoring.apiError') : metrics.loading ? t('monitoring.updating') : t('monitoring.online');
  const statusClass = metrics.error
    ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50'
    : 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800/50';

  const kill = async (pid: string) => {
    if (!canKill || killing) return;
    if (!confirm(t('right.killConfirm', { id: pid }))) return;
    setKilling(true);
    try {
      await api.killQuery(connId, String(pid));
      metrics.retry();
    } catch (e: any) {
      window.alert(t('right.killFailed') + ': ' + e.message);
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#151923] overflow-y-auto animate-in fade-in p-4 md:p-6">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="text-xl font-bold flex items-center gap-3 text-gray-900 dark:text-white">
          <Activity className="w-5 h-5 text-blue-500" />
          {t('main.monitoring')}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={metrics.retry}
            title={t('main.refreshNow')}
            className="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-1"
          >
            <RefreshCcw className="w-3.5 h-3.5" />
          </button>
          <span className={`flex items-center gap-2 text-xs px-3 py-1 rounded-full border ${statusClass}`}>
            <span className={`w-2 h-2 rounded-full ${metrics.error ? 'bg-red-500' : 'bg-green-500'}`} />
            {statusLabel}
          </span>
        </div>
      </div>

      {metrics.error && (
        <div className="mb-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
          <div>
            <div>{metrics.error}</div>
            {metrics.retryHint && <div className="mt-0.5 opacity-80">{metrics.retryHint}</div>}
          </div>
          <button onClick={metrics.retry} className="shrink-0 px-2 py-1 rounded border border-red-300 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40">
            {t('main.retryNow')}
          </button>
        </div>
      )}

      <PanelGrid
        workspace="monitoring"
        userKey={userName || (userRole ? `role-${userRole}` : 'anonymous')}
        panels={{
          metrics: () => <MetricsPanel {...metrics} />,
          loadChart: () => <LoadChartPanel cpuData={metrics.cpuData} />,
          queryChart: () => <QueryChartPanel queryData={metrics.queryData} />,
          processes: () => (
            <ProcessesPanel
              server={metrics.server}
              serverId={connId}
              canKill={canKill}
              onKilled={pid => void kill(String(pid))}
            />
          ),
          dbSizes: () => <DbSizesPanel server={metrics.server} />
        }}
      />
    </div>
  );
}
