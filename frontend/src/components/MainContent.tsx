import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Search, Plus, Play, Trash2, Download, Upload, Copy, 
  LayoutTemplate, FileCode2, Eye, CalendarClock, AlertTriangle, X, 
  Activity, AlertCircle, Check, RotateCcw, RefreshCw, 
  CornerDownLeft, Filter,
  Eraser, GitBranch, Loader2, Columns3
} from 'lucide-react';
import { Table, LogEntry, SqlLogEntry, SystemEvent } from '../types';
import { CreateTableModal } from './modals/CreateTableModal';
import { TableDesigner } from './TableDesigner';
import {
  DEFAULT_PANES, FloatingPane, PaneControls, loadPaneStates, savePaneStates,
  PANE_ORDER, DETACHED_Z_MIN,
  type PaneId, type PaneState, type PaneStates,
} from './PaneControls';
import { TableView } from './TableView';
import { useLanguage } from '../contexts/LanguageContext';
import { formatDateTime } from '../intl';
import { SqlEditor } from './SqlEditor';
import { FilterInput } from './FilterInput';
import { CollapsedPane, VerticalSplit, EmptyTablePanel } from './workspacePieces';
import { quickSelectSql, quickInsertSql, clearTableSql } from './sqlSnippets';
import { api, ConnectionInfo, errorText, GlobalSearchResult, PanelUser, TabularResult, ColumnDef, toBool } from '../api';
import { SupportedDbDialect } from '../dbDialects';
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
interface MainContentProps {
  activeDb: string;
  activeConnId: string | null;
  activeConn: ConnectionInfo | null;
  databases: string[];
  /** Почему не загрузились базы подключения: пусто, если всё в порядке. */
  databasesError?: string | null;
  /** Повторная попытка загрузить базы подключения после ошибки. */
  onRetryDatabases?: () => void;
  externalTablesVersion?: number;
  addToast: (msg: string, type: 'success'|'error'|'info') => void;
  openCreateTable?: () => void;
  userRole?: PanelUser['role'];
  /** Имя пользователя: компоновка панелей личная, а не общая для всех роли. */
  userName?: string;
}
/** Ключи перевода заголовков панелей: отдельные для заголовка окна. */
const PANE_TITLE_KEY: Record<PaneId, string> = {
  tables: 'tablesPane',
  card: 'tableCard',
  logs: 'logsPane',
  sql: 'sqlPane',
};
export function MainContent({ activeDb, activeConnId, activeConn, databases, databasesError = null, onRetryDatabases, externalTablesVersion = 0, addToast, openCreateTable, userRole, userName }: MainContentProps) {
  const { t, lang } = useLanguage();
  // По умолчанию открывается «Структура»: это привычный главный экран со
  // списком таблиц, журналом и SQL-редактором. Сетка панелей остаётся рядом
  // отдельной вкладкой.
  const [activeTab, setActiveTab] = useState('structure');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{type: 'empty'|'drop'|null, items: string[]}>({type: null, items: []});
  const [bulkLoading, setBulkLoading] = useState(false);
  // Состояние четырёх панелей рабочей области: свернуть, развернуть во весь
  // экран, открепить в окно. Хранится по пользователю и базе, как и раскладка
  // панелей, — иначе после перезагрузки панели возвращались бы в исходный вид.
  const paneKey = `panes:v1:${userName || userRole || 'anonymous'}:${activeConnId || ''}:${activeDb || ''}`;
  const [paneStates, setPaneStates] = useState<PaneStates>(() => loadPaneStates(paneKey).states);
  const paneRef = useRef<HTMLDivElement>(null);
  const setPane = useCallback((paneId: PaneId, patch: Partial<PaneState>) => {
    setPaneStates(prev => {
      const next: PaneStates = { ...prev, [paneId]: { ...prev[paneId], ...patch } };
      savePaneStates(paneKey, next);
      return next;
    });
  }, [paneKey]);
  // Другая база или подключение — панели возвращаются в сетку: координаты
  // окна, привязанные к прошлой базе, в новой бессмысленны.
  useEffect(() => {
    setPaneStates(loadPaneStates(paneKey).states);
  }, [paneKey]);
  const resetPanes = useCallback(() => {
    const next: PaneStates = { ...DEFAULT_PANES };
    savePaneStates(paneKey, next);
    setPaneStates(next);
  }, [paneKey]);
  const anyFull = (['tables', 'card', 'logs', 'sql'] as PaneId[]).some(id => paneStates[id].mode === 'full');
  /** Поднимает окно панели над остальными: порядок кликов по заголовкам. */
  const raisePane = useCallback((paneId: PaneId) => {
    setPaneStates(prev => {
      const cur = prev[paneId];
      if (!cur.win) return prev;
      const top = Math.max(DETACHED_Z_MIN, ...Object.entries(prev).map(([, s]) => s.win?.z ?? 0)) + 1;
      if (cur.win.z === top) return prev;
      const next: PaneStates = { ...prev, [paneId]: { ...cur, win: { ...cur.win, z: top } } };
      savePaneStates(paneKey, next);
      return next;
    });
  }, [paneKey]);
  const tabs = [
    { id: 'structure', label: t('main.tabs.structure'), icon: <LayoutTemplate className="w-4 h-4" /> },
    { id: 'designer', label: t('main.tabs.designer'), icon: <Columns3 className="w-4 h-4" /> },
    { id: 'sql', label: t('main.tabs.sql'), icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'search', label: t('main.tabs.search'), icon: <Search className="w-4 h-4" /> },
    { id: 'export', label: t('main.tabs.export'), icon: <Download className="w-4 h-4" /> },
    { id: 'import', label: t('main.tabs.import'), icon: <Upload className="w-4 h-4" /> },
    { id: 'operations', label: t('main.tabs.operations'), icon: <CalendarClock className="w-4 h-4" /> },
  ];
  const [tables, setTables] = useState<Table[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  // Список таблиц пагинируется на клиенте: /tables отдаёт только имена,
  // серверной постраничности здесь нет, поэтому размер страницы — реальное
  // состояние, а не декоративный <select>.
  const [tablePage, setTablePage] = useState(1);
  const [tablePageSize, setTablePageSize] = useState(25);
  // Соединение, помеченное только для чтения, и роль панели ограничивают
  // изменяющие операции. Controls для них не показываем вовсе (а не disabled),
  // props уже проброшены из App.
  const readOnly = Boolean(activeConn?.readOnly) || userRole === 'readonly';
  const canMutate = !readOnly;
  const filteredTables = tables.filter(t => t.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const tablePageCount = Math.max(1, Math.ceil(filteredTables.length / tablePageSize));
  const safeTablePage = Math.min(tablePage, tablePageCount);
  const pagedTables = filteredTables.slice((safeTablePage - 1) * tablePageSize, safeTablePage * tablePageSize);
  useEffect(() => { setTablePage(1); }, [searchQuery, tablePageSize, activeConnId, activeDb]);
  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedTables(filteredTables.map(t => t.name));
    } else {
      setSelectedTables([]);
    }
  };
  const toggleSelectTable = (name: string) => {
    if (selectedTables.includes(name)) {
      setSelectedTables(selectedTables.filter(t => t !== name));
    } else {
      setSelectedTables([...selectedTables, name]);
    }
  };
  const handleBulkDrop = async () => {
    if (!activeConnId || !activeDb || confirmModal.items.length === 0) return;
    setBulkLoading(true);
    const results = await Promise.allSettled(confirmModal.items.map(name => api.dropTable(activeConnId, activeDb, name)));
    const succeeded = results.flatMap((result, index) => result.status === 'fulfilled' ? [confirmModal.items[index]] : []);
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${confirmModal.items[index]}: ${result.reason?.message || result.reason}`] : []);
    setTables(prev => prev.filter(t => !succeeded.includes(t.name)));
    setSelectedTables(prev => prev.filter(name => !succeeded.includes(name)));
    if (succeeded.length) addToast(t('main.tablesDropped', { count: succeeded.length }), 'success');
    if (failed.length) addToast(t('main.tablesDropFailed', { list: failed.join('; ') }), 'error');
    setConfirmModal({type: null, items: []});
    setBulkLoading(false);
  };
  const handleBulkEmpty = async () => {
    if (!activeConnId || !activeDb || !activeConn || confirmModal.items.length === 0) return;
    setBulkLoading(true);
    const results = await Promise.allSettled(confirmModal.items.map(name => api.query(activeConnId, clearTableSql(activeConn.kind, name), activeDb)));
    const succeeded = results.flatMap((result, index) => result.status === 'fulfilled' ? [confirmModal.items[index]] : []);
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${confirmModal.items[index]}: ${result.reason?.message || result.reason}`] : []);
    setSelectedTables(prev => prev.filter(name => !succeeded.includes(name)));
    if (succeeded.length) addToast(t('main.tablesCleared', { count: succeeded.length }), 'success');
    if (failed.length) addToast(t('main.tablesClearFailed', { list: failed.join('; ') }), 'error');
    setConfirmModal({type: null, items: []});
    setBulkLoading(false);
  };
  const handleBulkExport = async () => {
    if (!activeConnId || !activeDb || selectedTables.length === 0) return;
    const results = await Promise.allSettled(selectedTables.map(async tableName => {
      const response = await api.exportTable(activeConnId, activeDb, tableName, 'csv');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${tableName}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    }));
    const succeeded = results.filter(result => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    if (succeeded) addToast(t('main.tablesExported', { count: succeeded }), 'success');
    if (failed) addToast(t('main.tablesExportFailed', { count: failed }), 'error');
  };
  const [activeLogTab, setActiveLogTab] = useState<'operations' | 'sql' | 'events'>('operations');
  // Уровни событий выводятся из audit.ok, который после toBool даёт
  // только success|error — фильтр держим в том же множестве, иначе
  // кнопки «Инфо»/«Предупреждения» всегда давали бы пустой список.
  const [eventFilter, setEventFilter] = useState<'all' | 'success' | 'error'>('all');
  const [copiedQueryId, setCopiedQueryId] = useState<string | null>(null);
  const [operationLogs, setOperationLogs] = useState<LogEntry[]>([]);
  const [sqlLogs, setSqlLogs] = useState<SqlLogEntry[]>([]);
  const [systemEvents, setSystemEvents] = useState<SystemEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const fetchRealLogs = useCallback(async () => {
    if (!activeConnId) return;
    setLogsLoading(true);
    try {
      const [history, audit] = await Promise.all([
        api.history(activeConnId, 100),
        api.audit(activeConnId, 100),
      ]);
      const formatTime = (value?: number) => value ? formatDateTime(value, lang) : '-';
      // ok приходит как boolean (JSON) или 0|1 (SQLite) — нормализуем один раз,
      // иначе фильтр по событиям и подпись статуса расходятся между собой.
      setOperationLogs(history.map(item => ({
        time: formatTime(item.at),
        user: item.username || 'system',
        action: item.sql,
        result: toBool(item.ok) === false ? 'Error' : 'Success',
      })));
      setSystemEvents(audit.map(item => {
        // values приходит из аудита: {before, after} для правок строк
        const values = (item as { values?: { before?: unknown; after?: unknown } }).values;
        return {
          id: String(item.id),
          time: formatTime(item.at),
          level: toBool(item.ok) === false ? 'error' as const : 'success' as const,
          source: item.action,
          message: [item.target, item.actor, `${item.ms} ms`].filter(Boolean).join(' · '),
          before: values?.before,
          after: values?.after,
        };
      }));
    } catch {
      setOperationLogs([]);
      setSystemEvents([]);
    } finally {
      setLogsLoading(false);
    }
  }, [activeConnId]);
  useEffect(() => { fetchRealLogs(); }, [fetchRealLogs]);
  /**
   * Очистка журналов. «SQL» — список текущей сессии (только клиентский state),
   * «операции» — серверный журнал запросов, «события» — журнал операций (admin).
   * Серверную очистку пишем в журнал заново, поэтому след остаётся виден.
   */
  const handleClearLogs = async (scope: 'sql' | 'operations' | 'events') => {
    if (scope === 'sql') {
      if (!confirm(t('main.logs.clearConfirm', { what: t('main.logs.sqlLog') }))) return;
      setSqlLogs([]);
      return;
    }
    if (scope === 'operations') {
      // Ровно одно окно подтверждения, и «Отмена» его уважает. Раньше у
      // администратора результат confirm() уходил в all и вообще не
      // проверялся: отмена всё равно очищала журнал.
      const all = userRole === 'admin';
      const confirmed = all
        ? confirm(t('main.logs.clearConfirmAll', { what: t('main.logs.sqlLog') }))
        : confirm(t('main.logs.clearConfirm', { what: t('main.logs.sqlLog') }));
      if (!confirmed) return;
      try {
        const r = await api.clearHistory(all ? 'all' : 'mine', activeConnId ?? undefined);
        await fetchRealLogs();
        setSqlLogs([]);
        notify(r.deleted);
      } catch (error: any) {
        notify(error.message, 'error');
      }
      return;
    }
    if (userRole !== 'admin') return;
    if (!confirm(t('main.logs.clearConfirmAll', { what: t('main.logs.events') }))) return;
    try {
      const r = await api.clearAudit({ all: true });
      await fetchRealLogs();
      notify(r.deleted);
    } catch (error: any) {
      notify(error.message, 'error');
    }
  };
  const notify = (message: string | number, type: 'success' | 'error' = 'success') => {
    addToast(`${t('main.logs.cleared')}: ${message}`, type);
  };
  const [structSql, setStructSql] = useState('');
  const [fullSql, setFullSql] = useState('');
  const [queryResult, setQueryResult] = useState<TabularResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  // Docked panels resizable heights & widths
  // Одна ручка на границе «таблицы / нижняя секция»: тянем вниз — таблицы
  // растут, низ уменьшается; вверх — наоборот. Контейнер без скролла,
  // поэтому полоса всегда на стыке панелей.
  const [dockedBottomHeight, setDockedBottomHeight] = useState<number>(270);
  const [dockedBottomSplitRatio, setDockedBottomSplitRatio] = useState<number>(50);
  // Доля ширины списка таблиц в разделённой компоновке «список | карточка».
  // Ключ хранилища включает подключение и базу, как и сказано в комментарии
  // ниже: ширина, подобранная под одну базу, не должна молча применяться к
  // другой. Раньше в ключе был только пользователь, и после перезагрузки
  // сохранённая ширина терялась — эффект сброса срабатывал на восстановленном
  // подключении так же, как на настоящей смене.
  const splitUserKey = userName || userRole || 'anonymous';
  const sideSplitKey = `structSplit:${splitUserKey}:${activeConnId || ''}:${activeDb || ''}`;
  const [sideSplitRatio, setSideSplitRatio] = useState<number>(34);
  // Ключ, под который доля уже применена: сброс на смену базы должен сработать
  // один раз, а не на каждом рендере с тем же самым ключом.
  const appliedSplitKeyRef = useRef<string>('');
  useEffect(() => {
    if (!activeConnId || !activeDb) {
      appliedSplitKeyRef.current = '';
      return;
    }
    if (appliedSplitKeyRef.current === sideSplitKey) return;
    appliedSplitKeyRef.current = sideSplitKey;
    let saved = Number.NaN;
    try { saved = Number(localStorage.getItem(sideSplitKey)); } catch { /* приватный режим */ }
    // Другая база или подключение — начинаем с исходной доли, иначе ширина,
    // подобранная под одну базу, применялась бы к другой молча.
    setSideSplitRatio(Number.isFinite(saved) && saved >= 15 && saved <= 70 ? saved : 34);
  }, [sideSplitKey, activeConnId, activeDb]);
  useEffect(() => {
    // Сохраняем, только когда доля применена к конкретной базе: иначе первым
    // же сохранением записался бы 34 в ключ ещё не выбранного подключения.
    if (!activeConnId || !activeDb || appliedSplitKeyRef.current !== sideSplitKey) return;
    try { localStorage.setItem(sideSplitKey, String(sideSplitRatio)); } catch { /* приватный режим */ }
  }, [sideSplitRatio, sideSplitKey, activeConnId, activeDb]);
  const isResizingDockedRef = useRef<string | null>(null);
  // Версия списка таблиц: дёргается после любого DDL, чтобы панель
  // сразу показывала созданные/удалённые таблицы без обновления страницы
  const [tablesVersion, setTablesVersion] = useState(0);
  // Fetch real tables from API when connection or database changes
  useEffect(() => {
    if (!activeConnId || !activeDb) { setTables([]); setActiveTable(null); return; }
    // Kill-switch против протухшего выбора: не запрашивать таблицы БД,
    // которой нет в списке текущего подключения (пустой список = ещё грузится)
    if (databases.length > 0 && !databases.includes(activeDb)) { setTables([]); setActiveTable(null); return; }
    let cancelled = false;
    (async () => {
      setLoadingTables(true);
      try {
        const tableNames = await api.tables(activeConnId, activeDb);
        if (cancelled) return;
        const tableList: Table[] = tableNames.map(name => ({ name }));
        setTables(tableList);
        setActiveTable(null);
      } catch (e: any) {
        if (!cancelled) {
          setTables([]);
          addToast(t('main.errorLoadTables') + e.message, 'error');
        }
      } finally {
        if (!cancelled) setLoadingTables(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeConnId, activeDb, databases, tablesVersion, externalTablesVersion]);
  // Execute real SQL query — всегда в контексте ВЫБРАННОЙ базы,
  // иначе CREATE/DROP уходят в default-БД, а панель показывает другую
  /**
   * План выполнения запроса. Работает только для чтения: сервер отклоняет
   * INSERT/UPDATE/DELETE (а ANALYZE в PostgreSQL запрос выполняет).
   */
  const [explainPlan, setExplainPlan] = useState<Record<string, unknown>[] | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const handleExplain = async (sql: string) => {
    if (!activeConnId) return;
    const statement = sql.trim();
    if (!statement) { addToast(t('main.enterSql'), 'error'); return; }
    setExplainBusy(true);
    try {
      const r = await api.explain(activeConnId, statement, activeDb || undefined, activeConn?.kind === 'postgres');
      setExplainPlan(r.plan.rows as Record<string, unknown>[]);
      setQueryResult(r.plan);
      addToast(t('main.planShown', { count: r.plan.rowCount }), 'success');
    } catch (error: any) {
      addToast(t('main.errorPlan') + error.message, 'error');
    } finally {
      setExplainBusy(false);
    }
  };
  const executeQuery = useCallback(async (sql: string) => {
    if (!activeConnId || !sql.trim()) return;
    setQueryLoading(true);
    try {
      const result = await api.query(activeConnId, sql, activeDb || undefined);
      setQueryResult(result);
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0];
      const newSqlEntry: SqlLogEntry = {
        id: Date.now().toString(), time: timeStr, query: sql.trim(),
        duration: `${result.execMs.toFixed(1)} ms`, rows: result.rowCount, status: 'success'
      };
      setSqlLogs(prev => [newSqlEntry, ...prev]);
      addToast(t('main.queryExecuted', { ms: result.execMs.toFixed(1), rows: result.rowCount }), 'success');
      // DDL меняет состав таблиц — сразу перезагружаем список,
      // иначе созданное видно только после обновления страницы
      if (/\b(create|drop|alter|truncate)\s+(table|database|index|view|schema)\b/i.test(sql)) {
        setTablesVersion(v => v + 1);
      }
    } catch (e: any) {
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0];
      const newSqlEntry: SqlLogEntry = {
        id: Date.now().toString(), time: timeStr, query: sql.trim(),
        duration: '0 ms', rows: 0, status: 'error'
      };
      setSqlLogs(prev => [newSqlEntry, ...prev]);
      addToast(t('main.errorQuery') + e.message, 'error');
    } finally {
      setQueryLoading(false);
    }
  }, [activeConnId, activeDb, addToast]);
  // Удаление таблицы: сначала предпросмотр (сколько строк исчезнет), и только
  // после явного подтверждения — сам DROP. Без предпросмотра «удалить таблицу»
  // означало «удалить всё, что в ней было», а узнать об этом можно было только post factum.
  const dropTable = useCallback(async (tableName: string) => {
    if (!activeConnId || !activeDb) return;
    let preview: { exists: boolean; rowsApprox: number; operation: string } | null = null;
    try {
      preview = await api.dropTablePreview(activeConnId, activeDb, tableName);
    } catch (e: any) {
      addToast(t('bulk.dropTablePreviewFailed', { msg: e.message }), 'error');
      return;
    }
    if (preview && !preview.exists) {
      addToast(t('bulk.dropTableMissing', { name: tableName }), 'error');
      return;
    }
    const lines = [
      t('bulk.dropTableTitle', { name: tableName }),
      preview ? t('bulk.dropTableRows', { n: preview.rowsApprox }) : '',
      preview?.operation ? t('bulk.dropTableOperation', { op: preview.operation }) : '',
      t('bulk.dropTableDataLost')
    ].filter(Boolean).join('\n');
    if (!confirm(lines)) return;
    try {
      await api.dropTable(activeConnId, activeDb, tableName);
      setTables(prev => prev.filter(t => t.name !== tableName));
      addToast(t('main.tableDropped', { name: tableName }), 'success');
    } catch (e: any) {
      addToast(t('main.errorDelete') + e.message, 'error');
    }
  }, [activeConnId, activeDb, addToast]);
  // Truncate real table
  const truncateTable = useCallback(async (tableName: string) => {
    if (!activeConnId || !activeDb || !activeConn) return;
    try {
      await api.query(activeConnId, clearTableSql(activeConn.kind, tableName), activeDb);
      addToast(t('main.tableCleared', { name: tableName }), 'success');
    } catch (e: any) {
      addToast(t('main.errorClear') + e.message, 'error');
    }
  }, [activeConnId, activeDb, activeConn, addToast]);
  const startResizeDocked = (
    type: 'bottom-height' | 'bottom-split' | 'side-split',
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingDockedRef.current = type;
    const startY = e.clientY;
    const startX = e.clientX;
    const initialBottomH = dockedBottomHeight;
    const initialSplit = dockedBottomSplitRatio;
    const initialSideSplit = sideSplitRatio;
    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isResizingDockedRef.current) return;
      const deltaY = moveEv.clientY - startY;
      const deltaX = moveEv.clientX - startX;
      if (isResizingDockedRef.current === 'bottom-height') {
        // Ручка на стыке: тянем вниз — низ уменьшается (таблицы растут),
        // вверх — низ растёт. Максимум — чтобы таблицам осталось место.
        const containerH = workspaceRef.current ? workspaceRef.current.clientHeight : 800;
        const maxH = Math.max(200, containerH - 260);
        const nextH = Math.max(160, Math.min(maxH, initialBottomH - deltaY));
        setDockedBottomHeight(nextH);
      } else if (isResizingDockedRef.current === 'bottom-split') {
        // Dragging horizontal split between logs and sql editor
        const containerW = workspaceRef.current ? workspaceRef.current.clientWidth : 1000;
        const deltaPercent = (deltaX / containerW) * 100;
        const nextSplit = Math.max(20, Math.min(80, initialSplit + deltaPercent));
        setDockedBottomSplitRatio(nextSplit);
      } else if (isResizingDockedRef.current === 'side-split') {
        // Граница между списком таблиц и карточкой таблицы. Нижняя граница 18% и
        // верхняя 62%: карточке с вкладками и панелью действий нужно больше
        // места, чем списку, но и список с названиями не должен сжиматься в
        // одну букву — иначе им невозможно пользоваться.
        const containerW = workspaceRef.current ? workspaceRef.current.clientWidth : 1000;
        const deltaPercent = (deltaX / containerW) * 100;
        const next = Math.max(18, Math.min(62, initialSideSplit + deltaPercent));
        setSideSplitRatio(next);
      }
    };
    const onMouseUp = () => {
      isResizingDockedRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };
  const handleInsertQueryToEditor = (query: string) => {
    setStructSql(query);
    addToast(t('main.logs.insertToEditor'), 'info');
  };
  const handleCopyQuery = async (query: string, id: string) => {
    try {
      await navigator.clipboard.writeText(query);
      setCopiedQueryId(id);
      addToast(t('main.logs.copyQuery'), 'success');
      setTimeout(() => setCopiedQueryId(null), 2000);
    } catch {
      addToast(t('main.clipboardUnavailable'), 'error');
    }
  };
  const handleSaveQuery = async (valueToSave = structSql) => {
    const value = valueToSave.trim();
    if (!value) {
      addToast(t('main.enterSql'), 'error');
      return;
    }
    try {
      await api.saveHistory(value, activeConnId || undefined, activeDb || undefined, t('main.savedQuery'));
      addToast(t('main.querySaved'), 'success');
    } catch (e: any) {
      addToast(t('main.errorSaveQuery') + e.message, 'error');
    }
  };
  const handleRunLoggedQuery = (query: string) => {
    setStructSql(query);
    executeQuery(query);
  };
  // Обновление журналов тянет реальные /history и /audit — никаких демо-заглушек
  const handleRefreshLogs = () => {
    void fetchRealLogs();
  };
  const handleCreateTable = async (name: string, _dialect: SupportedDbDialect, columns: ColumnDef[], opts?: { comment?: string; engine?: string; charset?: string; collate?: string }) => {
    if (!activeConnId || !activeDb) { addToast(t('main.noActiveConnection'), 'error'); return; }
    try {
      // dialect не передаём: backend берёт диалект из типа подключения (cc.kind).
    await api.createTable(activeConnId, activeDb, { name, columns, ...opts });
      setTables(prev => [{ name }, ...prev]);
      setIsCreateModalOpen(false);
      addToast(t('main.tableCreated', { name: name }), 'success');
    } catch (e: any) {
      addToast(t('main.errorCreateTable') + e.message, 'error');
    }
  };
  // Новая схема PostgreSQL — только там схемы существуют отдельно от баз.
  // Имя спрашиваем промптом, как импорт спрашивает таблицу, а клон — имя копии.
  const handleCreateSchema = async () => {
    if (!activeConnId || !activeDb) { addToast(t('main.noActiveConnection'), 'error'); return; }
    const name = window.prompt(t('main.schemaNameLabel'), '');
    if (name === null) return;
    if (!name.trim()) { addToast(t('main.schemaNameRequired'), 'error'); return; }
    try {
      await api.createSchema(activeConnId, activeDb, name.trim());
      setTablesVersion(v => v + 1);
      addToast(t('main.schemaCreated', { name: name.trim() }), 'success');
    } catch (e: any) {
      addToast(t('main.errorCreateSchema') + e.message, 'error');
    }
  };
  // Удаление схемы: сначала пробуем без CASCADE; если не пуста (409) —
  // спрашиваем подтверждение на удаление вместе с содержимым.
  const handleDeleteSchema = async () => {
    if (!activeConnId || !activeDb) { addToast(t('main.noActiveConnection'), 'error'); return; }
    const name = window.prompt(t('main.schemaNameLabel'), '');
    if (name === null) return;
    if (!name.trim()) { addToast(t('main.schemaNameRequired'), 'error'); return; }
    const trimmed = name.trim();
    if (!confirm(t('main.schemaDeleteConfirm', { name: trimmed }))) return;
    try {
      await api.dropSchema(activeConnId, activeDb, trimmed);
      setTablesVersion(v => v + 1);
      addToast(t('main.schemaDeleted', { name: trimmed }), 'success');
    } catch (e: any) {
      if (e?.status === 409 && confirm(t('main.schemaDeleteNonEmpty', { name: trimmed }))) {
        try {
          await api.dropSchema(activeConnId, activeDb, trimmed, true);
          setTablesVersion(v => v + 1);
          addToast(t('main.schemaDeleted', { name: trimmed }), 'success');
        } catch (e2: any) {
          addToast(t('main.errorDeleteSchema') + errorText(e2), 'error');
        }
      } else {
        addToast(t('main.errorDeleteSchema') + errorText(e), 'error');
      }
    }
  };
  // Новое представление: имя + SELECT. Только SQL-СУБД (у Mongo/Redis views нет).
  const handleCreateView = async () => {
    if (!activeConnId || !activeDb) { addToast(t('main.noActiveConnection'), 'error'); return; }
    const name = window.prompt(t('main.viewNameLabel'), '');
    if (name === null) return;
    if (!name.trim()) { addToast(t('main.viewNameRequired'), 'error'); return; }
    const sql = window.prompt(t('main.viewSqlLabel'), `SELECT * FROM ${tables[0]?.name ?? 'my_table'}`);
    if (sql === null) return;
    if (!sql.trim()) { addToast(t('main.viewSqlRequired'), 'error'); return; }
    try {
      await api.createView(activeConnId, activeDb, { name: name.trim(), sql });
      setTablesVersion(v => v + 1);
      addToast(t('main.viewCreated', { name: name.trim() }), 'success');
    } catch (e: any) {
      addToast(t('main.errorCreateView') + errorText(e), 'error');
    }
  };
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult | null>(null);
  const [globalSearchPage, setGlobalSearchPage] = useState(1);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const globalSearchReqRef = useRef(0);
  const handleGlobalSearch = async (page = 1) => {
    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults(null);
      return;
    }
    if (!activeConnId || !activeDb) {
      addToast(t('main.pickDatabase'), 'error');
      return;
    }
    const requestId = ++globalSearchReqRef.current;
    setGlobalSearchLoading(true);
    setGlobalSearchPage(page);
    addToast(t('main.searchStarted'), 'info');
    try {
      const result = await api.globalSearch(activeConnId, activeDb, query, { page, pageSize: 50, limit: 1000 });
      if (requestId !== globalSearchReqRef.current) return;
      setGlobalSearchResults(result);
      addToast(t('main.searchFinished', { total: result.total, limit: result.truncated ? t('main.limitReached') : '' }), 'success');
    } catch (e: any) {
      addToast(t('main.errorSearch') + e.message, 'error');
      if (requestId === globalSearchReqRef.current) setGlobalSearchResults(null);
    } finally {
      if (requestId === globalSearchReqRef.current) setGlobalSearchLoading(false);
    }
  };
  const handleRunSql = () => {
    if (!structSql.trim()) { addToast(t('main.enterSql'), 'error'); return; }
    executeQuery(structSql.trim());
  };
  // Область экспорта: вся база или одна таблица. Раньше выбор был только по
  // таблице, хотя вкладка называлась «Экспорт базы» — выгрузить базу целиком
  // было нельзя. ALL — специальное значение списка, а не имя таблицы.
  const EXPORT_ALL = '__all__';
  const [exportTableName, setExportTableName] = useState('');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json' | 'sql'>('sql');
  const [exporting, setExporting] = useState(false);
  const [importTableName, setImportTableName] = useState('');
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!exportTableName && tables[0]) setExportTableName(EXPORT_ALL);
  }, [exportTableName, tables]);
  const exportWholeDb = exportTableName === EXPORT_ALL;
  const handleExport = async () => {
    if (!activeConnId || !activeDb || !exportTableName) {
      addToast(t('main.pickExportTable'), 'error');
      return;
    }
    setExporting(true);
    try {
      const response = exportWholeDb
        ? await api.exportDatabase(activeConnId, activeDb, exportFormat)
        : await api.exportTable(activeConnId, activeDb, exportTableName, exportFormat);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${exportWholeDb ? activeDb : exportTableName}.${exportFormat}`;
      link.click();
      URL.revokeObjectURL(url);
      addToast(t('main.exportDone', { name: exportWholeDb ? activeDb : exportTableName, format: exportFormat }), 'success');
    } catch (e: any) {
      addToast(t('main.errorExport') + e.message, 'error');
    } finally {
      setExporting(false);
    }
  };
  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !activeConnId || !activeDb) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const format = extension === 'csv' ? 'csv' : extension === 'json' ? 'json' : 'sql';
    if (format !== 'sql' && !importTableName) {
      addToast(t('main.pickTargetTable'), 'error');
      event.target.value = '';
      return;
    }
    setImporting(true);
    try {
      const result = await api.importData(activeConnId, format, await file.text(), activeDb, format === 'sql' ? undefined : importTableName);
      addToast(t('main.importDone', { count: result.inserted ?? result.statements ?? 0 }), 'success');
      setTablesVersion(v => v + 1);
    } catch (e: any) {
      addToast(t('main.errorImport') + e.message, 'error');
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  };
  const activeDialect: SupportedDbDialect = activeConn?.kind === 'postgres'
    ? 'postgresql'
    : activeConn?.kind === 'redis'
      ? 'redis'
      : activeConn?.kind === 'sqlite'
        ? 'sqlite'
        : activeConn?.kind === 'mongodb'
          ? 'mongodb'
          : activeConn?.kind === 'mariadb'
            ? 'mariadb'
            : activeConn?.kind === 'oracle'
              ? 'oracle'
              : 'mysql';
const workspaceRef = useRef<HTMLDivElement>(null);
  // Отдельной вкладки с панелями больше нет: панели живут в рабочей области,
  // а открепление — в шапке панели.
  const renderTableList = () => {
    const onTableSelect = (tableName: string) => {
      setActiveTable(tableName);
    };
    return (
    <div className="flex flex-col flex-1 min-h-0 bg-white dark:bg-[#1e2330] border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden shadow-sm relative">
      {/* Table Card Header Toolbar */}
      <div className="p-2.5 px-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-800/50 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
          <div className="flex items-center gap-2">
            <LayoutTemplate className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t('main.dbTables')}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {filteredTables.length}
            </span>
          </div>
          {paneHeader('tables', t('main.pane.tablesPane'))}
          {activeConn?.kind === 'postgres' && canMutate && (
            <button onClick={() => void handleCreateSchema()} title={t('main.schemaCreate')}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors whitespace-nowrap">
              {t('main.schemaCreate')}
            </button>
          )}
          {activeConn?.kind === 'postgres' && canMutate && (
            <button onClick={() => void handleDeleteSchema()} title={t('main.schemaDelete')}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors whitespace-nowrap">
              {t('main.schemaDelete')}
            </button>
          )}
          {activeConn && activeConn.kind !== 'mongodb' && activeConn.kind !== 'redis' && canMutate && (
            <button onClick={() => void handleCreateView()} title={t('main.viewCreate')}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors whitespace-nowrap">
              {t('main.viewCreate')}
            </button>
          )}
        </div>
      </div>
          {selectedTables.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/20 px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between animate-in fade-in shrink-0">
          <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{t('main.selectedCount')} {selectedTables.length}</span>
          <div className="flex items-center gap-2 text-sm">
            <button onClick={handleBulkExport} className="px-3 py-1 bg-white dark:bg-[#151923] border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors">{t('main.bulkExport')}</button>
            {canMutate && <>
              <button onClick={() => setConfirmModal({type: 'empty', items: selectedTables})} className="px-3 py-1 bg-white dark:bg-[#151923] border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 rounded hover:bg-orange-100 dark:hover:bg-orange-900/50 transition-colors">{t('main.bulkEmpty')}</button>
              <button onClick={() => setConfirmModal({type: 'drop', items: selectedTables})} className="px-3 py-1 bg-white dark:bg-[#151923] border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">{t('main.bulkDrop')}</button>
            </>}
          </div>
        </div>
      )}
      {readOnly && (
        <div className="px-4 py-1.5 border-b border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 text-xs text-amber-700 dark:text-amber-300 shrink-0">
          {t('main.readonlyHint')}
        </div>
      )}
      <div className="overflow-y-auto overflow-x-hidden w-full min-w-0 flex-1 min-h-0">
        {/* table-fixed и truncate вместо min-w-[420px] + whitespace-nowrap:
            список делит ширину с карточкой таблицы, и прежняя разметка давала
            горизонтальную прокрутку, как только панель сужалась. */}
        <table className="w-full table-fixed text-sm text-left">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-3 w-8 text-center">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 dark:border-gray-600"
                  checked={filteredTables.length > 0 && selectedTables.length === filteredTables.length}
                  onChange={handleSelectAll}
                />
              </th>
              <th className="px-2 py-3 font-medium truncate">{t('main.table.name')}</th>
              <th className="px-2 py-3 font-medium w-[46%]">{t('main.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {pagedTables.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  {loadingTables ? t('main.table.loading')
                    : databasesError
                      // Базы не загрузились — молчаливое «Таблицы не найдены»
                      // вводило в заблуждение: их на самом деле никто не искал.
                      ? (
                        <>
                          <p className="text-red-600 dark:text-red-400 font-medium">{t('main.table.connUnavailable')}</p>
                          <p className="text-xs mt-1 break-words">{databasesError}</p>
                          {onRetryDatabases && (
                            <button onClick={onRetryDatabases} className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                              <RefreshCw className="w-3.5 h-3.5" />{t('ui.refresh')}
                            </button>
                          )}
                        </>
                      )
                      : t('main.table.notFound')}
                </td>
              </tr>
            ) : (
              pagedTables.map((table) => (
              <tr key={table.name} className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group ${selectedTables.includes(table.name) ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                <td className="px-2 py-3 text-center">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 dark:border-gray-600"
                    checked={selectedTables.includes(table.name)}
                    onChange={() => toggleSelectTable(table.name)}
                  />
                </td>
                <td className="px-2 py-3 font-medium text-blue-600 dark:text-blue-400 min-w-0">
                  <button onClick={() => onTableSelect(table.name)} title={table.name} className="block w-full truncate text-left hover:underline">{table.name}</button>
                </td>
                <td className="px-2 py-3 min-w-0">
                  {/* Кнопки переносятся, а не сжимаются в ноль: в узкой панели
                      иначе они переставали бы попадать под курсор. */}
                  <div className="flex items-center gap-1 flex-wrap text-gray-500 dark:text-gray-400">
                    <button title={t('main.table.browse')} onClick={() => onTableSelect(table.name)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-blue-600 dark:hover:text-blue-400"><Eye className="w-4 h-4"/></button>
                    <button title={t('main.table.structure')} onClick={() => onTableSelect(table.name)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-blue-600 dark:hover:text-blue-400"><LayoutTemplate className="w-4 h-4"/></button>
                     <button title={t('main.table.query')} onClick={() => { setStructSql(quickSelectSql(activeConn?.kind || 'mysql', table.name)); setActiveTab('sql'); }} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-blue-600 dark:hover:text-blue-400"><Search className="w-4 h-4"/></button>
                     {canMutate && activeConn?.kind !== 'mongodb' && activeConn?.kind !== 'redis' && <button title={t('main.table.insert')} onClick={() => { setStructSql(quickInsertSql(activeConn?.kind || 'mysql', table.name)); setActiveTab('sql'); }} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-blue-600 dark:hover:text-blue-400"><Plus className="w-4 h-4"/></button>}
                    {canMutate && <button title={t('main.table.empty')} onClick={() => {
                      if (confirm(t('main.table.emptyConfirm', { name: table.name }))) truncateTable(table.name);
                    }} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-orange-600 dark:hover:text-orange-400"><Eraser className="w-4 h-4"/></button>}
                    {canMutate && <button title={t('main.table.drop')} onClick={() => {
                      if (confirm(t('main.table.dropConfirm', { name: table.name }))) dropTable(table.name);
                    }} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors hover:text-red-600 dark:hover:text-red-400"><Trash2 className="w-4 h-4"/></button>}
                  </div>
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="p-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400 shrink-0">
        <span>{t('main.table.showing', { shown: pagedTables.length, total: filteredTables.length, all: tables.length })}</span>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap">{t('main.table.pageSize')}:</span>
            <select
              value={tablePageSize}
              onChange={(e) => setTablePageSize(Number(e.target.value))}
              className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded px-2 py-1"
              aria-label={t('main.table.pageSize')}
            >
              {[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTablePage(page => Math.max(1, page - 1))}
              disabled={safeTablePage <= 1}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
            >{t('main.table.prev')}</button>
            <span>{t('main.table.page', { page: safeTablePage, pages: tablePageCount })}</span>
            <button
              onClick={() => setTablePage(page => Math.min(tablePageCount, page + 1))}
              disabled={safeTablePage >= tablePageCount}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
            >{t('main.table.next')}</button>
          </div>
        </div>
      </div>
    </div>
    );
  };
  const renderLogs = () => (
    <div className="bg-white dark:bg-[#1e2330] flex flex-col h-full overflow-hidden border border-gray-200 dark:border-gray-800 rounded-lg shadow-sm">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0 min-w-0">
        <button
          onClick={() => setActiveLogTab('operations')}
          className={`text-sm font-medium pb-2 -mb-3 border-b-2 transition-all flex items-center gap-1.5 ${

            activeLogTab === 'operations'

              ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400 font-semibold'

              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 border-transparent'

          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>{t('main.logs.recent')}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${

            activeLogTab === 'operations'

              ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'

              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'

          }`}>
            {operationLogs.length}
          </span>
        </button>
        <button
          onClick={() => setActiveLogTab('sql')}
          className={`text-sm font-medium pb-2 -mb-3 border-b-2 transition-all flex items-center gap-1.5 ${

            activeLogTab === 'sql'

              ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400 font-semibold'

              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 border-transparent'

          }`}
        >
          <FileCode2 className="w-3.5 h-3.5" />
          <span>{t('main.logs.sqlLog')}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${

            activeLogTab === 'sql'

              ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'

              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'

          }`}>
            {sqlLogs.length}
          </span>
        </button>
        <button
          onClick={() => setActiveLogTab('events')}
          className={`text-sm font-medium pb-2 -mb-3 border-b-2 transition-all flex items-center gap-1.5 ${

            activeLogTab === 'events'

              ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400 font-semibold'

              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 border-transparent'

          }`}
        >
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{t('main.logs.events')}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${

            activeLogTab === 'events'

              ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'

              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'

          }`}>
            {systemEvents.length}
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {/* Очистка журналов: своей вкладки — по кнопке корзины, всех разом —
              админу. Действие необратимо, поэтому только с подтверждением. */}
          {activeLogTab === 'sql' && sqlLogs.length > 0 && (
            <button onClick={() => void handleClearLogs('sql')} title={t('main.clearSqlHistory')}
              className="px-2 py-1 rounded text-xs border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> {t('main.logs.clear')}
            </button>
          )}
          {activeLogTab === 'operations' && (
            <button onClick={() => void handleClearLogs('operations')} title={t('main.deleteQueryLog')}
              className="px-2 py-1 rounded text-xs border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> {t('main.logs.clear')}
            </button>
          )}
          {activeLogTab === 'events' && userRole === 'admin' && (
            <button onClick={() => void handleClearLogs('events')} title={t('main.deleteOpsLog')}
              className="px-2 py-1 rounded text-xs border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> {t('main.logs.clear')}
            </button>
          )}
        </div>
        {paneHeader('logs', t('main.pane.logsPane'))}
      </div>
      {/* Tab 1: Operations */}
      {activeLogTab === 'operations' && (
        <div className="overflow-y-auto overflow-x-hidden flex-1 p-0 min-w-0">
          {operationLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 p-6 text-center">
              <Activity className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-xs">{t('main.opsLogEmpty')}</p>
              <button onClick={handleRefreshLogs} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> {t('main.logs.refresh')}
              </button>
            </div>
          ) : (
            <table className="w-full table-fixed text-xs text-left">
              <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 sticky top-0 border-b border-gray-200 dark:border-gray-800">
                <tr>
                  <th className="px-3 py-2 font-medium w-[26%] truncate">{t('main.logs.time')}</th>
                  <th className="px-3 py-2 font-medium w-[22%] truncate">{t('main.logs.user')}</th>
                  <th className="px-3 py-2 font-medium w-[32%] truncate">{t('main.logs.action')}</th>
                  <th className="px-3 py-2 font-medium text-right w-[20%] truncate">{t('main.logs.result')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/50">
                {operationLogs.map((log, i) => (
                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 group">
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap truncate">{log.time}</td>
                    <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300 truncate">{log.user}</td>
                    <td className="px-3 py-2 font-mono text-gray-800 dark:text-gray-200 truncate" title={log.action}>{log.action}</td>
<td className="px-3 py-2 text-right max-w-0 overflow-hidden">
                      <span className={`inline-flex items-center gap-1 font-medium min-w-0 overflow-hidden truncate ${log.result === 'Success' ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-400'}`}>
                          <div className={`w-1.5 h-1.5 shrink-0 rounded-full ${log.result === 'Success' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                          {/* Подпись обрезается отдельным элементом: text-overflow
                              не действует на текст внутри flex-контейнера, он
                              становится анонимным flex-элементом. Без обёртки
                              ячейка распирала колонку и панель прокручивалась вбок. */}
                          <span className="truncate">{log.result === 'Success' ? t('main.logs.successStatus') : t('main.logs.errorStatus')}</span>
                       </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {/* Tab 2: SQL Log */}
      {activeLogTab === 'sql' && (
        <div className="overflow-y-auto overflow-x-hidden flex-1 p-0 min-w-0">
          {sqlLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 p-6 text-center">
              <FileCode2 className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-xs">{t('main.sqlLogEmpty')}</p>
              <button onClick={handleRefreshLogs} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> {t('main.logs.refresh')}
              </button>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800/50">
              {sqlLogs.map((log) => (
                <div key={log.id} className="p-3 min-w-0 overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-800/30 text-xs font-mono transition-colors group">
                  <div className="flex items-center justify-between min-w-0 gap-2 flex-wrap text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="font-semibold text-gray-700 dark:text-gray-300">{log.time}</span>
                      <span className="text-green-600 dark:text-green-400 font-sans px-1.5 py-0.2 bg-green-50 dark:bg-green-950/40 rounded border border-green-200 dark:border-green-800/50">
                        {log.duration}
                      </span>
                      <span className="text-gray-400">({log.rows} строк)</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleCopyQuery(log.query, log.id)}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-300"
                        title={t('main.logs.copyQuery')}
                      >
                        {copiedQueryId === log.id ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => handleInsertQueryToEditor(log.query)}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-300"
                        title={t('main.logs.insertToEditor')}
                      >
                        <CornerDownLeft className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleRunLoggedQuery(log.query)}
                        className="p-1 hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded text-blue-600 dark:text-blue-400"
                        title={t('main.logs.runQuery')}
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <pre className="text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900/60 p-2 rounded border border-gray-200/60 dark:border-gray-800/60 whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                    {log.query}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Tab 3: Events */}
      {activeLogTab === 'events' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/30 flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-1.5">
              <Filter className="w-3 h-3 text-gray-400" />
              {(['all', 'success', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setEventFilter(lvl)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${

                    eventFilter === lvl

                      ? 'bg-blue-600 text-white'

                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'

                  }`}
                >
                  {t(`main.logs.filter${lvl === 'all' ? 'All' : lvl === 'success' ? 'Success' : 'Error'}`)}
                </button>
              ))}
            </div>
            <button onClick={handleRefreshLogs} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline" title={t('main.logs.refresh')}>
              {t('main.logs.refresh')}
            </button>
          </div>
          {(() => {
            const filteredEvents = eventFilter === 'all' ? systemEvents : systemEvents.filter(e => e.level === eventFilter);
            return (
              <div className="overflow-y-auto overflow-x-hidden flex-1 p-0">
                {filteredEvents.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 p-6 text-center">
                    <AlertCircle className="w-8 h-8 mb-2 opacity-30" />
                    <p className="text-xs">{t('main.logs.noEvents')}</p>
                    <button onClick={handleRefreshLogs} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> {t('main.logs.refresh')}
                    </button>
                  </div>
                ) : (
                  <table className="w-full table-fixed text-xs text-left">
                    <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 sticky top-0 border-b border-gray-200 dark:border-gray-800">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('main.logs.time')}</th>
                        <th className="px-3 py-2 font-medium">{t('main.logs.level')}</th>
                        <th className="px-3 py-2 font-medium">{t('main.logs.source')}</th>
                        <th className="px-3 py-2 font-medium">{t('main.logs.message')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800/50">
                      {filteredEvents.map((evt) => (
                        <tr key={evt.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                          <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap font-mono text-[11px]">{evt.time}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${

                              evt.level === 'error'

                                ? 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900/50'

                                : 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/50'

                            }`}>
                              {t(`main.logs.${evt.level === 'error' ? 'errorStatus' : 'successStatus'}`)}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] font-medium text-gray-700 dark:text-gray-300">{evt.source}</td>
                          <td className="px-3 py-2 text-gray-800 dark:text-gray-200">
                            <div className="truncate max-w-[200px]" title={evt.message}>{evt.message}</div>
                            {(evt.before !== undefined || evt.after !== undefined) && (
                              // Правка строки: показываем, что именно поменялось
                              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 space-y-0.5">
                                {evt.before !== undefined && evt.before !== null && (
                                  <div className="truncate max-w-[320px]" title={JSON.stringify(evt.before)}>
                                    было: {String(evt.message && typeof evt.before === 'object' ? JSON.stringify(evt.before) : evt.before)}
                                  </div>
                                )}
                                {evt.after !== undefined && evt.after !== null && (
                                  <div className="truncate max-w-[320px] text-emerald-600 dark:text-emerald-400" title={JSON.stringify(evt.after)}>
                                    стало: {typeof evt.after === 'object' ? JSON.stringify(evt.after) : String(evt.after)}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
  const renderSqlEditor = () => (
    <div className="bg-[#1e1e1e] flex flex-col h-full overflow-hidden rounded-lg shadow-sm border border-gray-800">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-[#252526] rounded-t-lg shrink-0">
        <span className="text-sm font-medium text-gray-300">{t('main.sqlQuery')}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => void handleCopyQuery(structSql, 'editor')} className="text-gray-400 hover:text-white transition-colors p-1" title={t('main.copyCode')}>
             <Copy className="w-4 h-4" />
          </button>
          {paneHeader('sql', t('main.pane.sqlPane'))}
        </div>
      </div>
      <div className="flex-1 p-3 overflow-hidden relative">
        <SqlEditor
          value={structSql}
          onChange={setStructSql}
          className="h-full border border-gray-700 rounded-md"
        />
      </div>
      <div className="p-3 border-t border-gray-800 bg-[#252526] rounded-b-lg flex items-center gap-2 shrink-0">
        <button onClick={handleRunSql} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded text-sm font-medium flex items-center gap-2 transition-colors">
          <Play className="w-4 h-4" />{t('main.execute')}</button>
        <button onClick={() => void handleExplain(structSql)} disabled={explainBusy} title={t('main.queryPlanReadOnly')}
          className="bg-transparent border border-amber-600 hover:bg-amber-900/40 text-amber-300 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
          {explainBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />} {t('main.explainBtn')}
        </button>
        <button onClick={() => { setStructSql(''); addToast(t('main.editorCleared'), 'info'); }} className="bg-transparent border border-gray-600 hover:bg-gray-700 text-gray-300 px-4 py-1.5 rounded text-sm font-medium transition-colors">{t('main.clear')}</button>
        <button onClick={() => void handleSaveQuery()} className="bg-transparent border border-gray-600 hover:bg-gray-700 text-gray-300 px-4 py-1.5 rounded text-sm font-medium transition-colors ml-auto">{t('ui.save')}</button>
      </div>
      {queryResult && <div className="max-h-56 overflow-auto border-t border-gray-700 bg-[#1e1e1e]"><div className="px-3 py-2 text-xs text-gray-400">{queryResult.rowCount} строк · {queryResult.execMs.toFixed(1)} ms{queryResult.truncated ? t('main.truncatedMark') : ''}</div><table className="w-full text-xs text-left text-gray-200"><thead className="bg-[#252526]"><tr>{queryResult.columns.map(column => <th key={column} className="px-3 py-2">{column}</th>)}</tr></thead><tbody>{queryResult.rows.map((row, index) => <tr key={index} className="border-t border-gray-800">{queryResult.columns.map(column => <td key={column} className="px-3 py-1.5 whitespace-nowrap">{formatCell(row[column])}</td>)}</tr>)}</tbody></table></div>}
    </div>
  );
// Карточка таблицы открывается рядом со списком, а не вместо него. Раньше
  // здесь был ранний return: вместе со списком исчезали и вкладки, и нижние
  // панели журнала и SQL — править таблицу приходилось с потерей контекста.
  const paneHeader = (paneId: PaneId, label: string, canDetach = true) => (
    <span className="flex items-center gap-1 min-w-0">
      <span className="truncate">{label}</span>
      <PaneControls paneId={paneId} state={paneStates[paneId]} onChange={setPane} canDetach={canDetach} />
    </span>
  );
  /** Содержимое одной панели вместе с её рамкой и поведением свёрнутого состояния. */
  const renderPane = (paneId: PaneId, floating = false) => {
    const state = paneStates[paneId];
    const body = paneId === 'tables' ? renderTableList()
      : paneId === 'card' ? renderTableCard()
      : paneId === 'logs' ? renderLogs()
      : renderSqlEditor();
    // В окне панель всегда развёрнута: свёрнутое окно и есть «свернуть в окно».
    if (floating) return body;
    if (state.collapsed) {
      return (
        <div className="flex-1 min-w-0 min-h-0 flex flex-col" data-pane={paneId}>
          <CollapsedPane
            paneId={paneId}
            title={t(`main.pane.${PANE_TITLE_KEY[paneId]}`)}
            onChange={setPane}
            canDetach={paneId !== 'card' || Boolean(activeTable)}
          />
        </div>
      );
    }
    // data-pane на корне самой панели: по нему панель опознаётся в тестах и
    // при разборе вёрстки, не по порядку кнопок.
    return React.isValidElement(body)
      ? React.cloneElement(body as React.ReactElement<Record<string, unknown>>, { 'data-pane': paneId })
      : body;
  };
  const detachedPanes = (['tables', 'card', 'logs', 'sql'] as PaneId[])
    .filter(id => paneStates[id].mode === 'window')
    .map(id => ({ id, title: t(`main.pane.${PANE_TITLE_KEY[id]}`) }));
  const renderTableCard = () => (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      {activeTable ? (
        <TableView
          activeDb={activeDb}
          tableName={activeTable}
          onBack={() => setActiveTable(null)}
          addToast={addToast}
          connId={activeConnId}
          connKind={activeConn?.kind}
          connectionReadOnly={activeConn?.readOnly}
          userRole={userRole}
          headerExtra={paneHeader('card', t('main.pane.tableCard'), Boolean(activeTable))}
        />
      ) : (
        // Пустой карточке шапка нужна только в полноэкранном режиме: там сетка
        // скрыта под оверлеем, и без кнопок панели из него не выйти (ловушка
        // полноэкранного Back). В сетке оставляем прежний вид без шапки.
        paneStates.card.mode === 'full' ? (
          <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#151923] overflow-hidden">
            <div className="px-4 py-2 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
              <div className="flex items-center gap-2 min-w-0 text-sm text-gray-500 dark:text-gray-400">
                <span className="truncate">{activeDb}</span>
              </div>
              {paneHeader('card', t('main.pane.tableCard'), false)}
            </div>
            <EmptyTablePanel />
          </div>
        ) : <EmptyTablePanel />
      )}
    </div>
  );
  // Поиск по всей базе нужен и во вкладке «Поиск», и как панель сетки, поэтому
  // вынесен в функцию: одна и та же разметка в двух местах расходилась бы.
  const renderSearch = () => (
       <div className="bg-white dark:bg-[#1e2330] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-6 max-w-5xl">
<div className="flex gap-2 mb-4">
            <FilterInput
              placeholder={t('main.searchPlaceholder')}
              value={globalSearchQuery}
              onChange={setGlobalSearchQuery}
              onKeyDown={(e) => e.key === 'Enter' && void handleGlobalSearch(1)}
              className="flex-1 px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button onClick={() => void handleGlobalSearch(1)} disabled={globalSearchLoading} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50">{globalSearchLoading ? t('main.searching') : t('main.search')}</button>
          </div>
         {globalSearchResults === null ? (
           <p className="text-sm text-gray-500 dark:text-gray-400">{t('main.searchHint')}</p>
         ) : (
           <div className="mt-6 space-y-4">
             <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300">
               <span>{t('main.matchesFound')}<strong>{globalSearchResults.total}</strong>{globalSearchResults.truncated ? t('main.limitThousand') : ''}</span>
               {globalSearchResults.errors.length > 0 && <span className="text-amber-600 dark:text-amber-400">Ошибки таблиц: {globalSearchResults.errors.length}</span>}
             </div>
             <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
               <div className="bg-gray-50 dark:bg-gray-800/50 px-4 py-2 border-b border-gray-200 dark:border-gray-800">
                 <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('main.foundRows')}</h4>
               </div>
               {globalSearchResults.hits.length === 0 ? (
                 <p className="px-4 py-4 text-center text-sm text-gray-500 dark:text-gray-400">{t('main.nothingFound')}</p>
               ) : (
                 <div className="divide-y divide-gray-100 dark:divide-gray-800/50">
                   {globalSearchResults.hits.map((hit, index) => (
                     <div key={`${hit.table}-${index}`} className="px-4 py-3">
                       <div className="text-xs text-blue-600 dark:text-blue-400 mb-2">{hit.table}</div>
                       <div className="overflow-x-auto">
                         <table className="w-full text-xs text-left text-gray-800 dark:text-gray-200">
                           <thead><tr>{Object.keys(hit.row).map(column => <th key={column} className="px-2 py-1 font-medium text-gray-500 dark:text-gray-400">{column}</th>)}</tr></thead>
                           <tbody><tr>{Object.keys(hit.row).map(column => <td key={column} className="px-2 py-1 whitespace-nowrap">{formatCell(hit.row[column])}</td>)}</tr></tbody>
                         </table>
                       </div>
                     </div>
                   ))}
                 </div>
               )}
             </div>
             <div className="flex items-center justify-between">
               <button onClick={() => void handleGlobalSearch(globalSearchPage - 1)} disabled={globalSearchLoading || globalSearchPage <= 1} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-sm disabled:opacity-40">{t('ui.back')}</button>
               <span className="text-sm text-gray-500 dark:text-gray-400">Страница {globalSearchPage}</span>
               <button onClick={() => void handleGlobalSearch(globalSearchPage + 1)} disabled={globalSearchLoading || globalSearchPage * globalSearchResults.pageSize >= globalSearchResults.total} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-sm disabled:opacity-40">{t('main.forward')}</button>
             </div>
           </div>
         )}
       </div>
  );
  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#151923] text-gray-900 dark:text-gray-100 overflow-hidden animate-in fade-in duration-200">
      {/* Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-gray-200 dark:border-gray-800 shrink-0 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              if (tab.id !== 'structure') addToast(t('main.switchedToTab', { label: tab.label }), 'info');
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${

              activeTab === tab.id

                ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'

                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'

            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      {/* Workspace Area with support for detached Windows and Taskbar */}
      <div ref={workspaceRef} className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* min-h-0 обязателен: в flex-колонке min-height по умолчанию auto, и
            высокая вкладка (например, SQL с большим запросом) распирала контейнер,
            а overflow-hidden у родителя отрезал нижнюю панель кнопок — они
            оставались на экране только до вставки большого текста. */}
        <div className="flex-1 min-h-0 overflow-hidden p-4 md:p-6 flex flex-col gap-4">
        {activeTab === 'designer' && (
          <section className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2.5 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-sm font-semibold">{t('main.designer.title')}</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('main.designer.hint')}</p>
            </div>
            <TableDesigner
              connId={activeConnId}
              db={activeDb}
              connKind={activeConn?.kind}
              tables={filteredTables.map(table => table.name)}
              canMutate={canMutate}
              addToast={addToast}
              onChanged={() => setTablesVersion(v => v + 1)}
            />
          </section>
        )}
        {activeTab === 'structure' && (
          <>
        {/* Main Header Area */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">{t('main.dbTables')} <span className="text-blue-600 dark:text-blue-400">{activeDb}</span></h2>
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <FilterInput
                placeholder={t('main.searchTables')}
                value={searchQuery}
                onChange={setSearchQuery}
                className="pl-9 pr-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800/50 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 w-full sm:w-64"
              />
            </div>
             {canMutate && activeConn?.kind !== 'redis' && <button onClick={() => openCreateTable ? openCreateTable() : setIsCreateModalOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap shadow-sm">
               <Plus className="w-4 h-4" />
               {t('main.createTable')}
             </button>}
          </div>
        </div>
        {/* Рабочая область вкладки «Структура» — сетка 2×2:
              ┌────────────────┬─────────────────────┐
              │ Таблицы базы   │ Редактор выбранной │
              │ данных         │ таблицы             │
              ├────────────────┼─────────────────────┤
              │ Журнал SQL     │ SQL-запрос          │
              └────────────────┴─────────────────────┘
            Границы общие: вертикальная тянет ширину сразу в обеих строках,
            горизонтальная — высоту нижней строки. Каждая панель умеет
            сворачиваться, разворачиваться во весь экран и открепляться
            в окно — как панели вкладки «Панели», поэтому отдельная вкладка
            с сеткой больше не нужна. min-w-0 обязателен: во flex-контейнере
            без него содержимое распирает строку, и вкладка прокручивается по
            горизонтали. */}
        <div ref={paneRef} data-workspace-grid className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
          {/* Развёрнутая панель закрывает всю рабочую область. Слой один на
              все панели: две одновременно развёрнутые панели невозможны. */}
          {anyFull && (
            <div className="absolute inset-0 z-20 flex flex-col min-h-0">
              {PANE_ORDER.map(id => paneStates[id].mode !== 'full' ? null : (
                <div key={id} className="flex-1 min-h-0 flex flex-col">{renderPane(id)}</div>
              ))}
            </div>
          )}
          {/* Верхняя строка: список таблиц и редактор выбранной таблицы. */}
          <div className={anyFull ? 'hidden' : 'flex-1 min-h-0 flex items-stretch overflow-hidden'}>
            <div style={{ width: `${sideSplitRatio}%` }} className="min-w-0 min-h-0 flex flex-col">
              {paneStates.tables.mode === 'window' ? null : renderPane('tables')}
            </div>
            <VerticalSplit onStart={startResizeDocked} label={t('main.resizeColumns')} />
            {/* Правой колонке — flex-1, см. пояснение у нижней строки. */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {paneStates.card.mode === 'window' ? null : renderPane('card')}
            </div>
          </div>
          {/* Нижняя строка: журнал и SQL-запрос. У неё нет собственной рамки:
              её панели уже в рамках, а лишний border сдвигал колонки нижней
              строки на пиксель вглубь относительно верхней. */}
          <div
            style={{ height: `${dockedBottomHeight}px` }}
            className={anyFull || paneStates.logs.mode === 'window' ? 'hidden' : 'shrink-0 flex items-stretch relative rounded-lg overflow-hidden'}
          >
            {/* Ручка высоты лежит на верхней кромке нижней строки и тянет
                весь ряд, а не только журнал. Толщина — как у полосы по ширине
                (h-2.5 против w-2.5): иначе полосу вверх-вниз приходилось бы
                ловить мышью заметно точнее, чем влево-вправо. */}
            <div
              onMouseDown={(e) => startResizeDocked('bottom-height', e)}
              className="absolute -top-1 left-0 right-0 h-2.5 bg-gray-100 hover:bg-blue-400/80 active:bg-blue-600 dark:bg-gray-800 dark:hover:bg-blue-500 cursor-row-resize flex items-center justify-center transition-colors group select-none z-10"
              title={t('main.resizeBottom')}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('main.resizeBottom')}
              data-split="bottom"
            >
              <div className="w-8 h-1 rounded bg-gray-400 dark:bg-gray-500 group-hover:bg-white" />
            </div>
            <div style={{ width: `${sideSplitRatio}%` }} className="min-w-0 h-full flex flex-col overflow-hidden">
              {paneStates.logs.mode === 'window' ? null : renderPane('logs')}
            </div>
            <VerticalSplit onStart={startResizeDocked} label={t('main.resizeColumns')} />
            {/* Правой колонке задаётся flex-1, а не «100 − доля» процентами:
                вместе с фиксированной шириной левой и разделителем сумма
                процентов превышала контейнер, и flex сжимал обе ячейки. */}
            <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
              {paneStates.sql.mode === 'window' ? null : renderPane('sql')}
            </div>
          </div>
        </div>
        {/* Слой откреплённых панелей. fixed внутри дерева не обрезается
            overflow:hidden предков, поэтому портал не нужен, а пересоздание
            контейнера в StrictMode роняло приложение. z-index ниже модальных
            окон (50) и уведомлений (100), но выше панелей сетки (45). */}
        {detachedPanes.length > 0 && (
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 46 }}>
            {detachedPanes.map(({ id, title }) => (
              <div key={id} className="pointer-events-auto">
                <FloatingPane
                  paneId={id}
                  title={title}
                  state={paneStates[id]}
                  onChange={setPane}
                  containerRef={paneRef}
                  onFocus={() => raisePane(id)}
                >
                  {renderPane(id, true)}
                </FloatingPane>
              </div>
            ))}
          </div>
        )}
          </>
        )}
        {/* Tab: SQL Full Editor */}
        {activeTab === 'sql' && (
          <div className="bg-[#1e1e1e] rounded-lg shadow-sm flex flex-col flex-1 min-h-0 border border-gray-800">
             <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-[#252526] rounded-t-lg shrink-0">
               <span className="text-sm font-medium text-gray-300">{t('main.expandedEditor')}</span>
               <button onClick={() => void handleCopyQuery(fullSql, 'full-editor')} className="text-gray-400 hover:text-white p-1" title={t('main.copySql')}><Copy className="w-4 h-4" /></button>
             </div>
            {/* Область редактора сжимается и прокручивается сама (внутри
                SqlEditor стоит overflow-auto), поэтому кнопки под ней остаются
                на экране при любом объёме запроса. */}
            <div className="flex-1 min-h-0 p-4 overflow-hidden relative">
              <SqlEditor
                value={fullSql}
                onChange={setFullSql}
                className="h-full border border-gray-700 rounded-md"
                minHeight="120px"
              />
            </div>
             <div className="p-4 border-t border-gray-800 bg-[#252526] rounded-b-lg flex items-center gap-3 shrink-0 flex-wrap">
               <button onClick={() => { if (!fullSql.trim()) { addToast(t('main.enterSql'), 'error'); return; } executeQuery(fullSql.trim()); }} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded text-sm font-medium flex items-center gap-2 transition-colors">
                 <Play className="w-4 h-4" />{t('main.execute')}</button>
               <button onClick={() => void handleSaveQuery(fullSql)} className="bg-transparent border border-gray-600 hover:bg-gray-700 text-gray-300 px-6 py-2 rounded text-sm font-medium transition-colors">{t('ui.save')}</button>
               <button onClick={() => void handleExplain(fullSql)} disabled={explainBusy} title={t('main.queryPlanReadOnly')}
                 className="bg-transparent border border-amber-600 hover:bg-amber-900/40 text-amber-300 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
                  {explainBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />} {t('main.explainBtn')}
               </button>
               <button onClick={() => { setFullSql(''); setQueryResult(null); addToast(t('main.editorCleared'), 'info'); }} className="bg-transparent border border-gray-600 hover:bg-gray-700 text-gray-300 px-6 py-2 rounded text-sm font-medium transition-colors">{t('main.clear')}</button>
             </div>
             {queryResult && <div className="max-h-64 overflow-auto border-t border-gray-800"><div className="px-4 py-2 text-xs text-gray-400">{queryResult.rowCount} строк · {queryResult.execMs.toFixed(1)} ms{queryResult.truncated ? t('main.truncatedMark') : ''}</div><table className="w-full text-xs text-left text-gray-200"><thead className="bg-[#252526]"><tr>{queryResult.columns.map(column => <th key={column} className="px-3 py-2">{column}</th>)}</tr></thead><tbody>{queryResult.rows.map((row, index) => <tr key={index} className="border-t border-gray-800">{queryResult.columns.map(column => <td key={column} className="px-3 py-1.5 whitespace-nowrap">{formatCell(row[column])}</td>)}</tr>)}</tbody></table></div>}
          </div>
        )}
{/* Tab: Export */}
        {activeTab === 'export' && (
          <div className="bg-white dark:bg-[#1e2330] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-6 max-w-2xl">
             <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">{t('main.exportTitle')}</h3>
             <div className="space-y-4">
               <div className="space-y-2">
                 <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('main.exportScope')}</label>
                 <select
                   value={exportTableName}
                   onChange={(e) => setExportTableName(e.target.value)}
                   className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white outline-none"
                 >
                   <option value={EXPORT_ALL}>{t('main.exportWholeDb', { db: activeDb || '', count: tables.length })}</option>
                   {tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}
                 </select>
                 {exportWholeDb && (
                   <p className="text-xs text-gray-500 dark:text-gray-400">{t('main.exportWholeDbHint')}</p>
                 )}
               </div>
               <div className="space-y-2">
                 <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('main.exportFormat')}</label>
                 <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as 'csv' | 'json' | 'sql')} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white outline-none">
                   <option value="sql">{t('main.formatSql')}</option>
                   <option value="csv">{t('main.csv')}</option>
                   <option value="json">{t('main.json')}</option>
                 </select>
               </div>
               <button onClick={handleExport} disabled={exporting || !exportTableName} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-md text-sm font-medium mt-4 disabled:opacity-50">
                 {exporting ? t('main.exporting') : t('main.startExport')}
               </button>
             </div>
           </div>
         )}
        {/* Tab: Import */}
        {activeTab === 'import' && (
          <div className="bg-white dark:bg-[#1e2330] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-6 max-w-2xl text-center">
             <div className="space-y-4 text-left">
               <div className="space-y-2">
                 <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('main.targetTable')}</label>
                 <select value={importTableName} onChange={(e) => setImportTableName(e.target.value)} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white outline-none">
                   <option value="">Не выбрана (только для SQL)</option>
                   {tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}
                 </select>
               </div>
               <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-12 hover:border-blue-500 transition-colors cursor-pointer" onClick={() => importFileRef.current?.click()}>
                 <Upload className="w-8 h-8 text-gray-400 mx-auto mb-4" />
                 <p className="text-gray-600 dark:text-gray-400 mb-2">{t('main.pickFile')}</p>
                 <p className="text-xs text-gray-500 dark:text-gray-400">{t('main.maxSize')}</p>
               </div>
               <input ref={importFileRef} type="file" accept=".sql,.csv,.json" onChange={handleImportFile} className="hidden" disabled={importing} />
               {importing && <p className="text-sm text-blue-600 dark:text-blue-400">{t('main.import')}</p>}
             </div>
          </div>
        )}
        {/* Tab: Search */}
         {activeTab === 'search' && renderSearch()}
        {activeTab === 'operations' && (
           <div className="bg-white dark:bg-[#1e2330] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 flex-1 overflow-hidden flex flex-col">
               <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-gray-50 dark:bg-gray-900/50">
                 <span className="font-medium text-gray-900 dark:text-white">{t('main.fullOpsLog')}</span>
                  <button onClick={handleRefreshLogs} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">{t('main.logs.refresh')}</button>
               </div>
             <div className="flex-1 p-4 overflow-y-auto font-mono text-sm">
                {operationLogs.length === 0 ? (
                  <div className="text-gray-500 dark:text-gray-400 text-center py-4">{t('main.logEmptyShort')}</div>
                ) : (
                  operationLogs.map((log, i) => (
                    <div key={i} className="mb-2 pb-2 border-b border-gray-100 dark:border-gray-800/50">
                      <span className="text-gray-500">[{log.time}]</span> <span className="text-blue-500">{log.user}</span>: <span className="text-gray-800 dark:text-gray-200">{log.action}</span> <span className="text-green-500">({log.result})</span>
                    </div>
                  ))
                )}
             </div>
           </div>
        )}
      </div>
    </div>
      <CreateTableModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreate={handleCreateTable}
        initialDialect={activeDialect}
        dialectLocked
      />
      {/* Confirm Modal */}
      {confirmModal.type && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-xl max-w-md w-full my-auto border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
              <h3 className="text-lg font-bold flex items-center gap-2 text-gray-900 dark:text-white">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                {t('main.confirmTitle')}
              </h3>
              <button onClick={() => setConfirmModal({type: null, items: []})} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 text-gray-700 dark:text-gray-300">
              <p className="mb-4">
                {confirmModal.type === 'empty' ? t('main.confirmEmptyMsg') : t('main.confirmDropMsg')} <strong className="break-all">{confirmModal.items.join(', ')}</strong>?
              </p>
              <div className="flex items-center justify-end gap-3 mt-6">
                <button 
                  onClick={() => setConfirmModal({type: null, items: []})}
                  className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors font-medium"
                >
                  {t('main.confirmCancel')}
                </button>
                <button 
                  onClick={confirmModal.type === 'empty' ? handleBulkEmpty : handleBulkDrop}
                   disabled={bulkLoading}
                   className={`px-4 py-2 text-white font-medium rounded transition-colors disabled:opacity-50 ${confirmModal.type === 'empty' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-red-500 hover:bg-red-600'}`}
                 >
                   {bulkLoading ? t('main.runningBulk') : t('main.confirmYes')}
                 </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}