import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Bell, Settings, User, Moon, Sun, Globe, LogOut, 
  ChevronDown as LucideChevronDown, PanelLeft, PanelRight, ChevronLeft, ChevronRight,
  CheckCheck, Trash2, X, ExternalLink, Check, Circle, RefreshCw, Loader2
} from 'lucide-react';
import { Theme } from '../types';
import { useLanguage, Language, translate } from '../contexts/LanguageContext';
import { api, AuditEntry, ConnectionInfo, PanelUser } from '../api';
import { formatDateTime } from '../intl';

interface Notification {
  id: number;
  title: string;
  text: string;
  time: string;
  read: boolean;
  settingsTab?: string;
  settingsLabel?: string;
}

interface HeaderProps {
  projectName: string;
  theme: Theme;
  toggleTheme: () => void;
  activeDb: string;
  activeConn?: ConnectionInfo | null;
  openSettings: (tab?: string) => void;
  addToast: (msg: string, type: 'success'|'error'|'info') => void;
  isLeftSidebarCollapsed?: boolean;
  toggleLeftSidebar?: () => void;
  isRightSidebarCollapsed?: boolean;
  toggleRightSidebar?: () => void;
  notificationsEnabled: boolean;
  authRequired: boolean;
  user?: PanelUser;
  onLogout: () => void;
}

const NOTIF_READ_KEY = 'mydbroot_notif_read';
const NOTIF_HIDDEN_KEY = 'mydbroot_notif_hidden';

function loadIdSet(key: string): Set<number> {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveIdSet(key: string, set: Set<number>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

// Язык передаётся параметром: обе функции объявлены вне компонента, поэтому
// взять его из хука они не могут, а глобальная переменная снова привязала бы
// даты к русскому формату независимо от выбора языка.
function timeAgo(at: number, lang: Language): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return translate(lang, 'header.justNow');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${translate(lang, 'header.minutesAgo')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${translate(lang, 'header.hoursAgo')}`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ${translate(lang, 'header.daysAgo')}`;
  return formatDateTime(at, lang);
}

const AUDIT_TITLES: Record<string, string> = {
  'conn.create': 'header.auditConnCreate',
  'conn.delete': 'header.auditConnDelete',
  'conn.test': 'header.auditConnTest',
  'db.create': 'header.auditDbCreate',
  'db.drop': 'header.auditDbDrop',
};

function auditToNotification(a: AuditEntry, read: boolean, lang: Language): Notification {
  const ok = a.ok === 1 || a.ok === true;
  const title = `${translate(lang, AUDIT_TITLES[a.action] ?? a.action)}${ok ? '' : ` — ${translate(lang, 'header.failedSuffix')}`}`;
  const detail: string[] = [];
  if (a.target) detail.push(a.target);
  if (a.actor) detail.push(translate(lang, 'header.actorPrefix', { actor: a.actor }));
  if (typeof a.ms === 'number') detail.push(`${a.ms} ${translate(lang, 'header.ms')}`);
  detail.push(formatDateTime(a.at, lang));
  return { id: a.id, title, text: detail.join(' · '), time: timeAgo(a.at, lang), read };
}

export function Header({ 
  projectName,
  theme, 
  toggleTheme, 
  activeDb,
  activeConn,
  openSettings, 
  addToast,
  isLeftSidebarCollapsed,
  toggleLeftSidebar,
  isRightSidebarCollapsed,
  toggleRightSidebar,
  notificationsEnabled,
  authRequired,
  user,
  onLogout
}: HeaderProps) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showNotifModal, setShowNotifModal] = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<Notification | null>(null);
  
  // Реальные уведомления из журнала аудита (/api/audit), без демо-данных
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loadingNotif, setLoadingNotif] = useState(false);
  const [readIds, setReadIds] = useState<Set<number>>(() => loadIdSet(NOTIF_READ_KEY));
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(() => loadIdSet(NOTIF_HIDDEN_KEY));
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);

  const fetchNotifications = useCallback(async () => {
    if (!notificationsEnabled) return;
    setLoadingNotif(true);
    try {
      const rows = await api.audit(undefined, 50);
      const read = loadIdSet(NOTIF_READ_KEY);
      const hidden = loadIdSet(NOTIF_HIDDEN_KEY);
      setNotifications(
        rows
          .filter(r => !hidden.has(r.id))
          .map(r => auditToNotification(r, read.has(r.id), currentLang))
      );
    } catch {
      // audit недоступен — показываем пустой список вместо демо-данных
      setNotifications([]);
    } finally {
      setLoadingNotif(false);
    }
  }, [notificationsEnabled]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const userMenuRef = useRef<HTMLDivElement>(null);
  const notifMenuRef = useRef<HTMLDivElement>(null);

  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  const { t, lang: currentLang, setLang } = useLanguage();

  const languages: { code: Language, name: string }[] = [
    { code: 'ru', name: t('header.langRu') },
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'zh', name: '中文' },
  ];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (notifMenuRef.current && !notifMenuRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
        setSelectMode(false);
        setSelectedIds([]);
      }
      if (langMenuRef.current && !langMenuRef.current.contains(event.target as Node)) {
        setShowLanguageMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllRead = () => {
    // «Прочитаны все» — сообщения исчезают полностью, а не димятся
    const nextHidden = new Set(hiddenIds);
    notifications.forEach(n => nextHidden.add(n.id));
    setHiddenIds(nextHidden);
    saveIdSet(NOTIF_HIDDEN_KEY, nextHidden);
    const nextRead = new Set(readIds);
    notifications.forEach(n => nextRead.add(n.id));
    setReadIds(nextRead);
    saveIdSet(NOTIF_READ_KEY, nextRead);
    setNotifications([]);
    setSelectedIds([]);
    setSelectMode(false);
    addToast(t('header.allReadDone'), 'success');
  };

  const toggleSelectMode = () => {
    setSelectMode(prev => !prev);
    setSelectedIds([]);
  };

  const toggleSelectId = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const selectAll = () => {
    if (selectedIds.length === notifications.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(notifications.map(n => n.id));
    }
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    const next = new Set(hiddenIds);
    selectedIds.forEach(id => next.add(id));
    setHiddenIds(next);
    saveIdSet(NOTIF_HIDDEN_KEY, next);
    setNotifications(prev => prev.filter(n => !selectedIds.includes(n.id)));
    addToast(`Удалено уведомлений: ${selectedIds.length}`, 'info');
    setSelectedIds([]);
    if (selectedIds.length === notifications.length) {
      setSelectMode(false);
    }
  };

  const deleteNotification = (id: number) => {
    const next = new Set(hiddenIds);
    next.add(id);
    setHiddenIds(next);
    saveIdSet(NOTIF_HIDDEN_KEY, next);
    setNotifications(prev => prev.filter(n => n.id !== id));
    addToast(t('header.notificationDeleted'), 'info');
  };

  /** Отметка «прочитано»: и в памяти, и в localStorage (счётчик в шапке). */
  const markNotifRead = useCallback((notif: Notification) => {
    if (!notif.read) {
      const next = new Set(readIds);
      next.add(notif.id);
      setReadIds(next);
      saveIdSet(NOTIF_READ_KEY, next);
    }
    setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
  }, [readIds]);

  const openNotifDetail = (notif: Notification) => {
    if (selectMode) {
      toggleSelectId(notif.id);
      return;
    }
    markNotifRead(notif);
    setSelectedNotif(notif);
    setShowNotifModal(true);
  };

  /**
   * Листание уведомлений в окне просмотра: список может быть на десятки
   * записей, а закрывать и открывать каждое по кнопке «Закрыть» — это десятки
   * кликов вместо одного. Порядок тот же, что и в выпадающем списке: «назад» —
   * предыдущий элемент списка (свежие сверху), «вперёд» — более свежий.
   */
  const notifIndex = selectedNotif ? notifications.findIndex(n => n.id === selectedNotif.id) : -1;
  const goNotif = useCallback((delta: number) => {
    if (!selectedNotif) return;
    const i = notifications.findIndex(n => n.id === selectedNotif.id);
    const next = notifications[i + delta];
    if (i < 0 || !next) return;
    markNotifRead(next);
    setSelectedNotif(next);
  }, [selectedNotif, notifications, markNotifRead]);

  // Стрелки влево/вправо листают, пока окно открыто. В самом окне полей ввода
  // нет, поэтому перехват не мешает вводу.
  useEffect(() => {
    if (!showNotifModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goNotif(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNotif(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showNotifModal, goNotif]);

  return (
    <header className="h-14 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e2330] flex items-center justify-between px-4 shrink-0 transition-colors z-40">
      <div className="flex items-center gap-3">
        {toggleLeftSidebar && (
          <button 
            onClick={toggleLeftSidebar}
            title={isLeftSidebarCollapsed ? "Развернуть боковую панель" : "Свернуть боковую панель (расширить рабочую область)"}
            className={`p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
              isLeftSidebarCollapsed ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 ring-1 ring-red-200 dark:ring-red-800' : 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20'
            }`}
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        )}
        
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-gray-800 dark:text-gray-200 truncate max-w-48">{projectName}</span>
          <span className="text-gray-400 dark:text-gray-500">|</span>
          <span className="font-semibold flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
            {activeConn ? activeConn.name : t('header.noConnection')}
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${activeConn ? 'bg-green-500' : 'bg-gray-400'}`}></span>
          </span>
          {activeConn && (activeConn.host || activeConn.port) && (
            <>
              <span className="text-gray-400 dark:text-gray-500">|</span>
              <span className="text-gray-600 dark:text-gray-400">
                {activeConn.host || 'localhost'}{activeConn.port ? `:${activeConn.port}` : ''}{activeConn.kind ? ` · ${activeConn.kind}` : ''}
              </span>
            </>
          )}
          <span className="text-gray-400 dark:text-gray-500">|</span>
          <span className="text-gray-600 dark:text-gray-400">{t('header.db')}:</span>
          <span className="font-medium text-gray-900 dark:text-white bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded text-xs">{activeDb || '—'}</span>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <div className="relative" ref={langMenuRef}>
          <button onClick={() => setShowLanguageMenu(!showLanguageMenu)} className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title={t('header.language')}>
            <Globe className="w-4 h-4" />
          </button>
          
          {showLanguageMenu && (
            <div className="absolute right-0 mt-2 w-36 bg-white dark:bg-[#1e2330] rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in slide-in-from-top-2 z-50">
              <div className="py-1">
                {languages.map(lang => (
                  <button 
                    key={lang.code}
                    onClick={() => {
                      setLang(lang.code);
                      setShowLanguageMenu(false);
                      addToast(`Language: ${lang.name}`, 'success');
                    }} 
                    className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-800 ${currentLang === lang.code ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    {lang.name}
                    {currentLang === lang.code && <div className="w-1.5 h-1.5 rounded-full bg-blue-600 dark:bg-blue-400"></div>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button 
          onClick={toggleTheme} 
          title={theme === 'dark' ? t('header.lightTheme') : t('header.darkTheme')}
          className="p-1.5 flex items-center gap-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          <span className="text-xs hidden sm:inline-block">{theme === 'dark' ? t('header.lightTheme') : t('header.darkTheme')}</span>
        </button>
        
        <div className="relative" ref={notifMenuRef}>
          <button onClick={() => { const next = !showNotifications; setShowNotifications(next); setSelectMode(false); setSelectedIds([]); if (next) fetchNotifications(); }} className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors relative" title={t('header.notifications')}>
            <Bell className="w-4 h-4" />
            {notificationsEnabled && unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
            )}
          </button>
          
          {showNotifications && (
            <div className="absolute right-0 mt-2 w-96 bg-white dark:bg-[#1e2330] rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in slide-in-from-top-2 z-50">
              {!notificationsEnabled ? (
                <div className="p-6 text-center">
                  <Bell className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('header.notificationsOff')}</p>
                  <button onClick={() => { setShowNotifications(false); openSettings('notifications'); }} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('header.enableInSettings')}</button>
                </div>
              ) : (
                <>
                  <div className="p-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{t('header.notifications')}</span>
                      {unreadCount > 0 && (
                        <span className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full">{t('header.notifNewCount', { count: unreadCount })}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {notifications.length > 0 && (
                        <>
                          <button
                            onClick={fetchNotifications}
                            className="p-1.5 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            title={t('ui.refresh')}
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${loadingNotif ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={toggleSelectMode}
                            className={`p-1.5 rounded text-xs transition-colors ${selectMode ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                            title={selectMode ? t('header.clearSelection') : t('header.selectNotifications')}
                          >
                            <Circle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={markAllRead}
                            className="p-1.5 rounded text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            title={t('header.markAllRead')}
                          >
                            <CheckCheck className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => { setShowNotifications(false); setSelectMode(false); setSelectedIds([]); }}
                        className="p-1.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {selectMode && notifications.length > 0 && (
                    <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800/50 flex items-center justify-between bg-gray-50 dark:bg-gray-900/30">
                      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 dark:border-gray-600"
                          checked={selectedIds.length === notifications.length}
                          onChange={selectAll}
                        />
                        Выбрать все ({selectedIds.length}/{notifications.length})
                      </label>
                      <button
                        onClick={deleteSelected}
                        disabled={selectedIds.length === 0}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${selectedIds.length > 0 ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50' : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'}`}
                      >
                        <Trash2 className="w-3 h-3" /> Удалить ({selectedIds.length})
                      </button>
                    </div>
                  )}

                  <div className="max-h-80 overflow-y-auto">
                    {loadingNotif ? (
                      <div className="p-8 text-center">
                        <Loader2 className="w-6 h-6 text-gray-300 dark:text-gray-600 mx-auto mb-2 animate-spin" />
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t('header.loadingLog')}</p>
                      </div>
                    ) : notifications.length === 0 ? (
                      <div className="p-8 text-center">
                        <Bell className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t('header.noNotifications')}</p>
                      </div>
                    ) : (
                      notifications.map(notif => (
                        <div
                          key={notif.id}
                          className={`p-3 border-b border-gray-100 dark:border-gray-800/50 transition-colors cursor-pointer group ${
                            selectMode
                              ? `hover:bg-blue-50 dark:hover:bg-blue-900/20 ${selectedIds.includes(notif.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`
                              : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                          } ${notif.read ? '' : 'bg-blue-50/30 dark:bg-blue-900/10'}`}
                          onClick={() => openNotifDetail(notif)}
                        >
                          <div className="flex items-start gap-2">
                            {selectMode && (
                              <input
                                type="checkbox"
                                className="mt-0.5 rounded border-gray-300 dark:border-gray-600"
                                checked={selectedIds.includes(notif.id)}
                                onChange={() => toggleSelectId(notif.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {!notif.read && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"></div>}
                                <p className={`text-xs font-medium truncate ${notif.read ? 'text-gray-600 dark:text-gray-400' : 'text-gray-800 dark:text-gray-200'}`}>
                                  {notif.title}
                                </p>
                              </div>
                              <p className="text-[10px] text-gray-400 mt-0.5">{notif.time}</p>
                            </div>
                            {!selectMode && (
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteNotification(notif.id); }}
                                className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-all shrink-0"
                                title={t('ui.remove')}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <button title={t('sidebar.settings')} onClick={() => openSettings('general')} className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <Settings className="w-4 h-4" />
        </button>

        {toggleRightSidebar && (
          <button 
            onClick={toggleRightSidebar}
            title={isRightSidebarCollapsed ? t('header.expandServerPanel') : t('header.collapseServerPanelLong')}
            className={`p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors hidden md:inline-flex ${
              isRightSidebarCollapsed ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 ring-1 ring-red-200 dark:ring-red-800' : 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20'
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        )}
        
        <div className="relative" ref={userMenuRef}>
          <button title={t('header.profile')} onClick={() => setShowUserMenu(!showUserMenu)} className="flex items-center gap-2 pl-2 border-l border-gray-200 dark:border-gray-700 ml-1 cursor-pointer">
            <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300">
              <User className="w-4 h-4" />
            </div>
             <span className="text-sm font-medium text-gray-700 dark:text-gray-300 hidden sm:inline-block">{user?.username || '—'}</span>
            <LucideChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>
          
          {showUserMenu && (
            <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-[#1e2330] rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in slide-in-from-top-2 z-50">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                 <p className="text-sm font-medium text-gray-900 dark:text-white">{user?.username || t('header.user')}</p>
                 <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user?.role || '—'}</p>
              </div>
              <div className="py-1">
                <button onClick={() => {setShowUserMenu(false); openSettings('general');}} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-2">
                  <User className="w-4 h-4 text-gray-400" /> {t('header.profile')}
                </button>
                 {authRequired && (
                   <button onClick={() => {setShowUserMenu(false); onLogout();}} className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-2 border-t border-gray-200 dark:border-gray-800">
                     <LogOut className="w-4 h-4 text-red-500" /> {t('header.logout')}
                   </button>
                 )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showNotifModal && selectedNotif && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-2xl my-auto overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0"></div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate">{selectedNotif.title}</h2>
              </div>
              <button onClick={() => { setShowNotifModal(false); setSelectedNotif(null); }} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{selectedNotif.text}</p>
              <p className="text-xs text-gray-400 mt-4">{selectedNotif.time}</p>
            </div>
            <div className="px-6 py-4 border-t border border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
              <div className="flex items-center gap-1">
                {/* Листание по уведомлениям: показываем и кнопки, и позицию,
                    иначе «49 новых» выглядит списком без ориентира. */}
                {notifIndex >= 0 && notifications.length > 1 && (
                  <>
                    <button
                      onClick={() => goNotif(-1)}
                      disabled={notifIndex === 0}
                      title={t('header.notifPrev')}
                      aria-label={t('header.notifPrev')}
                      className="p-1.5 rounded-md text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums px-1">{notifIndex + 1} / {notifications.length}</span>
                    <button
                      onClick={() => goNotif(1)}
                      disabled={notifIndex >= notifications.length - 1}
                      title={t('header.notifNext')}
                      aria-label={t('header.notifNext')}
                      className="p-1.5 rounded-md text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
              <button onClick={() => { setShowNotifModal(false); setSelectedNotif(null); }} className="px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{t('header.close')}</button>
              {selectedNotif.settingsTab && (
                <button
                  onClick={() => {
                    setShowNotifModal(false);
                    setSelectedNotif(null);
                    setShowNotifications(false);
                    openSettings(selectedNotif.settingsTab);
                  }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" /> {selectedNotif.settingsLabel || t('header.goToSettings')}
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
