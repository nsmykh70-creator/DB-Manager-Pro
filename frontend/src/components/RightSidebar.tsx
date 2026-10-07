import React, { useRef, useState, useEffect, useCallback } from 'react';
import { 
  Boxes, Database, Plus, Upload, Download, RefreshCw, Settings, Server, Clock, User,
  ChevronRight, ChevronLeft, Loader2, AlertCircle, Ban, UserPlus, Trash2
} from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { api, errorText, ServerStatus, DbUser, PanelUser } from '../api';

interface RightSidebarProps {
  addToast: (msg: string, type: 'success'|'error'|'info') => void;
  openSettings: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  connId?: string | null;
  connKind?: string | null;
  activeDb?: string;
  dbVersion?: number;
  onOpenCreateDb?: () => void;
  onOpenModels?: () => void;
  onOpenCreateTable?: () => void;
  canCreateDatabase?: boolean;
  canCreateTable?: boolean;
  userRole?: PanelUser['role'];
  connectionReadOnly?: boolean;
  onTablesChanged?: () => void;
}

export function RightSidebar({
  addToast, openSettings, isCollapsed = false, onToggleCollapse, connId, connKind, activeDb, dbVersion, onOpenModels, onOpenCreateDb, onOpenCreateTable,
  canCreateDatabase = true, canCreateTable = true, userRole, connectionReadOnly, onTablesChanged
}: RightSidebarProps) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [importing, setImporting] = useState(false);

  const statusReqRef = useRef(0);
  const connIdRef = useRef(connId);
  connIdRef.current = connId;
  const fetchStatus = useCallback(async () => {
    if (!connId) return;
    const myReq = ++statusReqRef.current;
    const forConn = connId;
    setLoadingStatus(true);
    try {
      const status = await api.serverStatus(forConn);
      if (myReq !== statusReqRef.current) return;
      if (forConn !== connIdRef.current) return;
      setServerStatus(status);
    } catch (e: any) {
      // Silent fail — status is optional
    } finally {
      if (myReq === statusReqRef.current) setLoadingStatus(false);
    }
  }, [connId, dbVersion]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Kill доступен только админу на изменяемом подключении: бэкенд
  // отвечает 403 на /kill для остальных ролей и read-only коннектов.
  const canKill = userRole === 'admin' && !connectionReadOnly;
  const [killingId, setKillingId] = useState<string | null>(null);

  const handleKill = async (procId: string) => {
    if (!connId || !canKill) return;
    if (!confirm(t('right.killConfirm', { id: procId }))) return;
    setKillingId(procId);
    try {
      await api.killQuery(connId, procId);
      addToast(t('right.killDone', { id: procId }), 'success');
      fetchStatus();
    } catch (e: any) {
      addToast(t('right.killFailed') + ': ' + e.message, 'error');
    } finally {
      setKillingId(null);
    }
  };

  // Пользователи БД: реальные /dbusers. Не все драйверы их умеют —
  // тогда показываем честное сообщение вместо пустого списка.
  const canManageDbUsers = userRole === 'admin' && !connectionReadOnly;
  const [dbUsers, setDbUsers] = useState<DbUser[] | null>(null);
  const [dbUsersError, setDbUsersError] = useState('');
  const [dbUsersLoading, setDbUsersLoading] = useState(false);
  const [newDbUser, setNewDbUser] = useState({ username: '', password: '', host: '' });
  const [dbUserBusy, setDbUserBusy] = useState(false);
  const dbUsersReqRef = useRef(0);

  const fetchDbUsers = useCallback(async () => {
    if (!connId) {
      setDbUsers(null);
      setDbUsersError('');
      return;
    }
    const myReq = ++dbUsersReqRef.current;
    setDbUsersLoading(true);
    try {
      const users = await api.dbUsers(connId);
      if (myReq !== dbUsersReqRef.current) return;
      setDbUsers(users);
      setDbUsersError('');
    } catch (e: any) {
      if (myReq !== dbUsersReqRef.current) return;
      setDbUsers(null);
      setDbUsersError(e.message || t('right.dbUsersUnsupported'));
    } finally {
      if (myReq === dbUsersReqRef.current) setDbUsersLoading(false);
    }
  }, [connId]);

  useEffect(() => { fetchDbUsers(); }, [fetchDbUsers, dbVersion]);

  const handleCreateDbUser = async () => {
    if (!connId || !canManageDbUsers) return;
    const username = newDbUser.username.trim();
    if (!username || !newDbUser.password) {
      addToast(t('right.dbUserFill'), 'error');
      return;
    }
    setDbUserBusy(true);
    try {
      // Хост — только MySQL/MariaDB (user@host); остальным драйверам бэкенд
      // его игнорирует, поэтому поле показываем лишь для этих типов.
      const host = (connKind === 'mysql' || connKind === 'mariadb') ? (newDbUser.host.trim() || undefined) : undefined;
      await api.createDbUser(connId, username, newDbUser.password, activeDb || undefined, host);
      setNewDbUser({ username: '', password: '', host: '' });
      await fetchDbUsers();
      addToast(t('right.dbUserCreated', { name: username }), 'success');
    } catch (e: any) {
      addToast(t('right.dbUserCreateFailed') + ': ' + e.message, 'error');
    } finally {
      setDbUserBusy(false);
    }
  };

  const handleDropDbUser = async (username: string, host?: string) => {
    if (!connId || !canManageDbUsers) return;
    if (!confirm(t('right.dbUserDropConfirm', { name: username }))) return;
    setDbUserBusy(true);
    try {
      await api.dropDbUser(connId, username, activeDb || undefined, host || undefined);
      await fetchDbUsers();
      addToast(t('right.dbUserDropped', { name: username }), 'success');
    } catch (e: any) {
      addToast(t('right.dbUserDropFailed') + ': ' + e.message, 'error');
    } finally {
      setDbUserBusy(false);
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  // Новый ключ Redis: у ключей нет конструктора таблиц, поэтому спрашиваем имя
  // и значение промптами, как импорт спрашивает таблицу, а клон — имя копии.
  // Пишем через insertRow (SET для скаляра); редактор и админ могут, readonly — нет.
  const handleCreateRedisKey = async () => {
    if (!connId || userRole === 'readonly' || connectionReadOnly) return;
    const key = window.prompt(t('right.redisKeyName'), '');
    if (key === null) return;
    if (!key.trim()) { addToast(t('right.redisKeyNameRequired'), 'error'); return; }
    const value = window.prompt(t('right.redisKeyValue'), '');
    if (value === null) return;
    try {
      await api.insertRow(connId, activeDb || '0', key.trim(), { value });
      addToast(t('right.redisKeyCreated', { name: key.trim() }), 'success');
      onTablesChanged?.();
    } catch (e: any) {
      addToast(t('right.errorRedisKeyCreate') + errorText(e), 'error');
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !connId) return;
    setImporting(true);
    try {
      const text = await file.text();
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
       let format: 'sql' | 'csv' | 'json' = 'sql';
       if (ext === 'csv') format = 'csv';
       else if (ext === 'json') format = 'json';
       let targetTable: string | undefined;
       if (format !== 'sql') {
         if (!activeDb) {
           addToast(t('right.importPickDb'), 'error');
           return;
         }
         const tableNames = await api.tables(connId, activeDb);
         targetTable = window.prompt(`Импорт ${format.toUpperCase()} в какую таблицу?\nДоступные таблицы: ${tableNames.join(', ')}`) || undefined;
         if (!targetTable || !tableNames.includes(targetTable)) {
           addToast(t('right.importNoTable'), 'info');
           return;
         }
       }
       const result = await api.importData(connId, format, text, activeDb || undefined, targetTable);
      addToast(t('right.importDone', { count: result.inserted ?? result.statements ?? 0, ms: result.execMs.toFixed(1) }), 'success');
    } catch (e: any) {
      addToast(t('right.errorImport') + e.message, 'error');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = async () => {
    if (!connId || !activeDb) { addToast(t('right.exportPickDb'), 'error'); return; }
    try {
      addToast(t('right.exportPreparing'), 'info');
      const tableNames = await api.tables(connId, activeDb);
      const results = await Promise.allSettled(tableNames.map(async (tableName) => {
        const resp = await api.exportTable(connId, activeDb, tableName, 'csv');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${activeDb}_${tableName}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        return tableName;
      }));
      const exported = results.flatMap((result, index) => result.status === 'fulfilled' ? [tableNames[index]] : []);
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [tableNames[index]] : []);
      if (exported.length) addToast(t('right.exported', { count: exported.length }), 'success');
      if (failed.length) addToast(t('right.exportFailed', { list: failed.join(', ') }), 'error');
    } catch (e: any) {
      addToast(t('right.errorExport') + e.message, 'error');
    }
  };

  const handleCheckDb = async () => {
    if (!connId) { addToast(t('right.noConnection'), 'error'); return; }
    try {
      const result = await api.testConnection(connId);
      addToast(t('right.testOk', { ms: result.latencyMs }), 'success');
      fetchStatus();
    } catch (e: any) {
      addToast(t('right.errorTest') + e.message, 'error');
    }
  };

  // Корзина Oracle необратимо: спрашиваем дважды — сначала confirm, потом сервер
  // делает PURGE RECYCLEBIN. После — обновить статус (размеры) и список таблиц.
  const handlePurgeRecycleBin = async () => {
    if (!connId || userRole === 'readonly' || connectionReadOnly) return;
    if (!confirm(t('right.purgeConfirm'))) return;
    try {
      await api.purgeRecycleBin(connId);
      addToast(t('right.purgeDone'), 'success');
      fetchStatus();
      onTablesChanged?.();
    } catch (e: any) {
      addToast(t('right.errorPurge') + errorText(e), 'error');
    }
  };

  const formatUptime = (sec?: number) => {
    if (!sec) return '-';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return t('right.uptime', { d: d, h: h, m: m });
  };

  const formatBytes = (b: number) => {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KiB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MiB';
    return (b / 1073741824).toFixed(2) + ' GiB';
  };

  // Collapsed View
  if (isCollapsed) {
    return (
      <div className="w-12 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 flex flex-col items-center py-3 text-sm h-full shrink-0 select-none hidden md:flex transition-all duration-200 text-gray-900 dark:text-gray-100">
        <button onClick={onToggleCollapse} title={t('right.expandServerInfo')} className="p-1.5 rounded-md text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors mb-3">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-4" title={serverStatus?.version || t('right.server')}>
          <Server className="w-4 h-4" />
        </div>
        <button onClick={handleImportClick} title={t('right.import')} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-blue-600 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors mb-2">
          {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        </button>
        <button onClick={handleExport} title={t('right.export')} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-blue-600 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors mb-2">
          <Download className="w-4 h-4" />
        </button>
        <button onClick={openSettings} title={t('right.backup')} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-blue-600 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors mb-2">
          <Settings className="w-4 h-4" />
        </button>
        <div onClick={onToggleCollapse} className="flex-1 flex items-center justify-center cursor-pointer group py-2" title={t('right.clickToExpand')}>
          <span className="[writing-mode:vertical-lr] rotate-180 text-[11px] font-medium tracking-wider text-gray-400 group-hover:text-blue-500 uppercase transition-colors">
            {t('right.serverInfo')}
          </span>
        </div>
        <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".csv,.sql,.json" />
      </div>
    );
  }

  // Expanded View
  return (
    <div className="w-72 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/30 flex flex-col h-full text-sm overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden hidden xl:flex shrink-0 transition-all duration-200 text-gray-900 dark:text-gray-100">
      <div className="p-3.5 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800 dark:text-gray-200">{t('right.serverInfo')}</h3>
          <div className="flex items-center gap-1">
            <button onClick={fetchStatus} title={t('ui.refresh')} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? 'animate-spin' : ''}`} />
            </button>
            {onToggleCollapse && (
              <button onClick={onToggleCollapse} title={t('right.collapseServer')} className="p-1.5 rounded-md text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {!connId ? (
          <div className="text-center py-4 text-gray-400">
            <Server className="w-6 h-6 mx-auto mb-1 opacity-40" />
            <p className="text-xs">{t('right.noActiveConnection')}</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <Server className="w-4 h-4" />
                <span>{t('right.server')}</span>
              </div>
              <span className="text-gray-800 dark:text-gray-200 font-mono">{serverStatus?.version?.split(' ')[0] || '...'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <Database className="w-4 h-4" />
                <span>{t('right.databasesOnServer')}</span>
              </div>
              <span className="text-gray-800 dark:text-gray-200 font-mono">{serverStatus?.dbSizes?.length ?? '-'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <User className="w-4 h-4" />
                <span>{t('ui.connections')}</span>
              </div>
              <span className="text-gray-800 dark:text-gray-200">{serverStatus?.connections ?? '-'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <Clock className="w-4 h-4" />
                <span>{t('right.uptime')}</span>
              </div>
              <span className="text-gray-800 dark:text-gray-200">{formatUptime(serverStatus?.uptimeSec)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <AlertCircle className="w-4 h-4" />
                <span>{t('right.slowQueries')}</span>
              </div>
              <span className="text-gray-800 dark:text-gray-200">{serverStatus?.slowQueries ?? 0}</span>
            </div>
          </div>
        )}
      </div>

      {serverStatus?.dbSizes && serverStatus.dbSizes.length > 0 && (
        <div className="p-3.5 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-2 text-xs uppercase tracking-wide">{t('right.databases')}</h3>
          <div className="space-y-1.5">
            {serverStatus.dbSizes.map(db => (
              <div key={db.db} className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                <div className="flex items-center gap-2 truncate">
                  <Database className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="truncate text-gray-700 dark:text-gray-300">{db.db}</span>
                </div>
                <span className="text-gray-400 shrink-0 ml-2">{formatBytes(db.bytes)}{db.tables ? t('right.tablesCount', { count: db.tables }) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {serverStatus?.processlist && serverStatus.processlist.length > 0 && (
        <div className="p-3.5 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-2 text-xs uppercase tracking-wide">{t('right.processes')}</h3>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {serverStatus.processlist.slice(0, 10).map(proc => (
              <div key={proc.id} className="text-[11px] p-1.5 rounded bg-gray-100 dark:bg-gray-800/50 flex flex-col gap-0.5 text-gray-900 dark:text-gray-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-500 dark:text-gray-400">#{proc.id} {proc.user || '-'}</span>
                  <span className="flex items-center gap-2">
                    {proc.timeSec ? <span className="text-gray-400">{proc.timeSec}s</span> : null}
                    {canKill && (
                      <button
                        onClick={() => void handleKill(proc.id)}
                        disabled={killingId === proc.id}
                        title={t('right.kill')}
                        className="p-0.5 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-40"
                      >
                        {killingId === proc.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                      </button>
                    )}
                  </span>
                </div>
                {proc.query && <p className="text-gray-600 dark:text-gray-400 font-mono truncate">{proc.query}</p>}
              </div>
            ))}
          </div>
          {!canKill && <p className="mt-2 text-[10px] text-gray-400">{t('right.killAdminOnly')}</p>}
        </div>
      )}

      {connId && (
        <div className="p-3.5 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wide">{t('right.dbUsers')}</h3>
            <button onClick={() => void fetchDbUsers()} title={t('right.refresh')} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${dbUsersLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {dbUsersError ? (
             <p className="text-[11px] text-amber-600 dark:text-amber-400">{dbUsersError || t('right.dbUsersUnsupported')}</p>
          ) : !dbUsers ? (
            <p className="text-[11px] text-gray-400">{dbUsersLoading ? t('right.dbUsersLoading') : '-'}</p>
          ) : dbUsers.length === 0 ? (
            <p className="text-[11px] text-gray-400">{t('right.dbUsersEmpty')}</p>
          ) : (
             <div className="space-y-1 max-h-40 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {dbUsers.map(user => (
                <div key={`${user.username}@${user.host ?? ''}`} className="flex items-center justify-between gap-2 text-[11px] p-1.5 rounded bg-gray-100 dark:bg-gray-800/50 text-gray-900 dark:text-gray-100">
                  <span className="truncate text-gray-700 dark:text-gray-300">{user.username}{user.host ? `@${user.host}` : ''}</span>
                  {canManageDbUsers && (
                    <button
                      onClick={() => void handleDropDbUser(user.username, user.host)}
                      disabled={dbUserBusy}
                      title={t('right.dbUserDrop')}
                      className="p-0.5 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-40 shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManageDbUsers && (
            <div className="mt-2 flex items-center gap-1">
              <input
                value={newDbUser.username}
                onChange={e => setNewDbUser(prev => ({ ...prev, username: e.target.value }))}
                placeholder={t('right.dbUserName')}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-1.5 py-1 text-[11px]"
              />
              {(connKind === 'mysql' || connKind === 'mariadb') && (
                <input
                  value={newDbUser.host}
                  onChange={e => setNewDbUser(prev => ({ ...prev, host: e.target.value }))}
                  placeholder={t('right.dbUserHost')}
                  title={t('right.dbUserHost')}
                  className="w-16 shrink-0 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-1.5 py-1 text-[11px]"
                />
              )}
              <input
                type="password"
                value={newDbUser.password}
                onChange={e => setNewDbUser(prev => ({ ...prev, password: e.target.value }))}
                placeholder={t('right.dbUserPassword')}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-1.5 py-1 text-[11px]"
              />
              <button
                onClick={() => void handleCreateDbUser()}
                disabled={dbUserBusy}
                title={t('right.dbUserCreate')}
                className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 shrink-0"
              >
                {dbUserBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
              </button>
            </div>
          )}
          {connId && !canManageDbUsers && <p className="mt-2 text-[10px] text-gray-400">{t('right.dbUsersAdminOnly')}</p>}
        </div>
      )}

      <div className="p-4 flex-1">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-3">{t('right.quickActions')}</h3>
        <div className="space-y-1">
           {canCreateDatabase && <button title={t('right.newDb')} onClick={() => onOpenCreateDb ? onOpenCreateDb() : addToast(t('right.createDbHint'), 'info')} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors">
             <Plus className="w-4 h-4 text-gray-500 dark:text-gray-400" />
             <span>{t('right.newDb')}</span>
           </button>}
           {canCreateTable && <button title={t('right.newTable')} onClick={() => onOpenCreateTable ? onOpenCreateTable() : addToast(t('right.createTableHint'), 'info')} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors">
             <Plus className="w-4 h-4 text-gray-500 dark:text-gray-400" />
             <span>{t('right.newTable')}</span>
           </button>}
           {connKind === 'redis' && userRole !== 'readonly' && !connectionReadOnly && <button title={t('right.redisNewKey')} onClick={() => void handleCreateRedisKey()} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors">
             <Plus className="w-4 h-4 text-gray-500 dark:text-gray-400" />
             <span>{t('right.redisNewKey')}</span>
           </button>}
          {onOpenModels && <button title={t('right.projectModelsHint')} onClick={() => onOpenModels()} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
            <Boxes className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <span>{t('ui.projectModels')}</span>
          </button>}
          <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>
          <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".csv,.sql,.json" />
          <button title={t('right.import')} onClick={handleImportClick} disabled={importing || !connId} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50">
            {importing ? <Loader2 className="w-4 h-4 text-gray-500 dark:text-gray-400 animate-spin" /> : <Upload className="w-4 h-4 text-gray-500" />}
            <span>{importing ? t('right.importing') : t('right.import')}</span>
          </button>
          <button title={t('right.export')} onClick={handleExport} disabled={!connId || !activeDb} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50">
            <Download className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <span>{t('right.export')}</span>
          </button>
          <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>
          <button title={t('right.checkDb')} onClick={handleCheckDb} disabled={!connId} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50">
            <RefreshCw className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <span>{t('right.checkDb')}</span>
          </button>
          {connKind === 'oracle' && userRole !== 'readonly' && !connectionReadOnly && (
            <button title={t('right.purgeRecycle')} onClick={() => void handlePurgeRecycleBin()} disabled={!connId} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50">
              <Trash2 className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span>{t('right.purgeRecycle')}</span>
            </button>
          )}
          <button title={t('right.backup')} onClick={openSettings} className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors">
            <Settings className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <span>{t('right.backup')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
