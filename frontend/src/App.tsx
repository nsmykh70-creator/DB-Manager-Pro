import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLanguage } from './contexts/LanguageContext';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { MainContent } from './components/MainContent';
import { RightSidebar } from './components/RightSidebar';
import { ToastContainer } from './components/ToastContainer';
import { SettingsModal } from './components/modals/SettingsModal';
import { CreateDatabaseModal } from './components/modals/CreateDatabaseModal';
import { CreateConnectionModal } from './components/modals/CreateConnectionModal';
import { CreateTableModal } from './components/modals/CreateTableModal';
import { ModelsModal } from './components/modals/ModelsModal';
import { MonitoringGrid } from './components/MonitoringGrid';
import { Theme, ToastMessage } from './types';
import { api, ApiError, AppSettings, AUTH_EXPIRED_EVENT, CONNECTION_GONE_EVENT, ColumnDef, ConnectionInfo, getAuthToken, PanelUser, setAuthToken, TABLES_CHANGED_EVENT } from './api';
import { SupportedDbDialect } from './dbDialects';
import { ALL_KINDS, isKindEnabled } from './engineKinds';

const THEME_STORAGE_KEY = 'mydbroot_theme';

export default function App() {
  const { t } = useLanguage();
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'login'>('checking');
  const [authRequired, setAuthRequired] = useState(true);
  const [user, setUser] = useState<PanelUser | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [authError, setAuthError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [defaultCreds, setDefaultCreds] = useState<boolean | null>(null);
  const [need2faToken, setNeed2faToken] = useState<string | null>(null);
  const [twofaCode, setTwofaCode] = useState('');
  const [twofaError, setTwofaError] = useState('');
  const [twofaBusy, setTwofaBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [forceName, setForceName] = useState('');
  const [forcePass, setForcePass] = useState('');
  const [forcePass2, setForcePass2] = useState('');
  const [forceError, setForceError] = useState('');
  const [forceBusy, setForceBusy] = useState(false);
  const authStateRef = useRef(authState);
  authStateRef.current = authState;

  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
  });
  const [projectName, setProjectName] = useState('DB Manager Pro');
  const [activeView, setActiveView] = useState<'databases' | 'monitoring'>('databases');
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('general');
  
  const [isCreateDbOpen, setIsCreateDbOpen] = useState(false);
  const [isModelsOpen, setIsModelsOpen] = useState(false);
   const [isCreateConnectionOpen, setIsCreateConnectionOpen] = useState(false);
   const [editingConnection, setEditingConnection] = useState<ConnectionInfo | null>(null);
  const [isCreateTableOpen, setIsCreateTableOpen] = useState(false);
  
  // Toast System
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [toastsEnabled, setToastsEnabled] = useState(true);
  const [toastDuration, setToastDuration] = useState(4000);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  // Какие типы СУБД показывать в боковых панелях. Пустой массив = «все», иначе
  // старый settings.json без поля спрятал бы вообще всё.
  const [enabledKinds, setEnabledKinds] = useState<string[]>(ALL_KINDS as unknown as string[]);

  // Real connections from API
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [activeDb, setActiveDb] = useState<string>('');
  const [databases, setDatabases] = useState<string[]>([]);
  // БД всех подключений для плоского сайдбара «категория → базы» (без подуровня подключений)
  const [databasesByConn, setDatabasesByConn] = useState<Record<string, string[]>>({});
  /** Какому подключению принадлежит `databases` — иначе на первом рендере после
   *  смены подключения список ещё от старого, и запрос уходит со старой базой. */
  const [databasesFor, setDatabasesFor] = useState<string | null>(null);
  // Почему не загрузились базы выбранного подключения. Без этого панель
  // таблиц показывала «Таблицы не найдены» — то есть врёт: базы есть,
  // просто подключение недоступно (сервер не поднят, неверный порт).
  const [databasesError, setDatabasesError] = useState<{ connId: string; message: string } | null>(null);
  // Сигнал для MainContent: перезагрузить список таблиц (модалка создания и т.п.)
  const [tablesVersionSignal, setTablesVersionSignal] = useState(0);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [dbVersion, setDbVersion] = useState(0);

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (!toastsEnabled) return;
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    if (toastDuration > 0) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), toastDuration);
    }
  };
  const removeToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  // Настройки, сохранённые модалкой, сразу отражаются в шапке/сайдбаре —
  // раньше projectName обновлялся только при переавторизации.
  const applySettings = useCallback((settings: AppSettings) => {
    setProjectName(settings.projectName);
    setTheme(settings.theme);
    localStorage.setItem(THEME_STORAGE_KEY, settings.theme);
    setToastsEnabled(settings.toastsEnabled);
    setToastDuration(settings.toastDuration);
    setNotificationsEnabled(settings.notificationsEnabled);
    setEnabledKinds(settings.enabledKinds?.length ? settings.enabledKinds : [...ALL_KINDS]);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const initializeAuth = async () => {
      try {
        const health = await api.health();
        if (cancelled) return;
        setAuthRequired(health.auth);
        if (!health.auth) {
          setUser(null);
          setAuthState('authenticated');
          return;
        }
        if (!getAuthToken()) {
          setAuthState('login');
          return;
        }
        const result = await api.me();
        if (!cancelled) {
          setUser(result.user);
          setAuthState('authenticated');
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setAuthError('');
        else setAuthError(error instanceof Error ? error.message : t('app.authCheckFailed'));
        setAuthState('login');
      }
    };
    void initializeAuth();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    let cancelled = false;
    void api.settings().then((settings) => {
      if (cancelled) return;
      applySettings(settings);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [applySettings, authState]);

  useEffect(() => {
    const handleAuthExpired = () => {
      authStateRef.current = 'login';
      setUser(null);
      setLoginPassword('');
      setLoginError('');
      setAuthState('login');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, []);

  /**
   * Подключение могли удалить в другой вкладке или пересоздать (новый id).
   * Без этой реакции вкладка со старым id слала бы 404 на каждый запрос.
   */
  useEffect(() => {
    let lastNotified = '';
    const handleConnectionGone = (event: Event) => {
      const goneId = (event as CustomEvent<string>).detail;
      if (!goneId) return;
      void (async () => {
        try {
          const conns = await api.connections();
          setConnections(conns);
          if (conns.some((c) => c.id === goneId)) return;
          if (activeConnIdRef.current === goneId) {
            activeConnIdRef.current = null;
            setActiveConnId(null);
            setDatabases([]);
            setDatabasesFor(null);
            setActiveDb('');
          }
          if (lastNotified !== goneId) {
            lastNotified = goneId;
            addToast(t('app.connGoneElsewhere'), 'info');
          }
        } catch {
          /* список не пришёл — тихо ждём следующего обновления */
        }
      })();
    };
    window.addEventListener(CONNECTION_GONE_EVENT, handleConnectionGone);
    return () => window.removeEventListener(CONNECTION_GONE_EVENT, handleConnectionGone);
  }, []);

  // Таблицу могли создать или удалить не через кнопку «Создать таблицу», а из
  // карточки таблицы (например, «Клонировать»): список в боковой панели обязан
  // увидеть это без перезагрузки страницы.
  useEffect(() => {
    const onTablesChanged = () => setTablesVersionSignal(v => v + 1);
    window.addEventListener(TABLES_CHANGED_EVENT, onTablesChanged);
    return () => window.removeEventListener(TABLES_CHANGED_EVENT, onTablesChanged);
  }, []);

  // Подсказка про дефолтные admin/admin — только пока она правда действует.
  useEffect(() => {
    if (authState !== 'login') return;
    let cancelled = false;
    api.authSetup().then(
      (r) => { if (!cancelled) setDefaultCreds(r.defaultCredentials); },
      () => { if (!cancelled) setDefaultCreds(null); }
    );
    return () => { cancelled = true; };
  }, [authState]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError('');
    setAuthError('');
    try {
      const result = await api.login(loginUsername.trim(), loginPassword);
      if (result.need2fa && result.tempToken) {
        // Пароль верный, но включён второй фактор: полный токен выдадим
        // только после кода. Частичный токен никуда не сохраняем.
        setNeed2faToken(result.tempToken);
        setTwofaCode('');
        setTwofaError('');
        setLoginPassword('');
        return;
      }
      setAuthToken(result.token);
      setUser(result.user);
      setLoginPassword('');
      setForceName(result.user.username);
      setForcePass('');
      setForcePass2('');
      setForceError('');
      setMustChange(result.mustChangePassword === true);
      setAuthState('authenticated');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : t('app.errorLogin'));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = () => {
    api.logout();
    setUser(null);
    setMustChange(false);
    setNeed2faToken(null);
    setTwofaCode('');
    setTwofaError('');
    setLoginPassword('');
    setLoginError('');
    setAuthError('');
    setAuthState('login');
  };

  // Второй шаг входа: код из приложения-аутентификатора + временный токен.
  const handleTwofaVerify = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (twofaBusy || !need2faToken) return;
    setTwofaBusy(true);
    setTwofaError('');
    try {
      const result = await api.twofaVerify(need2faToken, twofaCode.trim());
      setAuthToken(result.token);
      setUser(result.user);
      setNeed2faToken(null);
      setTwofaCode('');
      setLoginUsername(result.user.username);
      setAuthState('authenticated');
    } catch (error) {
      setTwofaError(error instanceof Error ? error.message : t('app.errorLogin'));
    } finally {
      setTwofaBusy(false);
    }
  };

  // Принудительная смена заводских admin/admin: без неё дальше нельзя.
  // После смены выходим на экран входа заново: токен привязан к старому имени.
  const handleForceChange = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (forceBusy || !user) return;
    const name = forceName.trim();
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(name)) { setForceError(t('app.forceBadName')); return; }
    if (forcePass.length < 8 || (name === 'admin' && forcePass === 'admin')) { setForceError(t('app.forceWeak')); return; }
    if (forcePass !== forcePass2) { setForceError(t('app.forceMismatch')); return; }
    setForceBusy(true);
    setForceError('');
    try {
      await api.updateAuthUser(user.id, { username: name, password: forcePass });
      addToast(t('app.forceDone'), 'success');
      handleLogout();
    } catch (error: any) {
      setForceError(error?.message ?? String(error));
    } finally {
      setForceBusy(false);
    }
  };

  const toggleTheme = () => {
    setTheme(prev => {
      const nextTheme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      void api.settings().then(current => api.saveSettings({ ...current, theme: nextTheme })).catch(() => undefined);
      return nextTheme;
    });
  };
  const openSettings = (tab: string = 'general') => { setSettingsTab(tab); setIsSettingsOpen(true); };

  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(false);
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = useState(false);

  // Актуальный activeConnId для асинхронных колбэков (без stale closure)
  const activeConnIdRef = useRef<string | null>(null);
  activeConnIdRef.current = activeConnId;

  /**
   * БД, безопасная для запросов. React выполняет эффекты детей раньше
   * родительских, поэтому в момент смены подключения MainContent успевает
   * уйти запросом со старой базой (например, `test.db` у Redis) — и получает
   * 400. Пока список баз не подтверждён, отдаём пустую строку: запросы не
   * уходят, а выбранная БД остаётся в состоянии и подхватится после загрузки.
   */
  const activeDbSafe = useMemo(() => {
    if (!activeDb || databasesFor !== activeConnId) return '';
    return databases.includes(activeDb) ? activeDb : '';
  }, [activeDb, databases, databasesFor, activeConnId]);

  // Fetch connections on mount
  const fetchConnections = useCallback(async () => {
    try {
      setLoadingConnections(true);
      const conns = await api.connections();
      if (authStateRef.current !== 'authenticated') return;
      setConnections(conns);
      // Только если подключение вообще не выбрано (иначе каждое обновление
      // прыгало бы на первое подключение и «удаление не работало»)
      if (conns.length > 0 && !activeConnIdRef.current) {
        setActiveConnId(conns[0].id);
      }
    } catch (e: any) {
      if (authStateRef.current === 'authenticated') addToast(t('app.errorLoadConnections') + e.message, 'error');
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  // Fetch databases when connection changes
  // requestId guard: при быстром переключении подключений протухший ответ
  // не должен затирать список/выбор актуального подключения
  const databasesReqRef = useRef(0);
  const fetchDatabases = useCallback(async (connId: string) => {
    const myReq = ++databasesReqRef.current;
    try {
      const dbs = await api.databases(connId);
      if (authStateRef.current !== 'authenticated' || myReq !== databasesReqRef.current) return;
      // Ответ пришёл уже после ухода с этого подключения — отбрасываем,
      // иначе чужие БД оседают под активным подключением
      if (connId !== activeConnIdRef.current) return;
      setDatabases(dbs);
      setDatabasesFor(connId);
      setDatabasesError(null);
      // Сбрасываем протухший выбор: оставляем текущую БД только если она есть
      // в новом списке, иначе выбираем первую (чинит запросы вида
      // mongo/faraja_demo.sqlite после смены подключения)
      setActiveDb(prev => (prev && dbs.includes(prev) ? prev : (dbs[0] ?? '')));
    } catch (e: any) {
      if (myReq !== databasesReqRef.current) return;
      if (connId !== activeConnIdRef.current) return;
      setDatabases([]);
      setDatabasesFor(null);
      setActiveDb('');
      setDatabasesError({ connId, message: String(e?.message ?? e) });
      addToast(t('app.errorLoadDatabases') + e.message, 'error');
    }
  }, []);

  useEffect(() => {
    if (authState === 'authenticated') void fetchConnections();
  }, [authState, fetchConnections]);
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (activeConnId) {
      setDatabases([]);
      setDatabasesFor(null);
      setActiveDb('');
      void fetchDatabases(activeConnId);
    }
  }, [activeConnId, authState, fetchDatabases]);

  // Карта БД по всем подключениям для сайдбара. Обновления поключевые,
  // поэтому параллельные запросы друг другу не мешают.
  const fetchDatabasesForConn = useCallback(async (connId: string) => {
    try {
      const dbs = await api.databases(connId);
      setDatabasesByConn(prev => ({ ...prev, [connId]: dbs }));
    } catch {
      setDatabasesByConn(prev => ({ ...prev, [connId]: [] }));
    }
  }, []);

  const fetchAllDatabases = useCallback(async (conns: ConnectionInfo[]) => {
    await Promise.all(conns.map(c => fetchDatabasesForConn(c.id)));
  }, [fetchDatabasesForConn]);

  useEffect(() => {
    if (authState === 'authenticated' && connections.length > 0) void fetchAllDatabases(connections);
  }, [authState, connections, fetchAllDatabases]);

  useEffect(() => {
    if (authState === 'authenticated') return;
    setConnections([]);
    setActiveConnId(null);
    setActiveDb('');
    setDatabases([]);
    setDatabasesFor(null);
    setDatabasesByConn({});
  }, [authState]);

  const handleSelectDb = (db: string) => {
    setActiveDb(db);
    setActiveView('databases');
  };

  const handleCreateConnection = async (input: import('./api').CreateConnectionInput) => {
    try {
      const created = await api.createConnection(input);
      addToast(t('app.connCreated', { name: created.name }), 'success');
      await fetchConnections();
      setActiveConnId(created.id);
      setIsCreateConnectionOpen(false);
    } catch (e: any) {
      addToast(t('app.errorCreateConn') + e.message, 'error');
      throw e;
    }
  };

     const handleDeleteConnection = async (connection: ConnectionInfo) => {
    if (!confirm(t('app.confirmDeleteConn', { name: connection.name }))) return;
    try {
      await api.deleteConnection(connection.id);
      addToast(t('app.connDeleted'), 'success');
      // Сбрасываем выбор СРАЗУ: иначе эта вкладка продолжит опрашивать удалённое
      // подключение и нарисует в консоли 404 (обработчик CONNECTION_GONE срабатывает
      // только на уже ушедшем запросе).
      if (activeConnIdRef.current === connection.id) {
        activeConnIdRef.current = null;
        setActiveConnId(null);
        setActiveDb('');
        setDatabases([]);
        setDatabasesFor(null);
      }
      await fetchConnections();
    } catch (e: any) {
      addToast(t('app.errorDeleteConn') + e.message, 'error');
    }
  };

  const handleUpdateConnection = async (input: import('./api').CreateConnectionInput) => {
    if (!editingConnection) return;
    try {
      await api.updateConnection(editingConnection.id, input);
      addToast(t('app.connUpdated'), 'success');
      await fetchConnections();
      setEditingConnection(null);
    } catch (e: any) {
      addToast(t('app.errorUpdateConn') + e.message, 'error');
      throw e;
    }
  };

  const handleCreateDb = async (name: string, connectionId: string, kind: import('./api').DbKind = 'mysql', opts?: { charset?: string; collate?: string; encoding?: string; template?: string; owner?: string }) => {
    try {
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) { addToast(t('app.connNotFound'), 'error'); return; }
      if (kind !== 'sqlite' && conn.kind !== kind) { addToast(t('app.connKindMismatch'), 'error'); return; }
      if (conn.kind === 'sqlite') {
        const created = await api.createConnection({
          name: `${name} (SQLite)`,
          kind: 'sqlite',
           filePath: `sqlite/${name}.sqlite`,
          createDatabase: true,
        });
        addToast(t('app.sqliteDbCreated', { name: name }), 'success');
        await fetchConnections();
        // Активируем именно новое подключение, а не старое;
        // загрузку списка БД дотянет эффект по activeConnId
        setActiveConnId(created.id);
      } else {
        // Сначала переключаем подключение, чтобы эффект сброса не затирал выбор ниже
        setActiveConnId(connectionId);
        await api.createDatabase(connectionId, name, opts);
        addToast(t('app.dbCreated', { name: name, conn: conn.name }), 'success');
        await fetchConnections();
        await fetchDatabases(connectionId);
        // Сразу выбираем созданную БД
        setActiveDb(name);
      }
      setDbVersion(v => v + 1);
      setIsCreateDbOpen(false);
    } catch (e: any) {
      addToast(t('app.errorCreateDb') + e.message, 'error');
    }
  };

  const handleCreateTable = async (name: string, _dialect: SupportedDbDialect, columns: ColumnDef[], opts?: { comment?: string; engine?: string; charset?: string; collate?: string }) => {
    if (!activeConnId || !activeDb) { addToast(t('app.pickDb'), 'error'); return; }
    try {
      // dialect не передаём: backend определяет диалект по типу подключения (cc.kind),
    // поле в payload было игнорируемым и только вводило в заблуждение.
    await api.createTable(activeConnId, activeDb, { name, columns, ...opts });
      addToast(t('app.tableCreated', { name: name }), 'success');
      setIsCreateTableOpen(false);
      setTablesVersionSignal(v => v + 1);
    } catch (e: any) {
      addToast(t('app.errorCreateTable') + e.message, 'error');
    }
  };

  const selectedConn = connections.find(c => c.id === activeConnId) || null;
  // Подключение выключенного типа в панелях не показывается — и показывать его
  // данные тоже незачем: правая панель и панели работают по активной базе.
  const activeConn = selectedConn && isKindEnabled(selectedConn.kind, enabledKinds) ? selectedConn : null;
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

  if (authState === 'checking') {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-[#151923] text-gray-600 dark:text-gray-300">
        <div className="text-sm">{t('app.checkingAuth')}</div>
      </div>
    );
  }

  if (authState === 'login') {
    const error = loginError || authError;
    // Второй шаг входа: пароль уже принят, ждём 6 цифр из приложения.
    if (need2faToken) {
      return (
        <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-[#151923] px-4 py-10 text-gray-900 dark:text-gray-100">
          <div className="w-full max-w-sm rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e2330] shadow-xl p-8">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white text-xl font-bold">2F</div>
              <h1 className="text-xl font-semibold">{t('app.twofaTitle')}</h1>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('app.twofaHint')}</p>
            </div>
            <form onSubmit={handleTwofaVerify} className="space-y-4">
              <label className="block text-sm font-medium">{t('app.twofaCode')}<input
                  value={twofaCode}
                  onChange={(event) => setTwofaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  placeholder="123456"
                  className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm text-center tracking-[0.5em] outline-none focus:border-blue-500"
                />
              </label>
              {twofaError && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-600 dark:text-red-400">{twofaError}</p>}
              <button
                type="submit"
                disabled={twofaBusy}
                className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-2 text-sm font-medium text-white transition-colors"
              >
                {twofaBusy ? t('app.twofaChecking') : t('app.twofaVerify')}
              </button>
              <button
                type="button"
                onClick={() => { setNeed2faToken(null); setTwofaCode(''); setTwofaError(''); }}
                className="w-full rounded-lg px-3 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                {t('app.twofaBack')}
              </button>
            </form>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-[#151923] px-4 py-10 text-gray-900 dark:text-gray-100">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e2330] shadow-xl p-8">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white text-xl font-bold">DB</div>
            <h1 className="text-xl font-semibold">{t('app.title')}</h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('app.signIn')}</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <label className="block text-sm font-medium">{t('app.user')}<input
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                autoComplete="username"
                required
                autoFocus
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm font-medium">{t('app.password')}<input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            {error && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loginBusy}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-2 text-sm font-medium text-white transition-colors"
            >
              {loginBusy ? t('app.signingIn') : t('app.signIn')}
            </button>
            {defaultCreds && <p className="text-center text-xs text-amber-600 dark:text-amber-400">{t('app.defaultCreds')}</p>}
          </form>
        </div>
      </div>
    );
  }

  if (authState === 'authenticated' && mustChange && user) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-[#151923] px-4 py-10 text-gray-900 dark:text-gray-100">
        <div className="w-full max-w-sm rounded-2xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#1e2330] shadow-xl p-8">
          <h1 className="text-xl font-semibold">{t('app.forceTitle')}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('app.forceText')}</p>
          <form onSubmit={handleForceChange} className="mt-4 space-y-4">
            <label className="block text-sm font-medium">{t('app.user')}<input
                value={forceName}
                onChange={(event) => setForceName(event.target.value)}
                autoComplete="username"
                required
                autoFocus
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm font-medium">{t('app.forceNewPassword')}<input
                type="password"
                value={forcePass}
                onChange={(event) => setForcePass(event.target.value)}
                autoComplete="new-password"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm font-medium">{t('app.forceConfirm')}<input
                type="password"
                value={forcePass2}
                onChange={(event) => setForcePass2(event.target.value)}
                autoComplete="new-password"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            {forceError && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-600 dark:text-red-400">{forceError}</p>}
            <button
              type="submit"
              disabled={forceBusy}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-2 text-sm font-medium text-white transition-colors"
            >
              {t('app.forceApply')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-screen w-full bg-white dark:bg-[#151923] text-gray-900 dark:text-gray-100 font-sans overflow-hidden transition-colors duration-200 ${theme}`}>
       <Sidebar 
         projectName={projectName}
         activeDb={activeDb} 
        setActiveDb={handleSelectDb}
        openSettings={openSettings}
        addToast={addToast}
        activeView={activeView}
        setActiveView={setActiveView}
        openCreateDb={() => setIsCreateDbOpen(true)}
         openCreateConnection={() => setIsCreateConnectionOpen(true)}
         onEditConnection={connection => setEditingConnection(connection)}
         onDeleteConnection={handleDeleteConnection}
        connections={connections}
        enabledKinds={enabledKinds}
        activeConnId={activeConnId}
        setActiveConnId={setActiveConnId}
        databasesByConn={databasesByConn}
        loadingConnections={loadingConnections}
        refreshDatabases={() => activeConnId && fetchDatabases(activeConnId)}
        refreshConnDatabases={fetchDatabasesForConn}
        onDbChange={() => setDbVersion(v => v + 1)}
        refreshConnections={fetchConnections}
        isCollapsed={isLeftSidebarCollapsed}
        onToggleCollapse={() => setIsLeftSidebarCollapsed(prev => !prev)}
        userKey={user?.username ?? ''}
      />
      
      <div className="flex-1 flex flex-col min-w-0">
         <Header 
           projectName={projectName}
           theme={theme} 
           toggleTheme={toggleTheme} 
          activeDb={activeDbSafe}
          activeConn={activeConn}
          openSettings={openSettings}
          addToast={addToast}
          isLeftSidebarCollapsed={isLeftSidebarCollapsed}
          toggleLeftSidebar={() => setIsLeftSidebarCollapsed(prev => !prev)}
          isRightSidebarCollapsed={isRightSidebarCollapsed}
          toggleRightSidebar={() => setIsRightSidebarCollapsed(prev => !prev)}
           notificationsEnabled={notificationsEnabled}
           authRequired={authRequired}
           user={user ?? undefined}
          onLogout={handleLogout}
        />
        
        <div className="flex-1 flex overflow-hidden">
          {activeView === 'monitoring' ? (
            <MonitoringGrid connId={activeConnId} userRole={user?.role} connectionReadOnly={activeConn?.readOnly} userName={user?.username} />
          ) : (
            <MainContent 
              activeDb={activeDbSafe} 
              activeConnId={activeConnId}
              activeConn={activeConn}
              databases={databasesFor === activeConnId ? databases : []}
              databasesError={databasesError?.connId === activeConnId ? databasesError.message : null}
              onRetryDatabases={() => activeConnId && void fetchDatabases(activeConnId)}
              externalTablesVersion={tablesVersionSignal}
              addToast={addToast}
              openCreateTable={() => setIsCreateTableOpen(true)}
              userRole={user?.role}
              userName={user?.username}
            />
          )}
          <RightSidebar 
            addToast={addToast} 
             openSettings={() => openSettings('backup')}
            isCollapsed={isRightSidebarCollapsed}
            onToggleCollapse={() => setIsRightSidebarCollapsed(prev => !prev)}
            connId={activeConnId}
            connKind={activeConn?.kind}
            activeDb={activeDbSafe}
            dbVersion={dbVersion}
            onTablesChanged={() => setTablesVersionSignal(v => v + 1)}
             onOpenCreateDb={() => setIsCreateDbOpen(true)}
      onOpenModels={() => setIsModelsOpen(true)}
             onOpenCreateTable={() => setIsCreateTableOpen(true)}
              canCreateDatabase={activeConn?.kind !== 'redis'}
              canCreateTable={activeConn?.kind !== 'redis'}
              userRole={user?.role}
              connectionReadOnly={activeConn?.readOnly}
          />
        </div>
      </div>
      
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        addToast={addToast} 
        initialTab={settingsTab} 
        toastsEnabled={toastsEnabled}
        setToastsEnabled={setToastsEnabled}
        toastDuration={toastDuration}
        setToastDuration={setToastDuration}
         notificationsEnabled={notificationsEnabled}
         setNotificationsEnabled={setNotificationsEnabled}
         theme={theme}
         setTheme={setTheme}
         connId={activeConnId}
         activeDb={activeDb}
         connKind={activeConn?.kind}
         onSaved={applySettings}
       />
       <CreateConnectionModal isOpen={isCreateConnectionOpen} enabledKinds={enabledKinds} onClose={() => setIsCreateConnectionOpen(false)} onCreate={handleCreateConnection} />
       <CreateConnectionModal isOpen={Boolean(editingConnection)} initialConnection={editingConnection} onClose={() => setEditingConnection(null)} onCreate={handleCreateConnection} onSave={handleUpdateConnection} />
      <ModelsModal
        isOpen={isModelsOpen}
        onClose={() => setIsModelsOpen(false)}
        addToast={addToast}
        connId={activeConnId}
        connKind={activeConn?.kind}
        activeDb={activeDbSafe}
        databases={databasesFor === activeConnId ? databases : []}
        userRole={user?.role}
      />
      <CreateDatabaseModal isOpen={isCreateDbOpen} onClose={() => setIsCreateDbOpen(false)} onCreate={handleCreateDb} connections={connections} activeConnId={activeConnId} enabledKinds={enabledKinds} />
      <CreateTableModal
        isOpen={isCreateTableOpen}
        onClose={() => setIsCreateTableOpen(false)}
        onCreate={handleCreateTable}
        initialDialect={activeDialect}
        dialectLocked
      />
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}
