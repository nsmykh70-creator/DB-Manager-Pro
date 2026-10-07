import React from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { ServerMetrics } from '../../hooks/useServerMetrics';
import { formatBytes } from '../../hooks/useServerMetrics';

/** Активные процессы и размеры баз — то, чего в мониторинге раньше не было. */
export function ProcessesPanel({ server, serverId, canKill, onKilled }: {
  server: ServerMetrics['server'];
  serverId: string;
  canKill: boolean;
  onKilled: (pid: string) => void;
}) {
  const { t } = useLanguage();
  const list = server?.processlist ?? [];
  return (
    <div className="h-full overflow-auto">
      {list.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400 p-2">{t('main.panels.processesEmpty')}</p>
      ) : (
        <table className="w-full text-xs text-left">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-2 py-1 font-medium">PID</th>
              <th className="px-2 py-1 font-medium">{t('ui.user')}</th>
              <th className="px-2 py-1 font-medium">{t('monitoring.command')}</th>
              <th className="px-2 py-1 font-medium">{t('ui.time')}</th>
              {canKill && <th className="px-2 py-1" />}
            </tr>
          </thead>
          <tbody>
            {list.map(proc => (
              <tr key={proc.id} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-2 py-1 font-mono">{proc.id}</td>
                <td className="px-2 py-1">{proc.user ?? '—'}</td>
                <td className="px-2 py-1 font-mono truncate max-w-[320px]" title={proc.query ?? proc.command ?? ''}>
                  {proc.query || proc.command || proc.state || '—'}
                </td>
                <td className="px-2 py-1">{proc.timeSec ?? 0} {t('monitoring.secondsShort')}</td>
                {canKill && (
                  <td className="px-2 py-1 text-right">
                    <button
                      onClick={() => onKilled(proc.id)}
                      className="text-red-600 dark:text-red-400 hover:underline"
                    >
                      {t('right.kill')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!canKill && list.length > 0 && (
        <p className="text-[11px] text-gray-400 p-2">{t('right.killAdminOnly')}</p>
      )}
      <span className="hidden">{serverId}</span>
    </div>
  );
}

export function DbSizesPanel({ server }: { server: ServerMetrics['server'] }) {
  const { t } = useLanguage();
  const sizes = server?.dbSizes ?? [];
  const total = sizes.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  return (
    <div className="h-full overflow-auto p-2 space-y-1.5">
      {sizes.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('main.panels.sizesUnavailable')}</p>
      ) : (
        <>
          {sizes.map(item => {
            const share = total > 0 ? ((item.bytes ?? 0) / total) * 100 : 0;
            return (
              <div key={item.db}>
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate">{item.db}</span>
                  <span className="text-gray-500 dark:text-gray-400 shrink-0">{formatBytes(item.bytes ?? 0)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
                  <div className="h-1.5 bg-emerald-500" style={{ width: `${share}%` }} />
                </div>
              </div>
            );
          })}
          <div className="text-[11px] text-gray-500 dark:text-gray-400 pt-1">{t('monitoring.total')}: {formatBytes(total)}</div>
        </>
      )}
    </div>
  );
}
