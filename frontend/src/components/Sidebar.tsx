import React, { useState, useRef, useEffect } from 'react';
import { 
  Database, Server, Settings, HelpCircle, ChevronDown, ChevronLeft, ChevronRight,
  Plus, Layers, Shield, Activity, HardDrive, Book, RefreshCw, Loader2, Wifi, WifiOff, Trash2, GripVertical
} from 'lucide-react';
import { DocsModal } from './modals/DocsModal';
import { useLanguage } from '../contexts/LanguageContext';
import { api, ConnectionInfo } from '../api';
import { isKindEnabled, KIND_LABELS } from '../engineKinds';
import { dbOrderStore, dbRowKey, type DbOrder } from '../core/dbOrder';
import { kindOrderStore, KIND_GROUP } from '../core/kindOrder';
import { moveKey, moveKeyBy, sortRows } from '../core/orderStore';

const KIND_ICONS: Record<string, React.ReactNode> = {
  mysql: <Database className="w-5 h-5 text-blue-500" />,
  mariadb: <Server className="w-5 h-5 text-teal-500" />,
  postgresql: <Database className="w-5 h-5 text-indigo-500" />,
  postgres: <Database className="w-5 h-5 text-indigo-500" />,
  sqlite: <HardDrive className="w-5 h-5 text-blue-400" />,
  mongodb: <Layers className="w-5 h-5 text-green-500" />,
  redis: <Server className="w-5 h-5 text-red-500" />,
  oracle: <Database className="w-5 h-5 text-orange-500" />,
};

const SUPPORTED_KINDS = ['mysql', 'mariadb', 'postgresql', 'sqlite', 'mongodb', 'redis', 'oracle'] as const;

const KIND_COLORS: Record<string, string> = {
  mysql: 'text-blue-500',
  mariadb: 'text-teal-500',
  postgresql: 'text-indigo-500',
  postgres: 'text-indigo-500',
  sqlite: 'text-blue-400',
  mongodb: 'text-green-500',
  redis: 'text-red-500',
  oracle: 'text-orange-500',
};

// Системные БД: корзина скрыта, удаление блокируется и на бэкенде.
// Их потеря ломает сервер (пример: DROP DATABASE mysql).
const SYSTEM_DBS: Record<string, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mariadb: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgres: ['postgres', 'template0', 'template1'],
  postgresql: ['postgres', 'template0', 'template1'],
  mongodb: ['admin', 'local', 'config'],
  sqlite: [],
  redis: [],
  // У Oracle «база» = схема = пользователь подключения, и служебных схем в
  // этом списке быть не может: панель показывает только схему подключения.
  oracle: [],
};

function isSystemDb(kind: string, db: string): boolean {
  return (SYSTEM_DBS[kind] || []).includes(db.toLowerCase());
}

interface SidebarProps {
  projectName: string;
  activeDb: string;
  setActiveDb: (db: string) => void;
  openSettings: (tab?: string) => void;
  addToast: (msg: string, type: 'success'|'error'|'info') => void;
  activeView: 'databases' | 'monitoring';
  setActiveView: (view: 'databases' | 'monitoring') => void;
  openCreateDb: (type?: string) => void;
  openCreateConnection: () => void;
  onEditConnection?: (connection: ConnectionInfo) => void;
  onDeleteConnection?: (connection: ConnectionInfo) => void;
  connections: ConnectionInfo[];
  /** Типы СУБД, показываемые в панели. Пустой массив или отсутствие поля = все. */
  enabledKinds?: string[];
  activeConnId: string | null;
  setActiveConnId: (id: string) => void;
  databasesByConn: Record<string, string[]>;
  loadingConnections: boolean;
  refreshDatabases: () => void;
  refreshConnDatabases: (connId: string) => Promise<void>;
  onDbChange?: () => void;
  refreshConnections: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Логин пользователя: порядок баз хранится per-user и не должен переезжать. */
  userKey?: string;
}

export function Sidebar({ 
  projectName, activeDb, setActiveDb, openSettings, addToast, activeView, setActiveView, 
  openCreateDb, openCreateConnection, onEditConnection, onDeleteConnection, connections, enabledKinds, activeConnId, setActiveConnId, databasesByConn,
  loadingConnections, refreshDatabases, refreshConnDatabases, onDbChange, refreshConnections, isCollapsed = false, onToggleCollapse,
  userKey = ''
}: SidebarProps) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showDocs, setShowDocs] = useState(false);
  // Список подключений сворачивается: он бывает длинным, а базы ниже нужны
  // не реже. Состояние помнится и по переключению базы, и по перезагрузке —
  // иначе разворот каждый раз пришлось бы повторять заново.
  const [connectionsOpen, setConnectionsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('sidebarConnectionsOpen') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidebarConnectionsOpen', connectionsOpen ? '1' : '0'); } catch { /* приватный режим */ }
  }, [connectionsOpen]);

// Порядок баз внутри группы типа и порядок самих групп: пользовательские,
  // хранятся per-user в двух независимых доменах.
  const [dbOrder, setDbOrder] = useState<DbOrder>({});
  const [kindOrder, setKindOrder] = useState<string[]>([]);
  // Что сейчас тянут и над чем — по одному набору на список. Два независимых
  // набора нужны, потому что базу нельзя бросить в другую категорию, а
  // категорию — внутрь базы, и общее состояние путало бы эти два случая.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [overPos, setOverPos] = useState<'before' | 'after'>('before');
  const [kindDrag, setKindDrag] = useState<string | null>(null);
  const [kindOver, setKindOver] = useState<string | null>(null);
  const [kindOverPos, setKindOverPos] = useState<'before' | 'after'>('before');
  // Строка или категория, на которые надо вернуть фокус после сдвига стрелкой.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [focusKind, setFocusKind] = useState<string | null>(null);

  React.useEffect(() => {
    const db = dbOrderStore.load(userKey);
    setDbOrder(db.order);
    if (db.corrupted) addToast(t('sidebar.orderReset'), 'error');
    const kinds = kindOrderStore.load(userKey);
    setKindOrder(kindOrderStore.flat(kinds.order));
    if (kinds.corrupted) addToast(t('sidebar.orderReset'), 'error');
    // Перечитываем только при смене пользователя: иначе первая перестановка
    // затирала бы порядок, который мы сами же и сохранили.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey]);

  React.useEffect(() => {
    if (!focusKey) return;
    const el = document.querySelector<HTMLElement>(`[data-db-key="${focusKey}"]`);
    el?.focus();
    setFocusKey(null);
  }, [dbOrder, focusKey]);

  React.useEffect(() => {
    if (!focusKind) return;
    const el = document.querySelector<HTMLElement>(`[data-kind-key="${focusKind}"]`);
    el?.focus();
    setFocusKind(null);
  }, [kindOrder, focusKind]);

  const stopDrag = () => { setDragKey(null); setDragGroup(null); setOverKey(null); };

  const stopKindDrag = () => { setKindDrag(null); setKindOver(null); };

  // Сбросить перетаскивание, если пользователь увёл курсор мимо списка: иначе
  // полупрозрачная строка и полоса вставки остались бы висеть навсегда.
  React.useEffect(() => {
    if (!dragKey && !kindDrag) return;
    const stop = () => { stopDrag(); stopKindDrag(); };
    window.addEventListener('dragend', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragend', stop);
      window.removeEventListener('drop', stop);
    };
  }, [dragKey, kindDrag]);

  /**
   * Перестановка внутри группы типа: базы разных типов не смешиваются.
   *
   * Базой для перестановки служит сохранённый порядок, а если его ещё нет —
   * текущий видимый список: иначе первое же перетаскивание (когда в хранилище
   * ничего не записано) искало бы оба ключа в пустом массиве и ничего не
   * сдвинуло.
   */
  const handleDrop = (kind: string, visibleKeys: string[], toKey: string, position: 'before' | 'after') => {
    if (!dragKey || !dragGroup || dragGroup !== kind || dragKey === toKey) {
      stopDrag();
      return;
    }
    const current = dbOrder[kind] ?? visibleKeys;
    const next = moveKey(current, dragKey, toKey, position);
    const updated = { ...dbOrder, [kind]: next };
    setDbOrder(updated);
    dbOrderStore.save(userKey, updated);
    stopDrag();
  };

  /**
   * Перестановка категорий СУБД. Базой служит сохранённый порядок, а если его
   * нет — текущий видимый список категорий (тот же приём, что у баз: иначе
   * первое перетаскивание искало бы ключи в пустом массиве).
   */
  const handleKindDrop = (visibleKinds: string[], toKind: string, position: 'before' | 'after') => {
    if (!kindDrag || kindDrag === toKind) {
      stopKindDrag();
      return;
    }
    const current = kindOrder.length ? kindOrder : visibleKinds;
    const next = moveKey(current, kindDrag, toKind, position);
    setKindOrder(next);
    kindOrderStore.save(userKey, { [KIND_GROUP]: next });
    stopKindDrag();
  };

  /** Вернуть порядок к тому, что по умолчанию: и категорий, и баз внутри них. */
  const resetOrder = () => {
    dbOrderStore.clear(userKey);
    kindOrderStore.clear(userKey);
    setDbOrder({});
    setKindOrder([]);
    addToast(t('sidebar.orderReset'), 'success');
  };

  /**
   * Перестановка стрелками — второй способ того же, что и мышь.
   *
   * Перестановка мышью недоступна с клавиатуры и наоборот, а список из двух
   * десятков строк переставляют в основном стрелками: так шаг ровный, а при
   * перетаскивании на 20-пиксельные строки легко промахнуться.
   */
  const handleKeyMove = (kind: string, visibleKeys: string[], key: string, delta: number) => {
    const current = dbOrder[kind] ?? visibleKeys;
    const next = moveKeyBy(current, key, delta);
    // На краю списка стрелка должна прокручивать панель, а не пропадать впустую.
    if (next === current) return false;
    const updated = { ...dbOrder, [kind]: next };
    setDbOrder(updated);
    dbOrderStore.save(userKey, updated);
    // Фокус возвращаем на переехавшую строку: иначе после перерисовки фокус
    // упал бы на body и пользователю пришлось бы начинать обход заново.
    setFocusKey(key);
    return true;
  };

  /** Перестановка категорий стрелками — то же, что handleKeyMove, но для типов. */
  const handleKindKeyMove = (visibleKinds: string[], kind: string, delta: number) => {
    const current = kindOrder.length ? kindOrder : visibleKinds;
    const next = moveKeyBy(current, kind, delta);
    if (next === current) return false;
    setKindOrder(next);
    kindOrderStore.save(userKey, { [KIND_GROUP]: next });
    setFocusKind(kind);
    return true;
  };

  const toggleExpand = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  // Все группы-категории раскрыты при первой загрузке
  const didInitExpand = useRef(false);
  React.useEffect(() => {
    if (connections.length > 0 && !didInitExpand.current) {
      didInitExpand.current = true;
      const all: Record<string, boolean> = {};
      SUPPORTED_KINDS.forEach(kind => { all[kind] = true; });
      connections.forEach(c => { all[c.kind] = true; });
      setExpanded(prev => ({ ...prev, ...all }));
    }
  }, [connections]);

  // Удаление базы: предпросмотр показывает, сколько таблиц в базе и как они
  // называются, — и только потом спрашивает подтверждение.
  const handleDeleteDatabase = async (connId: string, dbName: string) => {
    let preview: { tablesApprox: number; sample: string[] } | null = null;
    try {
      preview = await api.dropDatabasePreview(connId, dbName);
    } catch (e: any) {
      addToast(t('bulk.dropDbPreviewFailed', { msg: e.message }), 'error');
      return;
    }
    const tables = preview?.tablesApprox ?? 0;
    const sample = (preview?.sample ?? []).slice(0, 10);
    const lines = [
      t('bulk.dropDbTitle', { name: dbName }),
      t('bulk.dropDbTables', { n: tables }),
      sample.length ? t('bulk.dropDbSample', { list: sample.join(', ') + (tables > sample.length ? ', …' : '') }) : '',
      t('bulk.dropDbDataLost')
    ].filter(Boolean).join('\n');
    if (!confirm(lines)) return;
    try {
      const result = await api.deleteDatabase(connId, dbName);
      addToast(t('sidebar.dbDeleted', { name: dbName }), 'success');
      if (activeConnId === connId && activeDb === dbName) setActiveDb('');
      if ((result as any).connectionDeleted) {
        refreshConnections();
      }
    } catch (e: any) {
      addToast(t('sidebar.errorDropDb') + e.message, 'error');
    } finally {
      // Список категории перечитываем ВСЕГДА — иначе удалённая строка висит
      // stale и повторный клик даёт 500 "doesn't exist"
      await refreshConnDatabases(connId);
      if (activeConnId === connId) refreshDatabases();
      onDbChange?.();
    }
  };

  // Типы, выключенные в настройках, не показываем ни в группах, ни в списках.
  const visibleConnections = connections.filter(c => isKindEnabled(c.kind, enabledKinds));

  // Group connections by kind, keeping empty driver categories visible.
  const visibleKinds = SUPPORTED_KINDS.filter(kind => isKindEnabled(kind, enabledKinds));
  // Порядок категорий пользовательский: он накладывается поверх SUPPORTED_KINDS,
  // поэтому тип, добавленный позже и ещё не перемещённый, оказывается в конце.
  const orderedKinds = sortRows(visibleKinds, kind => kind, kindOrder);
  const connGroups: Record<string, ConnectionInfo[]> = Object.fromEntries(orderedKinds.map(kind => [kind, []]));
  visibleConnections.forEach(c => {
    const kind = c.kind === 'postgres' ? 'postgresql' : c.kind;
    if (!connGroups[kind]) connGroups[kind] = [];
    connGroups[kind].push(c);
  });

  // Названия типов берём из общего словаря engineKinds: своя копия здесь
// разошлась с ним на первом же новом типе — панель показывала «oracle».
const kindLabels = KIND_LABELS;

  // Collapsed
  if (isCollapsed) {
    return (
      <div className="w-16 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 flex flex-col h-screen text-sm overflow-hidden z-30 shrink-0 transition-all duration-200 select-none">
        <div className="p-2 border-b border-gray-200 dark:border-gray-800 flex flex-col items-center gap-2 shrink-0">
           <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm" title={projectName}>
            <Database className="w-5 h-5" />
          </div>
          <button onClick={onToggleCollapse} title={t('sidebar.expandSidebar')} className="p-1.5 rounded-md text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-2 flex flex-col items-center">
          <button onClick={() => openCreateConnection()} title={t('ui.newConnection')} className="w-9 h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center justify-center shadow-sm transition-colors">
            <Server className="w-4 h-4" />
          </button>
          <button onClick={() => openCreateDb()} title={t('sidebar.newDb')} className="w-9 h-9 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg flex items-center justify-center shadow-sm hover:scale-105 transition-all">
            <Plus className="w-4 h-4" />
          </button>
          <div className="w-6 h-px bg-gray-200 dark:bg-gray-800 my-1" />
          {visibleConnections.map(conn => (
            <button key={conn.id} onClick={() => { setActiveConnId(conn.id); setActiveView('databases'); }} title={`${conn.name} (${conn.kind})`} className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${activeConnId === conn.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>
              {KIND_ICONS[conn.kind] || <Database className="w-5 h-5" />}
            </button>
          ))}
        </div>
        <div className="p-1.5 border-t border-gray-200 dark:border-gray-800 shrink-0 space-y-1.5 flex flex-col items-center">
          <button onClick={() => setActiveView('monitoring')} title={t('sidebar.monitoring')} className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${activeView === 'monitoring' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500'}`}>
            <Activity className="w-4 h-4" />
          </button>
          <button onClick={() => openSettings('general')} title={t('sidebar.settings')} className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors">
            <Settings className="w-4 h-4" />
          </button>
        </div>
        <DocsModal isOpen={showDocs} onClose={() => setShowDocs(false)} />
      </div>
    );
  }

  // Expanded
  return (
    <div className="w-80 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex flex-col h-screen text-sm overflow-hidden z-30 shrink-0 transition-all duration-200">
      <div className="p-3.5 flex items-center justify-between border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm shrink-0">
            <Database className="w-5 h-5" />
          </div>
          <div className="truncate">
             <h1 className="font-bold text-gray-900 dark:text-white leading-tight truncate">{projectName}</h1>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{t('sidebar.title')}</p>
          </div>
        </div>
        {onToggleCollapse && (
          <button onClick={onToggleCollapse} title={t('sidebar.collapseSidebar')} className="p-1.5 rounded-md text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors shrink-0">
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center justify-between gap-2 mb-3 px-1 flex-wrap">
          <span className="font-semibold text-gray-600 dark:text-gray-300">{t('sidebar.databases')}</span>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={refreshDatabases} title={t('ui.refresh')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button title={t('ui.newConnection')} onClick={() => openCreateConnection()} className="px-2.5 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 transition-colors">
              <Server className="w-3.5 h-3.5" />{t('sidebar.connection')}</button>
            <button title={t('sidebar.newDb')} onClick={() => openCreateDb()} className="bg-emerald-700 hover:bg-emerald-800 text-white font-medium shadow-sm hover:shadow text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5 transition-all">
              <Plus className="w-3.5 h-3.5" />
              {t('sidebar.create')}
            </button>
          </div>
        </div>

        {loadingConnections ? (
          <div className="flex items-center justify-center p-8 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />{t('sidebar.loading')}</div>
        ) : visibleConnections.length === 0 ? (
          <div className="text-center p-6">
            <WifiOff className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('sidebar.noConnections')}</p>
            <button onClick={() => openCreateConnection()} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('sidebar.createConnection')}</button>
          </div>
         ) : (
           <div className="space-y-1">
<div className="mb-4 rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-800/30 p-2">
                 <button
                   onClick={() => setConnectionsOpen(v => !v)}
                   aria-expanded={connectionsOpen}
                   title={connectionsOpen ? t('sidebar.collapseConnections') : t('sidebar.expandConnections')}
                   className="w-full flex items-center justify-between mb-2 px-1 rounded hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                 >
                   <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('ui.connections')}</span>
                   <span className="flex items-center gap-1.5">
                     <span className="text-[10px] text-gray-400">{visibleConnections.length}</span>
                     <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${connectionsOpen ? 'rotate-180' : ''}`} />
                   </span>
                 </button>
                {connectionsOpen && (
                <div className="space-y-1">
                  {visibleConnections.map(connection => (
                   <div key={connection.id} className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800">
                     {KIND_ICONS[connection.kind] || <Database className="w-4 h-4 text-gray-500 dark:text-gray-400" />}
                     <button onClick={() => { setActiveConnId(connection.id); setActiveView('databases'); }} className="flex-1 min-w-0 text-left truncate text-xs text-gray-700 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400" title={connection.name}>
                       {connection.name}
                     </button>
                     {onEditConnection && <button onClick={() => onEditConnection(connection)} title={t('ui.editConnection')} className="p-1 text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"><Settings className="w-3.5 h-3.5" /></button>}
                     {onDeleteConnection && <button onClick={() => onDeleteConnection(connection)} title={t('ui.deleteConnection')} className="p-1 text-red-500 hover:text-red-700 dark:hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>}
                   </div>
))}
                </div>
                )}
</div>
              {/* Сброс один на оба порядка: кнопка в каждой категории означала бы
                  «сбросить только это», а пользователь ждёт «вернуть всё как было».
                  Показываем, только когда есть что сбрасывать. */}
              {(kindOrder.length > 0 || Object.keys(dbOrder).length > 0) && (
                <button
                  onClick={resetOrder}
                  title={t('sidebar.resetOrder')}
                  className="mb-1 w-full text-[11px] text-gray-400 hover:text-blue-500 dark:hover:text-blue-300 text-left px-1"
                >
                  {t('sidebar.resetOrder')}
                </button>
              )}
              {Object.entries(connGroups).map(([kind, conns]) => {
              // Все БД категории: пары (подключение, бд) со всех подключений этого типа.
              // Подуровень подключений убран — категория раскрывается сразу в базы.
              const flatRows = conns.flatMap(conn =>
                (databasesByConn[conn.id] || []).map(db => ({ conn, db, key: dbRowKey(conn.id, db) }))
              );
              // Пользовательский порядок применяется здесь, а не к ответу API:
              // сервер отдаёт базы в произвольном порядке (алфавитный гарантирован
              // только у PostgreSQL), и перестановка должна переживать refresh.
              const rows = sortRows(flatRows, row => row.key, dbOrder[kind] ?? []);
              const kindIsDragging = kindDrag === kind;
              const kindIsOver = kindOver === kind && kindDrag !== null;
              return (
              <div key={kind} className="relative mb-2">
                {/* Полоска места вставки категории — над или под её шапкой,
                    в зависимости от половины, в которой находится курсор. */}
                {kindIsOver && (
                  <div className={`absolute left-0 right-0 h-0.5 bg-indigo-500 rounded ${kindOverPos === 'before' ? '-top-[1px]' : '-bottom-[1px]'}`} />
                )}
                <div
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', `kind:${kind}`);
                    setKindDrag(kind);
                  }}
                  onDragEnd={stopKindDrag}
                  onDragOver={(event) => {
                    if (!kindDrag || kindDrag === kind) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const rect = event.currentTarget.getBoundingClientRect();
                    const pos = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
                    if (kindOver !== kind || kindOverPos !== pos) { setKindOver(kind); setKindOverPos(pos); }
                  }}
                  onDragLeave={() => { if (kindOver === kind) setKindOver(null); }}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleKindDrop(orderedKinds, kind, kindOver === kind ? kindOverPos : 'before');
                  }}
                  className={`rounded-md cursor-grab active:cursor-grabbing ${kindIsDragging ? 'opacity-50' : ''}`}
                >
                <button
                  data-kind-key={kind}
                  onClick={() => toggleExpand(kind)}
                  onKeyDown={(event) => {
                    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                    if (!delta) return;
                    if (handleKindKeyMove(orderedKinds, kind, delta)) event.preventDefault();
                  }}
                  title={t('sidebar.reorderKinds')}
                  className="w-full flex items-center justify-between p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <GripVertical className="w-3.5 h-3.5 opacity-40" aria-hidden="true" />
                    {KIND_ICONS[kind] || <Database className="w-5 h-5" />}
                    <span className="font-medium">{kindLabels[kind] || kind}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-800 px-1.5 rounded-full">{rows.length}</span>
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${expanded[kind] ? 'rotate-180' : ''}`} />
                  </div>
                </button>
                </div>
                {expanded[kind] && (
                  <div className="ml-4 mt-1 border-l-2 border-gray-200 dark:border-gray-800 pl-2 space-y-0.5">
                    {rows.length === 0 ? (
                        <div className="p-1.5 text-[11px] text-gray-400">
                          <p>{conns.length === 0 ? t('sidebar.noConnections') : t('sidebar.noDatabases')}</p>
                          {conns.length === 0 && (
                            <button onClick={() => openCreateConnection()} className="mt-1 text-blue-600 dark:text-blue-400 hover:underline">{t('sidebar.createConnection')}</button>
                          )}
                        </div>
                      ) : (
                        rows.map(({ conn, db, key }) => {
                          const isActive = activeConnId === conn.id && activeDb === db;
                          const isDragging = dragKey === key;
                          const isOver = overKey === key && dragKey !== null;
                          return (
                          <div key={key} className="relative">
                            {/* Полоска места вставки: показывает, где окажется база.
                                Вверху строки — «перед ней», внизу — «после неё». */}
                            {isOver && (
                              <div className={`absolute left-0 right-0 h-0.5 bg-indigo-500 rounded ${overPos === 'before' ? '-top-[1px]' : '-bottom-[1px]'}`} />
                            )}
                            <div
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', key);
                                setDragKey(key);
                                setDragGroup(kind);
                              }}
                              onDragEnd={stopDrag}
                              onDragOver={(event) => {
                                // Перетаскивать можно только внутри своего типа СУБД:
                                // база не переезжает между подключениями разных видов.
                                if (!dragKey || dragGroup !== kind) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                // Сторона вставки — по половине строки, в которую попал
                                // курсор: в списке высотой в 20 пикселей «только перед»
                                // делало бы перенос на строку ниже пустым действием.
                                const rect = event.currentTarget.getBoundingClientRect();
                                const after = event.clientY > rect.top + rect.height / 2;
                                const pos = after ? 'after' : 'before';
                                if (overKey !== key || overPos !== pos) { setOverKey(key); setOverPos(pos); }
                              }}
                              onDragLeave={() => { if (overKey === key) setOverKey(null); }}
                              onDrop={(event) => { event.preventDefault(); handleDrop(kind, rows.map(row => row.key), key, overKey === key ? overPos : 'before'); }}
                              className={`flex items-center rounded-md cursor-grab active:cursor-grabbing ${isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${isDragging ? 'opacity-50' : ''}`}
                              title={t('sidebar.dragToReorder')}
                            >
                              <button
                                data-db-key={key}
                                onKeyDown={(event) => {
                                  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                                  if (!delta) return;
                                  if (handleKeyMove(kind, rows.map(row => row.key), key, delta)) event.preventDefault();
                                }}
                                onClick={() => { setActiveConnId(conn.id); setActiveDb(db); setActiveView('databases'); }}
                                className={`flex-1 flex items-center gap-1.5 p-1.5 rounded-l-md text-left transition-colors text-xs min-w-0 ${isActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>
                                <GripVertical className="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                                <Database className="w-3 h-3 opacity-70 shrink-0" />
                                <span className="truncate">{db}</span>
                              </button>
                               {onEditConnection && (
                                 <button
                                   draggable={false}
                                   onClick={(e) => { e.stopPropagation(); onEditConnection(conn); }}
                                   className="p-1.5 text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 shrink-0"
                                   title={t('ui.editConnection')}
                                 >
                                   <Settings className="w-3.5 h-3.5" />
                                 </button>
                               )}
                               {onDeleteConnection && (
                                 <button
                                   draggable={false}
                                   onClick={(e) => { e.stopPropagation(); onDeleteConnection(conn); }}
                                   className="p-1.5 text-red-500 hover:text-red-700 dark:hover:text-red-300 shrink-0"
                                   title={t('ui.deleteConnection')}
                                 >
                                   <Trash2 className="w-3.5 h-3.5" />
                                 </button>
                               )}
                            {/* У Redis «базы» — это номера 0…15, удалить их нельзя,
                                поэтому кнопку не показываем (сервер вернул бы 400). */}
                            {!isSystemDb(kind, db) && kind !== 'redis' && (
                             <button
                               draggable={false}
                               onClick={(e) => { e.stopPropagation(); handleDeleteDatabase(conn.id, db); }}
                               className="p-1.5 rounded-r-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0"
                               title={t('sidebar.dropDbNamed', { name: db })}
                             >
                               <Trash2 className="w-3 h-3" />
                             </button>
                            )}
                            </div>
                          </div>
                          );
                        })
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-200 dark:border-gray-800 shrink-0 space-y-1">
        <button onClick={() => setActiveView('monitoring')} className={`w-full flex items-center gap-2 p-2 rounded-md transition-colors ${activeView === 'monitoring' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium' : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200'}`}>
          <Activity className={`w-4 h-4 ${activeView === 'monitoring' ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'}`} />
          <span>{t('sidebar.monitoring')}</span>
        </button>
                 <button onClick={() => setShowDocs(true)} className="w-full flex items-center gap-2 p-2 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
           <HelpCircle className="w-4 h-4 text-gray-500 dark:text-gray-400" />
           <span>{t('sidebar.documentation')}</span>
         </button>
         <button onClick={() => openSettings('users')} className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 transition-colors">
          <Shield className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span>{t('sidebar.access')}</span>
        </button>
        <button onClick={() => openSettings('general')} className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 transition-colors">
          <Settings className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      <DocsModal isOpen={showDocs} onClose={() => setShowDocs(false)} />
    </div>
  );
}
