import { translate, type Language } from './contexts/LanguageContext';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

let AUTH_TOKEN: string | null = localStorage.getItem('mydbroot_token');

export const AUTH_EXPIRED_EVENT = 'mydbroot:auth-expired';
/**
 * Подключение удалили в другой вкладке или его пересоздали (новый id) — вкладка
 * продолжает шлёт запросы со старым id и получает 404 на каждый. Сообщаем об
 * этом один раз, чтобы UI мог сбросить выбор, вместо бесконечных 404.
 */
export const CONNECTION_GONE_EVENT = 'mydbroot:connection-gone';

/**
 * Список таблиц базы изменился изнутри карточки таблицы — например, «Клонировать»
 * выполнил `CREATE TABLE ... LIKE`, и новая таблица без перезагрузки страницы
 * появлялась только после F5. Создатель списка слушает событие и перечитывает
 * `/tables`, поэтому клон виден сразу.
 */
export const TABLES_CHANGED_EVENT = 'mydbroot:tables-changed';

export function notifyTablesChanged(): void {
  window.dispatchEvent(new Event(TABLES_CHANGED_EVENT));
}

function notifyConnectionGone(path: string, message: string): void {
   const m = path.match(/\/api\/connections\/([0-9a-f-]{36})/i);
   if (!m) return;
   if (!/not found|no such connection/i.test(message)) return;
   window.dispatchEvent(new CustomEvent<string>(CONNECTION_GONE_EVENT, { detail: m[1] }));
}

export class ApiError extends Error {
  readonly status: number;
  /** Машинный код ошибки от сервера: по нему показывается перевод. */
  readonly code?: string;
  /** Текст сервера (английский) — для журнала и для диалога с разработчиком. */
  readonly serverMessage: string;

  constructor(message: string, status: number, code?: string, serverMessage?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage ?? message;
  }
}

/**
 * Перевод ошибки по машинному коду.
 *
 * Сервер отдаёт английский текст (его читают в журналах и в API) и, для
 * известных случаев, стабильный код. Сравнивать английские строки по шаблону
 * нельзя — MySQL переформулирует их между версиями, — поэтому код и текст
 * разведены. Если кода нет, показываем текст сервера как есть: лучше английская
 * фраза, чем молчание.
 */
const ERROR_CODES: Record<string, string> = {
  explain_readonly: 'errors.explainReadonly',
  table_not_found: 'errors.tableNotFound',
  zero_date: 'errors.zeroDate',
  bad_identifier: 'errors.badIdentifier',
  read_only_connection: 'errors.readOnlyConnection',
  unsupported_operation: 'errors.unsupportedOperation',
  undo_structural: 'errors.undoStructural',
  undo_nothing: 'errors.undoNothing',
};

function currentLanguage(): Language {
  const stored = localStorage.getItem('mydbroot_lang');
  return (stored === 'en' || stored === 'de' || stored === 'fr' || stored === 'es' || stored === 'zh' ? stored : 'ru') as Language;
}

/** Текст ошибки для показа пользователю: перевод по коду, иначе как есть. */
export function errorText(error: unknown): string {
  const err = error as { code?: string; message?: string };
  const key = err?.code ? ERROR_CODES[err.code] : undefined;
  if (key) return translate(currentLanguage(), key);
  return err?.message ?? String(error);
}

// Clear stale/invalid tokens on load
if (AUTH_TOKEN) {
  try {
    const encoded = AUTH_TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      AUTH_TOKEN = null;
      localStorage.removeItem('mydbroot_token');
    }
  } catch {
    AUTH_TOKEN = null;
    localStorage.removeItem('mydbroot_token');
  }
}

export function setAuthToken(token: string | null) {
  AUTH_TOKEN = token;
  if (token) localStorage.setItem('mydbroot_token', token);
  else localStorage.removeItem('mydbroot_token');
}

export function getAuthToken() { return AUTH_TOKEN; }

function notifyUnauthorized() {
  setAuthToken(null);
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (AUTH_TOKEN) headers.set('Authorization', `Bearer ${AUTH_TOKEN}`);
  if (init?.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers });
   const body = await r.json().catch(() => null);
   if (!r.ok) {
   if (r.status === 401) notifyUnauthorized();
   const serverMessage = body?.error || `API ${r.status}`;
   if (r.status === 404) notifyConnectionGone(path, serverMessage);
   const code = typeof body?.code === 'string' ? body.code : undefined;
   // Пользователю показываем перевод по коду, а английский текст сервера
   // остаётся в serverMessage: он нужен журналу и «копировать ошибку».
   const key = code ? ERROR_CODES[code] : undefined;
   const message = key ? translate(currentLanguage(), key) : serverMessage;
   throw new ApiError(message, r.status, code, serverMessage);
   }
   return body;
   }

async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (AUTH_TOKEN) headers.set('Authorization', `Bearer ${AUTH_TOKEN}`);
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (r.status === 401) notifyUnauthorized();
  return r;
}

export type DbKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb' | 'redis' | 'oracle';

export interface ConnectionInfo {
  id: string; name: string; kind: DbKind;
  host?: string; port?: number; database?: string; user?: string;
  filePath?: string; readOnly?: boolean;
}

export interface TabularResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  execMs: number;
}

export interface TablePage {
  columns: string[];
  rows: Record<string, unknown>[];
  totalApprox?: number;
  page: number;
  pageSize: number;
  truncated: boolean;
}

export interface GlobalSearchHit {
  table: string;
  columns: string[];
  row: Record<string, unknown>;
}

export interface GlobalSearchResult {
  hits: GlobalSearchHit[];
  tables: { table: string; matches: number }[];
  errors: { table: string; error: string }[];
  page: number;
  pageSize: number;
  total: number;
  truncated: boolean;
}

export interface ColumnDef {
  name: string; type: string;
  nullable?: boolean; primary?: boolean;
  autoInc?: boolean; default?: string | null;
  comment?: string | null;
}

export interface CreateTableDef {
  name: string;
  columns: ColumnDef[];
  foreignKeys?: ForeignKeyDef[];
  indexes?: IndexDef[];
  comment?: string | null;
  engine?: string | null;
  charset?: string | null;
  collate?: string | null;
}

export interface IndexDef {
  name: string; columns: string[]; unique?: boolean; type?: string; where?: string;
}

export interface ForeignKeyDef {
  name?: string; columns: string[]; refTable: string; refColumns: string[];
  onDelete?: string; onUpdate?: string;
}

export type AlterOp =
  | { op: 'addColumn'; column: ColumnDef }
  | { op: 'dropColumn'; name: string }
  | { op: 'renameColumn'; from: string; to: string }
  | { op: 'alterColumn'; name: string; column: ColumnDef }
  | { op: 'renameTable'; to: string }
  | { op: 'addIndex'; index: IndexDef }
  | { op: 'dropIndex'; name: string }
  | { op: 'addForeignKey'; fk: ForeignKeyDef }
  | { op: 'dropForeignKey'; name: string }
  | { op: 'setPrimaryKey'; columns: string[] }
  | { op: 'dropPrimaryKey' };

export interface TriggerDef {
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF' | string;
  event: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  /** MySQL/SQLite — тело; PostgreSQL — имя функции-триггера. */
  statement: string;
}

/** Ответ design API: какие SQL-операции применились и была ли транзакция. */export interface DesignResult {
  ok: boolean;
  statements?: string[];
  applied?: number;
  transactional?: boolean;
}

export interface DesignPreview {
  ok: boolean;
  statements: string[];
  transactional: boolean;
  ops: number;
  /** Плоское описание схемы «до»: колонки, индексы, FK, триггеры. */
  before: string[];
  applyHint: string;
}

export interface DbUser {
  username: string; host?: string; db?: string; roles?: string[];
}

export interface Relation {
  table: string; column: string; refTable: string; refColumn: string;
  constraint?: string; onDelete?: string | null; onUpdate?: string | null;
}

export interface ProcRow {
  id: string; user?: string; db?: string; command?: string;
  timeSec?: number; state?: string; query?: string;
}

export interface DbSize {
  db: string; bytes: number; tables?: number;
}

export interface ServerStatus {
  version: string; uptimeSec?: number; connections?: number;
  queries?: number; slowQueries?: number;
  processlist: ProcRow[]; dbSizes: DbSize[];
  extra?: Record<string, unknown>;
}

export interface SystemStatus {
  cpuLoad: number;
  ramUsed: number;
  ramTotal: number;
  uptimeSec?: number;
  platform?: string;
  arch?: string;
  loadAvg?: number[];
}

export interface HistoryEntry {
  id: string; connId?: string | null; db?: string | null;
  sql: string; name?: string | null; saved?: boolean | number;
  createdAt?: string; username?: string; ok?: boolean | number; execMs?: number; at?: number;
}

export interface AuditEntry {
  id: number; connId?: string | null; action: string; target?: string | null;
  ok: number | boolean; ms: number; at: number; actor?: string | null;
  /** Что изменилось в данных: {before, after} для правок строк. */
  values?: { before?: unknown; after?: unknown; [key: string]: unknown } | null;
}

export interface ModelColumn {
  name: string; type: string; nullable?: boolean; primary?: boolean;
  autoInc?: boolean; default?: string | null; comment?: string | null; extra?: string | null;
}
export interface ModelIndex { name: string; columns: string[]; unique?: boolean; type?: string | null; where?: string | null }
export interface ModelForeignKey {
  name?: string | null; columns: string[]; refTable: string; refColumns: string[];
  onDelete?: string | null; onUpdate?: string | null;
}
export interface ModelTrigger { name: string; timing: string; event: string; statement: string }
export interface ModelTable {
  name: string; comment?: string | null; kind?: string;
  columns: ModelColumn[]; indexes?: ModelIndex[]; foreignKeys?: ModelForeignKey[]; triggers?: ModelTrigger[];
}
export interface ModelSummary {
  id: string; name: string; dbKind: string | null; dbName: string | null; comment: string | null;
  tables: number; version: number; actor?: string | null; createdAt: number; updatedAt: number;
}
export interface ProjectModel extends Omit<ModelSummary, 'tables'> { tables: ModelTable[] }
export interface ModelVersionSummary {
  id: string; version: number; note: string | null; actor: string | null; at: number; tables: number;
}
export interface ModelApplyResult {
  ok: boolean; model: string; db: string;
  created: string[]; replaced: string[]; skipped: string[];
  errors: { table: string; error: string }[];
  statements: string[]; execMs: number;
}
export interface ModelTableDiff {
  table: string;
  missingColumns: string[]; extraColumns: string[];
  changedColumns: { column: string; changes: string[] }[];
  missingIndexes: string[]; extraIndexes: string[];
  changedIndexes: { index: string; changes: string[] }[];
  missingForeignKeys: string[]; extraForeignKeys: string[];
  changedForeignKeys: { foreignKey: string; changes: string[] }[];
  missingTriggers: string[]; extraTriggers: string[];
  equal: boolean;
}
export interface ModelDiffResult {
  model: { id: string; name: string; version: number; dbKind: string | null };
  db: string; connKind: string;
  equal: boolean;
  missingTables: string[]; extraTables: string[];
  changedTables: ModelTableDiff[];
  summary: { missing: number; extra: number; changed: number; same: number };
  execMs: number;
}

export interface BulkRowsResult {
  /** Предпросмотр: matched + sample, требует confirm. */
  dryRun?: boolean; matched: number; sample?: Record<string, unknown>[]; preview?: string; requiresConfirm?: boolean;
  /** Применение: сколько строк затронуто и где точка восстановления. */
  ok?: boolean; affected?: number; failed?: { key: Record<string, unknown>; error: string }[];
  checkpointId?: string | null; checkpointError?: string | null; execMs?: number; where?: string | null;
}

export interface DataUndoEntry {  id: string; connId: string; dbName: string; tableName: string;
  op: 'insert' | 'update' | 'delete';
  rows: number; summary: string;
  undone: 0 | 1; blocked: 0 | 1;
  undoable: boolean; canRedo: boolean;
  actor?: string | null; at: number;
}

export interface BackupSchedule {
  id: string; connId: string; db: string;
  format: 'sql' | 'json'; intervalMin: number; keepLast: number;
  enabled: boolean | number;
}

export interface AppSettings {
  projectName: string;
  timezone: string;
  theme: 'light' | 'dark';
  checkUpdates: boolean;
  toastsEnabled: boolean;
  toastDuration: number;
  notificationsEnabled: boolean;
  /** Типы СУБД, показываемые в боковых панелях. Пустой массив или отсутствие
   * поля означают «все типы включены» — так ведёт себя и бэкенд. */
  enabledKinds?: DbKind[];
}

export interface PanelUser {
  id: string; username: string; role: 'admin' | 'editor' | 'readonly';
}

// SQLite/better-sqlite3 отдаёт 0|1, JSON-источники — true|false.
// Единая нормализация, иначе `ok === 0` и `ok === false` расходятся
// в разных проверках и журнал врёт об успехе/ошибке.
export function toBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value === '') return undefined;
    return value !== '0' && value.toLowerCase() !== 'false';
  }
  return Boolean(value);
}

export interface CreateConnectionInput {
  name: string; kind: DbKind;
  host?: string; port?: number;
  user?: string; password?: string;
  database?: string; filePath?: string;
  readOnly?: boolean; createDatabase?: boolean;
}

export const api = {
  // Health & Drivers
  health: () => request<{ ok: boolean; ts: number; auth: boolean }>('/health'),
  drivers: () => request<{ kinds: string[]; implemented: string[] }>('/drivers'),
  systemStatus: () => request<SystemStatus>('/system/status'),

  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: PanelUser; mustChangePassword?: boolean }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  /** true, пока хоть один пользователь сидит на дефолтном пароле: экран входа
   *  показывает подсказку admin/admin, после смены она исчезает сама. */
  authSetup: () => request<{ defaultCredentials: boolean }>('/auth/setup'),
  logout: () => setAuthToken(null),
  me: () => request<{ user: PanelUser }>('/auth/me'),
  authUsers: () => request<PanelUser[]>('/auth/users'),
  createAuthUser: (username: string, password: string, role: PanelUser['role']) =>
    request<{ ok: boolean }>('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  updateAuthUser: (id: string, patch: { username?: string; password?: string; role?: PanelUser['role'] }) =>
    request<{ ok: boolean }>(`/auth/users/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAuthUser: (id: string) => request<{ ok: boolean }>(`/auth/users/${enc(id)}`, { method: 'DELETE' }),

  settings: () => request<AppSettings>('/settings'),
  saveSettings: (settings: AppSettings) => request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  // Connections
  connections: () => request<ConnectionInfo[]>('/connections'),
  createConnection: (input: CreateConnectionInput) =>
    request<ConnectionInfo>('/connections', {
      method: 'POST', body: JSON.stringify(input),
    }),
  deleteConnection: (id: string) =>
    request<{ ok: boolean }>(`/connections/${enc(id)}`, { method: 'DELETE' }),
  updateConnection: (id: string, patch: Partial<CreateConnectionInput>) =>
    request<ConnectionInfo>(`/connections/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  testConnection: (id: string) =>
    request<{ ok: boolean; latencyMs: number }>(`/connections/${enc(id)}/test`, { method: 'POST' }),

  // Databases
  databases: (connId: string) =>
    request<string[]>(`/connections/${enc(connId)}/databases`),
  createDatabase: (connId: string, name: string, opts?: { charset?: string; collate?: string; encoding?: string; template?: string; owner?: string }) =>
    request<{ name: string; type: string }>('/databases', {
      method: 'POST', body: JSON.stringify({ connectionId: connId, name, ...opts }),
    }),
  deleteDatabase: (connId: string, name: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/databases/${enc(name)}`, {
      method: 'DELETE',
    }),

  // Tables
  tables: (connId: string, db: string) =>
    request<string[]>(`/connections/${enc(connId)}/${enc(db)}/tables`),
  schema: (connId: string, db: string, table: string) =>
    request<unknown>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/schema`),
  rows: (connId: string, db: string, table: string, params?: { page?: number; pageSize?: number; sort?: string; filter?: string }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.filter) qs.set('filter', params.filter);
    const q = qs.toString();
    return request<TablePage>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/rows${q ? '?' + q : ''}`);
  },
  globalSearch: (connId: string, db: string, query: string, params?: { page?: number; pageSize?: number; limit?: number }) => {
    const qs = new URLSearchParams({ q: query });
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params?.limit) qs.set('limit', String(params.limit));
    return request<GlobalSearchResult>(`/connections/${enc(connId)}/${enc(db)}/search?${qs.toString()}`);
  },

  // CRUD Rows
  insertRow: (connId: string, db: string, table: string, row: Record<string, unknown>) =>
    request<{ insertedId?: unknown }>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/rows`, {
      method: 'POST', body: JSON.stringify({ row }),
    }),
  updateRows: (connId: string, db: string, table: string, filter: Record<string, unknown>, patch: Record<string, unknown>, expected?: Record<string, unknown>) =>
    request<{ matched: number }>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/rows`, {
      method: 'PATCH', body: JSON.stringify({ filter, patch, ...(expected ? { expected } : {}) }),
    }),
  deleteRows: (connId: string, db: string, table: string, filter: Record<string, unknown>, expected?: Record<string, unknown>) =>
    request<{ deleted: number }>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/rows`, {
      method: 'DELETE', body: JSON.stringify({ filter, ...(expected ? { expected } : {}) }),
    }),

  /**
   * Массовая операция по фильтру строк ('st=\'a\' AND n>1').
   * Первый вызов — предпросмотр (число строк и пример); для применения нужны
   * одновременно dryRun:false и confirm:true.
   */
  bulkRows: (connId: string, db: string, table: string, body: {
    where: string; patch?: Record<string, unknown>; delete?: boolean; dryRun?: boolean; confirm?: boolean; allowAll?: boolean;
  }) => request<BulkRowsResult>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/rows/bulk`, {
    method: 'POST', body: JSON.stringify(body)
  }),

  /** Предпросмотр удаления таблицы: сколько строк исчезнет, ничего не удаляя. */
  dropTablePreview: (connId: string, db: string, table: string) =>
    request<{ dryRun: true; exists: boolean; table: string; rowsApprox: number; operation: string; note: string }>(
      `/connections/${enc(connId)}/${enc(db)}/${enc(table)}?dryRun=1`, { method: 'DELETE' }
    ),

  /** Предпросмотр удаления базы: список таблиц, ничего не удаляя. */
  dropDatabasePreview: (connId: string, db: string) =>
    request<{ dryRun: true; db: string; tablesApprox: number; sample: string[]; note: string }>(
      `/connections/${enc(connId)}/databases/${enc(db)}?dryRun=1`, { method: 'DELETE' }
    ),

  // Откат изменений данных (не структуры)
  dataUndo: {
    list: (connId: string, opts: { db?: string; table?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams({ connId });
      if (opts.db) qs.set('db', opts.db);
      if (opts.table) qs.set('table', opts.table);
      if (opts.limit) qs.set('limit', String(opts.limit));
      return request<DataUndoEntry[]>(`/data-undo?${qs.toString()}`);
    },
    undo: (id: string) => request<{ ok: true; affected: number; skipped: string[] }>(`/data-undo/${enc(id)}/undo`, { method: 'POST' }),
    redo: (id: string) => request<{ ok: true; affected: number; skipped: string[] }>(`/data-undo/${enc(id)}/redo`, { method: 'POST' }),
  },

  // Query
  /**
   * План выполнения запроса. Только чтение: сервер отклоняет операции записи,
   * а analyze=true (PostgreSQL) запрос выполняет — включать стоит осознанно.
   */
  explain: (connId: string, sql: string, db?: string, analyze?: boolean) => {
    const qs = new URLSearchParams();
    if (db) qs.set('db', db);
    if (analyze) qs.set('analyze', '1');
    const q = qs.toString();
    return request<{ kind: string; analyze: boolean; plan: TabularResult }>(
      `/connections/${enc(connId)}/explain${q ? '?' + q : ''}`,
      { method: 'POST', body: JSON.stringify({ sql, db, analyze: analyze === true }) }
    );
  },

  query: (connId: string, sql: string, db?: string) =>
    request<TabularResult>(`/connections/${enc(connId)}/query`, {
      method: 'POST', body: JSON.stringify({ sql, db }),
    }),
  // Раньше здесь был queryCompat для маршрута POST /api/query. Его на сервере нет
  // (никогда не было), и вызова у метода тоже не было: он молча указывал бы на
  // 404. Убрали, чтобы следующий разработчик не искал несуществующий маршрут.

  // DDL
  createTable: (connId: string, db: string, def: CreateTableDef) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/${enc(db)}/tables`, {
      method: 'POST', body: JSON.stringify(def),
    }),
  alterTable: (connId: string, db: string, table: string, ops: AlterOp[]) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}`, {
      method: 'PATCH', body: JSON.stringify({ ops }),
    }),
  dropTable: (connId: string, db: string, table: string) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}`, {
      method: 'DELETE',
    }),
  /** Предпросмотр alter-пакета: SQL, которое применит alterTable, и состояние «до». */
  previewAlter: (connId: string, db: string, table: string, ops: AlterOp[]) =>
    request<DesignPreview>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/preview`, {
      method: 'POST', body: JSON.stringify({ ops }),
    }),
  /** Откат последнего DDL-пакета: восстанавливает индексы/FK/триггеры снапшота. */
  undoAlter: (connId: string, db: string, table: string) =>
    request<DesignResult & { restored?: number; skipped?: string[]; ddlBefore?: string | null }>(
      `/connections/${enc(connId)}/${enc(db)}/${enc(table)}/undo`,
      { method: 'POST' }
    ),
  createTrigger: (connId: string, db: string, table: string, def: TriggerDef) =>    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/triggers`, {
      method: 'POST', body: JSON.stringify(def),
    }),
  dropTrigger: (connId: string, db: string, table: string, name: string) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/triggers/${enc(name)}`, {
      method: 'DELETE',
    }),

  /** Представления: создать (`{name, sql}` — только SELECT) и удалить. */
  createView: (connId: string, db: string, def: { name: string; sql: string }) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/views`, {
      method: 'POST', body: JSON.stringify(def),
    }),
  dropView: (connId: string, db: string, name: string) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/views/${enc(name)}`, {
      method: 'DELETE',
    }),

  /** Схемы PostgreSQL: создать и удалить (`cascade=true` — вместе с содержимым). */
  createSchema: (connId: string, db: string, name: string) =>
    request<DesignResult>(`/connections/${enc(connId)}/${enc(db)}/schemas`, {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  dropSchema: (connId: string, db: string, name: string, cascade = false) =>
    request<DesignResult & { cascade?: boolean }>(`/connections/${enc(connId)}/${enc(db)}/schemas/${enc(name)}${cascade ? '?cascade=1' : ''}`, {
      method: 'DELETE',
    }),

  // ER Diagram
  er: (connId: string, db: string) =>
    request<{ tables: unknown[]; schemas: unknown[]; relations: Relation[]; truncated: boolean }>(
      `/connections/${enc(connId)}/${enc(db)}/er`
    ),

  // Server Status
  serverStatus: (connId: string) =>
    request<ServerStatus>(`/connections/${enc(connId)}/status`),

  // Export
  exportTable: async (connId: string, db: string, table: string, format: 'csv' | 'json' | 'sql') => {
    const r = await requestRaw(`/connections/${enc(connId)}/${enc(db)}/${enc(table)}/export?format=${format}`);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error(body?.error || `API ${r.status}`);
    }
    return r;
  },

  /**
   * Экспорт всей базы одним файлом. Сервер отдаёт поток, поэтому объём
   * ограничен только памятью сервера СУБД, а не панели. Порядок таблиц
   * выстроен по внешним ключам, чтобы дамп можно было восстановить.
   */
  exportDatabase: async (connId: string, db: string, format: 'csv' | 'json' | 'sql', tables?: string[]) => {
    const only = tables?.length ? `&tables=${encodeURIComponent(tables.join(','))}` : '';
    const r = await requestRaw(`/connections/${enc(connId)}/${enc(db)}/export?format=${format}${only}`);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error(body?.error || `API ${r.status}`);
    }
    return r;
  },

  // Import
  importData: (connId: string, format: 'sql' | 'csv' | 'json', data: string, db?: string, table?: string) =>
    request<{ statements?: number; inserted?: number; execMs: number; format: string }>(
      `/connections/${enc(connId)}/import`, {
      method: 'POST',
      body: JSON.stringify({ format, data, db, table }),
    }),

  // DB Users
  dbUsers: (connId: string) =>
    request<DbUser[]>(`/connections/${enc(connId)}/dbusers`),
  createDbUser: (connId: string, username: string, password: string, db?: string, host?: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/dbusers`, {
      method: 'POST', body: JSON.stringify({ username, password, db, host }),
    }),
  dropDbUser: (connId: string, username: string, db?: string, host?: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/dbusers/${enc(username)}${db ? '?db=' + enc(db) : ''}${host ? (db ? '&' : '?') + 'host=' + enc(host) : ''}`, {
      method: 'DELETE',
    }),
  grants: (connId: string, username: string, db?: string, host?: string) =>
    request<string[]>(`/connections/${enc(connId)}/dbusers/${enc(username)}/grants${db ? '?db=' + enc(db) : ''}${host ? (db ? '&' : '?') + 'host=' + enc(host) : ''}`),
  grant: (connId: string, username: string, privilege: string, db?: string, table?: string, host?: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/dbusers/${enc(username)}/grant`, {
      method: 'POST', body: JSON.stringify({ privilege, db, table, host }),
    }),
  revoke: (connId: string, username: string, privilege: string, db?: string, table?: string, host?: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/dbusers/${enc(username)}/revoke`, {
      method: 'POST', body: JSON.stringify({ privilege, db, table, host }),
    }),

  // Kill Query
  killQuery: (connId: string, pid: string) =>
    request<{ ok: boolean }>(`/connections/${enc(connId)}/kill`, {
      method: 'POST', body: JSON.stringify({ pid }),
    }),

  // History
  history: (connId?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (connId) qs.set('connId', connId);
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return request<HistoryEntry[]>(`/history${q ? '?' + q : ''}`);
  },
  saveHistory: (sql: string, connId?: string, db?: string, name?: string) =>
    request<HistoryEntry>('/history', {
      method: 'POST', body: JSON.stringify({ connId, db, sql, name }),
    }),
  deleteHistory: (id: string) =>
    request<{ ok: boolean }>(`/history/${enc(id)}`, { method: 'DELETE' }),
  /** Очистка журнала запросов: mine (свои) | saved (сохранённые) | all (все, admin). */
  clearHistory: (scope: 'mine' | 'saved' | 'all', connId?: string) => {
    const qs = new URLSearchParams();
    qs.set('scope', scope);
    if (connId) qs.set('connId', connId);
    return request<{ ok: boolean; scope: string; deleted: number }>(`/history?${qs.toString()}`, { method: 'DELETE' });
  },
  /** Очистка журнала операций: all=1 — весь, иначе по подключению. Только admin. */
  clearAudit: (opts: { all?: boolean; connId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.all) qs.set('all', '1');
    if (opts.connId) qs.set('connId', opts.connId);
    const q = qs.toString();
    return request<{ ok: boolean; deleted: number }>(`/audit${q ? '?' + q : ''}`, { method: 'DELETE' });
  },

  // Backups
  backupSchedules: (connId?: string) => {
    const q = connId ? `?connId=${enc(connId)}` : '';
    return request<BackupSchedule[]>(`/backups/schedules${q}`);
  },
  createBackupSchedule: (connId: string, db?: string, format: 'sql' | 'json' = 'sql', intervalMin = 1440, keepLast = 7) =>
    request<BackupSchedule>('/backups/schedules', {
      method: 'POST', body: JSON.stringify({ connId, db, format, intervalMin, keepLast }),
    }),
  updateBackupSchedule: (scheduleId: string, patch: { enabled?: boolean; intervalMin?: number; keepLast?: number }) =>
    request<BackupSchedule>(`/backups/schedules/${enc(scheduleId)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  deleteBackupSchedule: (scheduleId: string) =>
    request<{ ok: boolean }>(`/backups/schedules/${enc(scheduleId)}`, { method: 'DELETE' }),
  runBackup: (scheduleId: string) =>
    request<unknown>(`/backups/schedules/${enc(scheduleId)}/run`, { method: 'POST' }),

  // Audit
  audit: (connId?: string, limit?: number) => {
    const qs = new URLSearchParams();
    if (connId) qs.set('connId', connId);
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return request<AuditEntry[]>(`/audit${q ? '?' + q : ''}`);
  },

  // SQLite Files
  sqliteFiles: () => request<{ name: string; bytes: number; mtime: number }[]>('/sqlite/files'),

  // Модели проекта: сохранённые схемы целиком (не точка восстановления, не откат DDL)
  models: {
    list: (opts: { q?: string; dbKind?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams();
      if (opts.q) qs.set('q', opts.q);
      if (opts.dbKind) qs.set('dbKind', opts.dbKind);
      if (opts.limit) qs.set('limit', String(opts.limit));
      const q = qs.toString();
      return request<ModelSummary[]>(`/models${q ? '?' + q : ''}`);
    },
    get: (id: string) => request<ProjectModel>(`/models/${enc(id)}`),
    create: (body: { name: string; dbKind?: string; dbName?: string; comment?: string; tables: ModelTable[] }) =>
      request<ProjectModel>('/models', { method: 'POST', body: JSON.stringify(body) }),
    importFromDatabase: (body: { connId: string; db: string; name: string; comment?: string }) =>
      request<ProjectModel>('/models/import', { method: 'POST', body: JSON.stringify(body) }),
    save: (id: string, body: { tables: ModelTable[]; comment?: string | null; expectedVersion?: number; note?: string }) =>
      request<ProjectModel>(`/models/${enc(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    rename: (id: string, body: { name?: string; comment?: string | null; dbKind?: string | null; dbName?: string | null }) =>
      request<ProjectModel>(`/models/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/models/${enc(id)}`, { method: 'DELETE' }),
    versions: (id: string) => request<ModelVersionSummary[]>(`/models/${enc(id)}/versions`),
    restoreVersion: (id: string, versionId: string) =>
      request<ProjectModel>(`/models/${enc(id)}/versions/${enc(versionId)}/restore`, { method: 'POST' }),
    apply: (id: string, body: { connId: string; db: string; dropExisting?: boolean }) =>
      request<ModelApplyResult>(`/models/${enc(id)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
    /** Сравнение модели с базой: чего не хватает, что лишнее, что разошлось. */
    diff: (id: string, body: { connId: string; db: string; includeExtra?: boolean }) =>
      request<ModelDiffResult>(`/models/${enc(id)}/diff`, { method: 'POST', body: JSON.stringify(body) })
  }
};

function enc(s: string) { return encodeURIComponent(s); }
