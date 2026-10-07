export type Theme = 'light' | 'dark';
export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
}

export type DatabaseType = 'mysql' | 'sqlite' | 'mongodb' | 'mariadb' | 'postgresql' | 'redis' | 'oracle';

// Бэкенд отдаёт список имён таблиц (/tables); kind подтягивается отдельным
// запросом ?withKind=1 там, где нужен (бейдж VIEW, удаление представлений).
export interface Table {
  name: string;
  kind?: 'table' | 'view';
}

export interface Database {
  id: string;
  name: string;
  type: DatabaseType;
  tables?: Table[];
}

export interface LogEntry {
  time: string;
  user: string;
  action: string;
  result: 'Success' | 'Error';
}

export interface SqlLogEntry {
  id: string;
  time: string;
  query: string;
  duration: string;
  rows: number;
  status: 'success' | 'error';
}

// Уровень выводится из audit.ok через toBool, поэтому возможны только
// два значения — фильтр журнала использует то же множество.
export interface SystemEvent {
  id: string;
  time: string;
  level: 'success' | 'error';
  source: string;
  message: string;
  /** Что изменилось в данных: {before, after} или {after} — из аудита. */
  before?: unknown;
  after?: unknown;
}

export interface AppWindowState {
  /**
   * Идентификатор панели в окне: произвольная строка из реестра панелей.
   */
  id: string;
  title: string;
  isDetached: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  prevBounds?: { x: number; y: number; width: number; height: number };
  zIndex: number;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  filePath?: string;
  readOnly?: boolean;
}

export interface ColumnDefinition {
  name: string;
  type: string;
  length?: number;
  nullable?: boolean;
  primary?: boolean;
  autoIncrement?: boolean;
  default?: string;
}
