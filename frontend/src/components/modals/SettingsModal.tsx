import React, { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { X, Save, Shield, HardDrive, Settings, User, Bell } from 'lucide-react';
import { api, AppSettings, BackupSchedule, DbKind, PanelUser } from '../../api';
import { Theme } from '../../types';
import { ALL_KINDS, kindLabel } from '../../engineKinds';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  initialTab?: string;
  toastsEnabled: boolean;
  setToastsEnabled: (enabled: boolean) => void;
  toastDuration: number;
  setToastDuration: (duration: number) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  connId?: string | null;
  activeDb?: string;
  connKind?: DbKind;
  onSaved?: (settings: AppSettings) => void;
}

export function SettingsModal({ isOpen, onClose, addToast, initialTab = 'general', toastsEnabled, setToastsEnabled, toastDuration, setToastDuration, notificationsEnabled, setNotificationsEnabled, theme, setTheme, connId, activeDb, connKind, onSaved }: SettingsModalProps) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'editor' as PanelUser['role'] });
  const [editingUser, setEditingUser] = useState<(PanelUser & { password: string }) | null>(null);
  const [backupSchedules, setBackupSchedules] = useState<BackupSchedule[]>([]);
  const [projectName, setProjectName] = useState('DB Manager Pro');
  const [timezone, setTimezone] = useState('UTC');
  const [checkUpdates, setCheckUpdates] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  // Какие типы СУБД показывать в боковых панелях. Пустой массив означает «все»,
  // поэтому начинаем с полного списка, а не с [].
  const [enabledKinds, setEnabledKinds] = useState<DbKind[]>([...ALL_KINDS]);
  const [scheduleForm, setScheduleForm] = useState({ format: 'sql' as 'sql' | 'json', intervalMin: 1440, keepLast: 7 });
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const fetchBackups = React.useCallback(async () => {
    if (!connId) {
      setBackupSchedules([]);
      return;
    }
    try {
      setBackupSchedules(await api.backupSchedules(connId));
    } catch {
      setBackupSchedules([]);
    }
  }, [connId]);

  React.useEffect(() => {
    if (isOpen && activeTab === 'backup') fetchBackups();
  }, [activeTab, fetchBackups, isOpen]);

  const backupFormat: 'sql' | 'json' = connKind === 'mongodb' ? 'json' : 'sql';
  const selectedFormat: 'sql' | 'json' = connKind === 'mongodb' ? 'json' : scheduleForm.format;

  React.useEffect(() => {
    if (connKind === 'mongodb') setScheduleForm(prev => ({ ...prev, format: 'json' }));
  }, [connKind]);

  const handleCreateSchedule = async () => {
    if (!connId) {
      addToast(t('settings.pickConnection'), 'error');
      return;
    }
    setScheduleBusy(true);
    try {
      await api.createBackupSchedule(connId, activeDb, selectedFormat, scheduleForm.intervalMin, scheduleForm.keepLast);
      await fetchBackups();
      addToast(t('settings.scheduleCreated'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorCreateSchedule') + e.message, 'error');
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleToggleSchedule = async (schedule: BackupSchedule) => {
    setScheduleBusy(true);
    try {
      await api.updateBackupSchedule(schedule.id, { enabled: !schedule.enabled });
      await fetchBackups();
      addToast(schedule.enabled ? t('settings.scheduleOff') : t('settings.scheduleOn'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorToggleSchedule') + e.message, 'error');
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleDeleteSchedule = async (schedule: BackupSchedule) => {
    if (!confirm(t('settings.confirmDropSchedule'))) return;
    setScheduleBusy(true);
    try {
      await api.deleteBackupSchedule(schedule.id);
      await fetchBackups();
      addToast(t('settings.scheduleDeleted'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorDropSchedule') + e.message, 'error');
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleRunBackup = async () => {
    if (!connId) {
      addToast(t('settings.pickConnection'), 'error');
      return;
    }
    try {
      const schedule = backupSchedules.find((item) => item.connId === connId && item.db === (activeDb ?? '') && item.format === backupFormat)
        ?? await api.createBackupSchedule(connId, activeDb, backupFormat, scheduleForm.intervalMin, scheduleForm.keepLast);
      const result = await api.runBackup(schedule.id) as { ok?: number; error?: string | null };
      if (result.ok === 0) throw new Error(result.error || t('settings.backupFailed'));
      await fetchBackups();
      addToast(t('settings.backupDone'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorBackup') + e.message, 'error');
    }
  };

  React.useEffect(() => {
    if (!isOpen) return;
    setSettingsLoading(true);
    api.settings()
      .then((settings) => {
         setProjectName(settings.projectName);
         setTimezone(settings.timezone);
         setTheme(settings.theme);
         setCheckUpdates(settings.checkUpdates);
        setToastsEnabled(settings.toastsEnabled);
        setToastDuration(settings.toastDuration);
        setNotificationsEnabled(settings.notificationsEnabled);
        setEnabledKinds(settings.enabledKinds?.length ? settings.enabledKinds : [...ALL_KINDS]);
      })
      .catch((e) => addToast(t('settings.errorLoad') + e.message, 'error'))
      .finally(() => setSettingsLoading(false));
  }, [addToast, isOpen, setNotificationsEnabled, setTheme, setToastDuration, setToastsEnabled]);

  const fetchUsers = React.useCallback(async () => {
    setUsersLoading(true);
    try {
      setUsers(await api.authUsers());
    } catch {
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isOpen && activeTab === 'users') fetchUsers();
  }, [activeTab, fetchUsers, isOpen]);

  const handleDeleteUser = async (id: string) => {
    if (!confirm(t('settings.confirmDeleteUser'))) return;
    try {
      await api.deleteAuthUser(id);
      setUsers(prev => prev.filter(user => user.id !== id));
      addToast(t('settings.userDeleted'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorDeleteUser') + e.message, 'error');
    }
  };

  const handleCreateUser = async () => {
    if (!newUser.username || !newUser.password) {
      addToast(t('settings.fillUserFields'), 'error');
      return;
    }
    try {
      await api.createAuthUser(newUser.username, newUser.password, newUser.role);
      setNewUser({ username: '', password: '', role: 'editor' });
      await fetchUsers();
      addToast(t('settings.userCreated'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorCreateUser') + e.message, 'error');
    }
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;
    if (!editingUser.username.trim()) {
      addToast(t('settings.enterLogin'), 'error');
      return;
    }
    try {
      await api.updateAuthUser(editingUser.id, {
        username: editingUser.username.trim(),
        role: editingUser.role,
        ...(editingUser.password ? { password: editingUser.password } : {}),
      });
      setEditingUser(null);
      await fetchUsers();
      addToast(t('settings.userUpdated'), 'success');
    } catch (e: any) {
      addToast(t('settings.errorUpdateUser') + e.message, 'error');
    }
  };

  // Update internal state when initialTab changes
  React.useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  if (!isOpen) return null;

  const toggleKind = (kind: DbKind) => {
    setEnabledKinds(prev => (prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind]));
  };

  const handleSave = async () => {
    try {
       const saved = await api.saveSettings({ projectName, timezone, theme, checkUpdates, toastsEnabled, toastDuration, notificationsEnabled, enabledKinds });
      // Отдаём сохранённые значения наверх, чтобы projectName/тема в App
      // обновились сразу, а не после переавторизации
      onSaved?.(saved);
      addToast(t('settings.saved'), 'success');
      onClose();
    } catch (e: any) {
      addToast(t('settings.errorSave') + e.message, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-6xl h-[700px] max-h-[92vh] my-auto flex overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
        
        {/* Settings Sidebar */}
        <div className="w-64 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 p-4 flex flex-col gap-2 shrink-0 text-gray-900 dark:text-gray-100">
          <h2 className="font-bold text-lg text-gray-900 dark:text-white mb-4 px-2">{t('settings.title')}</h2>
          
          <button 
            onClick={() => setActiveTab('general')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'general' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          >
            <Settings className="w-4 h-4" />{t('settings.navGeneral')}</button>
          
          <button 
            onClick={() => setActiveTab('notifications')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'notifications' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          >
            <Bell className="w-4 h-4" />{t('settings.navNotifications')}</button>
          
          <button 
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'security' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          >
            <Shield className="w-4 h-4" />{t('settings.navSecurity')}</button>

          <button 
            onClick={() => setActiveTab('backup')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'backup' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          >
            <HardDrive className="w-4 h-4" />{t('settings.navBackup')}</button>

          <button 
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'users' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          >
            <User className="w-4 h-4" />{t('settings.navUsers')}</button>
        </div>

        {/* Settings Content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {activeTab === 'general' && t('settings.tabGeneralTitle')}
              {activeTab === 'notifications' && t('settings.tabNotificationsTitle')}
              {activeTab === 'security' && t('settings.tabSecurityTitle')}
              {activeTab === 'backup' && t('settings.tabBackupTitle')}
              {activeTab === 'users' && t('settings.tabUsersTitle')}
            </h3>
            <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6 flex-1 overflow-y-auto">
            {activeTab === 'general' && (
              <div className="space-y-6 max-w-lg">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.projectName')}</label>
                   <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} disabled={settingsLoading} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-60" />
                </div>
                 <div className="space-y-1.5">
                   <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.theme')}</label>
                   <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} disabled={settingsLoading} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-60">
                     <option value="dark">{t('settings.themeDark')}</option>
                     <option value="light">{t('settings.themeLight')}</option>
                   </select>
                 </div>
                 <div className="space-y-1.5">
                   <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.serverTimezone')}</label>
                   <select value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={settingsLoading} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-60">
                     <option value="UTC">UTC (Coordinated Universal Time)</option>
                     <option value="Europe/Moscow">Europe/Moscow</option>
                     <option value="America/New_York">America/New_York</option>
                   </select>
                </div>
                <div className="space-y-1.5 mt-6">
                  <h4 className="font-medium text-gray-900 dark:text-white mb-2">{t('settings.engines')}</h4>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('settings.enginesHint')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ALL_KINDS.map(kind => {
                      const on = enabledKinds.includes(kind);
                      return (
                        <button
                          key={kind}
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={kindLabel(kind)}
                          disabled={settingsLoading}
                          onClick={() => toggleKind(kind)}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 disabled:opacity-60 text-left"
                        >
                          <span className="text-sm text-gray-700 dark:text-gray-300">{kindLabel(kind)}</span>
                          <span
                            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                          >
                            <span
                              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {enabledKinds.length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">{t('settings.enginesNone')}</p>
                  )}
                </div>
                <div className="space-y-1.5 mt-6">
                  <h4 className="font-medium text-gray-900 dark:text-white mb-2">{t('settings.navNotifications')}</h4>
                  <label className="flex items-center gap-2 cursor-pointer mb-3">
                    <input type="checkbox" className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" checked={toastsEnabled} onChange={(e) => setToastsEnabled(e.target.checked)} />
                    <span className="text-gray-700 dark:text-gray-300 text-sm">{t('settings.toastsEnabled')}</span>
                  </label>
                  {toastsEnabled && (
                    <div className="space-y-1.5 pl-6 border-l-2 border-gray-200 dark:border-gray-800">
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Длительность показа (в миллисекундах)</label>
                      <input 
                        type="number" 
                        value={toastDuration}
                        onChange={(e) => setToastDuration(Number(e.target.value))}
                        step="500"
                        min="0"
                        className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:border-blue-500 outline-none" 
                      />
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.toastZeroHint')}</p>
                    </div>
                  )}
                </div>
                
                <label className="flex items-center gap-2 cursor-pointer mt-6 border-t border-gray-200 dark:border-gray-800 pt-6">
                   <input type="checkbox" checked={checkUpdates} onChange={(e) => setCheckUpdates(e.target.checked)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-gray-700 dark:text-gray-300 text-sm">{t('settings.checkUpdates')}</span>
                </label>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6 max-w-lg">
                <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/30">
                  <div className="flex items-center gap-3 mb-2">
                    <Bell className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    <h4 className="font-medium text-blue-800 dark:text-blue-300">{t('settings.notificationCenter')}</h4>
                  </div>
                  <p className="text-sm text-blue-600/80 dark:text-blue-400/80">{t('settings.notificationCenterHint')}</p>
                </div>

                <div className="space-y-4">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-gray-700 dark:text-gray-300 text-sm font-medium">{t('settings.enableNotifications')}</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t('settings.showInHeader')}</p>
                    </div>
                    <div className="relative">
                      <input type="checkbox" className="sr-only peer" checked={notificationsEnabled} onChange={(e) => setNotificationsEnabled(e.target.checked)} />
                      <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 rounded-full peer peer-checked:bg-blue-600 transition-colors text-gray-900 dark:text-gray-100"></div>
                      <div className="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow peer-checked:translate-x-full transition-transform"></div>
                    </div>
                  </label>

                   {notificationsEnabled && (
                     <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.enabledHint')}</p>
                   )}
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6 max-w-lg">
                <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/30">
                  <h4 className="font-medium text-blue-800 dark:text-blue-300 mb-2">Двухфакторная аутентификация (2FA)</h4>
                  <p className="text-sm text-blue-600/80 dark:text-blue-400/80 mb-3">{t('settings.twofaHint')}</p>
                   <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('settings.twofaMissing')}</div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Таймаут сессии (минуты)</label>
                   <input type="number" value="30" disabled className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#151923] text-gray-500 dark:text-gray-400 outline-none" />
                   <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.jwtTimeout')}</p>
                </div>
              </div>
            )}

             {activeTab === 'backup' && (
               <div className="space-y-6 max-w-lg">
                 <div className="space-y-3">
                   <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.newSchedule')}</label>
                   <div className="grid grid-cols-3 gap-2">
                     <select value={selectedFormat} onChange={(e) => setScheduleForm(prev => ({ ...prev, format: e.target.value as 'sql' | 'json' }))} disabled={connKind === 'mongodb' || scheduleBusy} className="px-2 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-sm">
                       {connKind !== 'mongodb' && <option value="sql">SQL</option>}
                       <option value="json">{t('main.json')}</option>
                     </select>
                     <input type="number" min="5" step="5" value={scheduleForm.intervalMin} onChange={(e) => setScheduleForm(prev => ({ ...prev, intervalMin: Number(e.target.value) }))} disabled={scheduleBusy} className="px-2 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-sm" aria-label={t('settings.intervalMinutes')} />
                     <input type="number" min="1" max="50" value={scheduleForm.keepLast} onChange={(e) => setScheduleForm(prev => ({ ...prev, keepLast: Number(e.target.value) }))} disabled={scheduleBusy} className="px-2 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-sm" aria-label={t('settings.keepCopies')} />
                   </div>
                   <div className="flex items-center gap-2">
                     <button onClick={handleCreateSchedule} disabled={!connId || scheduleBusy} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 rounded-md text-sm font-medium">{t('settings.createSchedule')}</button>
                     <button onClick={handleRunBackup} disabled={!connId || scheduleBusy} className="bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 border border-gray-300 dark:border-gray-700 px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50">{t('settings.backupNow')}</button>
                   </div>
                   {connKind === 'mongodb' && <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.mongoJsonOnly')}</p>}
                 </div>

                 <div className="space-y-2">
                   <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.backupSchedules')}</label>
                   {backupSchedules.length === 0 ? (
                     <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.noSchedules')}</p>
                   ) : (
                     <div className="space-y-2">
                       {backupSchedules.map(schedule => (
                         <div key={schedule.id} className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm">
                           <div className="flex items-center justify-between gap-2">
                             <span className="truncate">{schedule.db || t('settings.allDatabases')} · {schedule.format} · каждые {schedule.intervalMin} мин. · хранить {schedule.keepLast}</span>
                             <span className={`text-xs shrink-0 ${schedule.enabled ? 'text-green-600' : 'text-gray-400'}`}>{schedule.enabled ? t('settings.scheduleOn') : t('settings.scheduleOff')}</span>
                           </div>
                           <div className="mt-2 flex gap-3 text-xs">
                             <button onClick={() => handleToggleSchedule(schedule)} disabled={scheduleBusy} className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
                               {schedule.enabled ? t('settings.disable') : t('settings.enable')}
                             </button>
                             <button onClick={() => handleDeleteSchedule(schedule)} disabled={scheduleBusy} className="text-red-500 hover:underline disabled:opacity-50">{t('settings.remove')}</button>
                           </div>
                         </div>
                       ))}
                     </div>
                   )}
                 </div>
               </div>
             )}

            {activeTab === 'users' && (
              <div className="space-y-4">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.activeUsers')}</h4>
                   <div className="flex items-center gap-2">
                     <input type="text" value={newUser.username} onChange={(e) => setNewUser(prev => ({ ...prev, username: e.target.value }))} placeholder={t('settings.login')} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm" />
                     <input type="password" value={newUser.password} onChange={(e) => setNewUser(prev => ({ ...prev, password: e.target.value }))} placeholder={t('ui.password')} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm" />
                     <select value={newUser.role} onChange={(e) => setNewUser(prev => ({ ...prev, role: e.target.value as PanelUser['role'] }))} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm">
                       <option value="editor">{t('settings.roleEditor')}</option>
                       <option value="readonly">{t('settings.roleReadonly')}</option>
                       <option value="admin">{t('settings.roleAdmin')}</option>
                     </select>
                     <button onClick={handleCreateUser} className="text-sm text-blue-600 dark:text-blue-400 font-medium hover:underline">{t('ui.create')}</button>
                   </div>
                </div>
                 {editingUser && (
                   <div className="rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 p-3">
                     <div className="flex items-center gap-2">
                       <input type="text" value={editingUser.username} onChange={(e) => setEditingUser(prev => prev ? { ...prev, username: e.target.value } : prev)} placeholder={t('settings.login')} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm" />
                       <input type="password" value={editingUser.password} onChange={(e) => setEditingUser(prev => prev ? { ...prev, password: e.target.value } : prev)} placeholder={t('settings.newPassword')} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm" />
                       <select value={editingUser.role} onChange={(e) => setEditingUser(prev => prev ? { ...prev, role: e.target.value as PanelUser['role'] } : prev)} className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-2 py-1 text-sm">
                         <option value="editor">{t('settings.roleEditor')}</option>
                         <option value="readonly">{t('settings.roleReadonly')}</option>
                         <option value="admin">{t('settings.roleAdmin')}</option>
                       </select>
                       <button onClick={handleSaveUser} className="text-sm text-blue-600 dark:text-blue-400 font-medium hover:underline">{t('ui.save')}</button>
                       <button onClick={() => setEditingUser(null)} className="text-sm text-gray-500 dark:text-gray-400 hover:underline">{t('ui.cancel')}</button>
                     </div>
                   </div>
                 )}
                 <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100">
                      <tr>
                        <th className="px-4 py-2 font-medium">{t('ui.user')}</th>
                        <th className="px-4 py-2 font-medium">{t('settings.role')}</th>
                        <th className="px-4 py-2 font-medium">{t('settings.actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                     {usersLoading ? (
                       <tr><td colSpan={3} className="px-4 py-4 text-center text-gray-500 dark:text-gray-400">{t('settings.loadingUsers')}</td></tr>
                     ) : users.length === 0 ? (
                       <tr><td colSpan={3} className="px-4 py-4 text-center text-gray-500 dark:text-gray-400">{t('settings.usersUnavailable')}</td></tr>
                     ) : users.map((item) => (
                       <tr key={item.id}>
                         <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item.username}</td>
                         <td className="px-4 py-2"><span className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 px-2 py-0.5 rounded text-xs">{item.role}</span></td>
                          <td className="px-4 py-2"><div className="flex items-center gap-3"><button onClick={() => setEditingUser({ ...item, password: '' })} className="text-blue-600 dark:text-blue-400 hover:underline">{t('settings.change')}</button><button onClick={() => handleDeleteUser(item.id)} className="text-red-500 hover:underline">{t('ui.remove')}</button></div></td>
                       </tr>
                     ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-end gap-3 shrink-0 bg-gray-50 dark:bg-gray-900/50 text-gray-900 dark:text-gray-100">
            <button onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{t('ui.cancel')}</button>
            <button onClick={handleSave} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2">
              <Save className="w-4 h-4" />{t('ui.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
