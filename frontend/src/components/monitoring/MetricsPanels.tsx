import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Cpu, Server, Network, Database } from 'lucide-react';
import type { ChartPoint, ServerMetrics } from '../../hooks/useServerMetrics';
import { formatBytes } from '../../hooks/useServerMetrics';
import { useLanguage } from '../../contexts/LanguageContext';
import { useFormatters } from '../../intl';

/**
 * Панели мониторинга. Каждая панель получает уже опрошенные данные: опросом
 * занимается хук на экране, иначе шесть панелей шл�� бы по шесть одинаковых
 * запросов каждые десять секунд.
 */

export function MetricsPanel({ system, server, qps }: ServerMetrics) {
  const { t } = useLanguage();
  const { num } = useFormatters();
  const cpuLoad = system?.cpuLoad ?? 0;
  const ramUsed = system?.ramUsed ?? 0;
  const ramTotal = system?.ramTotal ?? 0;
  const ramPercent = ramTotal > 0 ? Math.min(100, (ramUsed / ramTotal) * 100) : 0;
  const connections = server?.connections ?? 0;
  const queries = server?.queries ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 h-full">
      <Tile label={t('monitoring.cpuLoad')} icon={<Cpu className="w-4 h-4" />} value={`${cpuLoad}%`} bar={cpuLoad} barColor="bg-blue-500" />
      <Tile
        label={t('monitoring.ram')}
        icon={<Server className="w-4 h-4" />}
        value={`${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}`}
        bar={ramPercent}
        barColor="bg-purple-500"
      />
      <Tile
        label={t('monitoring.queriesQps')}
        icon={<Database className="w-4 h-4" />}
        value={num(qps)}
        hint={t('monitoring.queriesHint', { total: num(queries), slow: server?.slowQueries ?? 0 })}
      />
      <Tile
        label={t('monitoring.connections')}
        icon={<Network className="w-4 h-4" />}
        value={String(connections)}
        hint={t('monitoring.processesHint', { count: server?.processlist?.length ?? 0 })}
      />
    </div>
  );
}

function Tile({
  label, icon, value, hint, bar, barColor = 'bg-blue-500'
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  hint?: string;
  bar?: number;
  barColor?: string;
}) {
  return (
    <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
        <span className="text-xs font-medium">{label}</span>{icon}
      </div>
      <div className="text-xl font-bold text-gray-900 dark:text-white truncate">{value}</div>
      {typeof bar === 'number' && (
        <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-1.5 mt-1">
          <div className={`${barColor} h-1.5 rounded-full`} style={{ width: `${bar}%` }} />
        </div>
      )}
      {hint && <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{hint}</div>}
    </div>
  );
}

export function LoadChartPanel({ cpuData }: { cpuData: ChartPoint[] }) {
  return (
    <div className="h-full min-h-[160px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={cpuData}>
          <defs>
            <linearGradient id="colorLoad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#374151" opacity={0.3} />
          <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#f3f4f6', borderRadius: '8px' }}
            itemStyle={{ color: '#60a5fa' }}
          />
          <Area type="monotone" dataKey="load" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorLoad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function QueryChartPanel({ queryData }: { queryData: ChartPoint[] }) {
  return (
    <div className="h-full min-h-[160px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={queryData}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#374151" opacity={0.3} />
          <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#f3f4f6', borderRadius: '8px' }}
            itemStyle={{ color: '#10b981' }}
          />
          <Line type="monotone" dataKey="qps" stroke="#10b981" strokeWidth={2} dot={{ r: 3, fill: '#10b981', strokeWidth: 0 }} activeDot={{ r: 5 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
