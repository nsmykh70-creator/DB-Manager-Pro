import { isWriteSql } from './sql-classifier.js';
import { withCode } from './errcodes.js';
import type { ForeignKeySpec } from '../drivers/helpers.js';


export type DbKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb' | 'redis' | 'oracle';

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  /**
   * Имя сервиса Oracle (в tnsnames или как PDB).
   *
   * Отдельное поле нужно потому, что у Oracle «база» в панели — это схема
   * пользователя, и её подставляет интерфейс при каждом запросе, а поле
   * подключения хранит настоящий сервис. Без разделения выбор схемы затирал
   * сервис, и любой запрос падал с NJS-518 «Service DEMO is not registered».
   */
  serviceName?: string;
  user?: string;
  /** AES-шифр пароля, никогда plaintext. Расшифровывается только в момент коннекта. */
  password?: string; // расшифрованный, только in-memory
  passwordCipher?: string;
  filePath?: string; // только sqlite
  readOnly?: boolean;
}

export interface QueryLimits {
  maxRows: number; // default 1000
  timeoutMs: number; // default 30000
}

export interface TabularResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  execMs: number;
}

export interface Relation {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  /** Имя FK-констрейнта (mysql/pg/sqlite); undefined если драйвер не отдаёт. */
  constraint?: string;
  onDelete?: string | null;
  onUpdate?: string | null;
}

/**
 * Нормализованная модель структуры объекта. Один формат для всех драйверов,
 * чтобы UI конструктора и генератор DDL не разбирали сырые выдачи
 * SHOW COLUMNS / PRAGMA / information_schema каждый по-своему.
 */
export interface SchemaColumn {
  name: string;
  /** Тип как его отдаёт сервер: `int(11)`, `character varying(64)`, `INTEGER`. */
  type: string;
  nullable: boolean;
  /** Колонка входит в PRIMARY KEY. */
  primary: boolean;
  /** SERIAL/IDENTITY/AUTO_INCREMENT. */
  autoInc: boolean;
  default: string | null;
  /** Позиция в таблице, начиная с 1. */
  ordinal: number;
  /** Комментарий к колонке, если СУБД его поддерживает. */
  comment: string | null;
  /** Диалектные хвоста: `ON UPDATE CURRENT_TIMESTAMP`, `COLLATE ...` и т.п. */
  extra: string | null;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  /** Индекс создан для PRIMARY KEY. */
  primary: boolean;
  /** BTREE/HASH/GIN/... либо метод доступа pg. */
  type: string | null;
  columns: string[];
  /** Частичный индекс (pg WHERE). */
  where: string | null;
  /** Полное определение индекса, если сервер его отдаёт (pg_get_indexdef). */
  definition: string | null;
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface SchemaTrigger {
  name: string;
  /** BEFORE / AFTER / INSTEAD OF; null если сервер не разделяет. */
  timing: string | null;
  /** INSERT / UPDATE / DELETE. */
  event: string | null;
  /** Тело триггера (pg — полный pg_get_triggerdef). */
  statement: string;
}

export interface TableSchema {
  table: string;
  /** table | view. */
  kind: 'table' | 'view';
  comment: string | null;
  /** ENGINE=mysql, collation и прочее — только для отображения. */
  extra: Record<string, string | null>;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  triggers: SchemaTrigger[];
}

export interface ProcRow { id: string; user?: string; db?: string; command?: string; timeSec?: number; state?: string; query?: string; }
export interface DbSize { db: string; bytes: number; tables?: number; }
export interface ServerStatus {
  version: string;
  uptimeSec?: number;
  connections?: number;
  queries?: number;
  slowQueries?: number;
  processlist: ProcRow[];
  dbSizes: DbSize[];
  extra?: Record<string, unknown>;
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

export function assertWritable(cfg: ConnectionConfig, sqlOrAction: string): void {
  if (cfg.readOnly && isWriteSql(sqlOrAction)) {
    // Код нужен интерфейсу: текст остаётся английским (его читает журнал), но
    // по коду панель показывает перевод. Раньше этот отказ доходил до
    // пользователя английской строкой в русском окне.
    throw withCode(Object.assign(new Error('Connection is read-only'), { statusCode: 403 }), 'read_only_connection');
  }
}

/**
 * Отказ по настройке соединения «только чтение». Вынесен отдельно от
 * assertWritable, потому что маршруты проверяют его сами (схема, триггеры,
 * импорт, откат) — и раньше каждый из них писал английский текст заново.
 */
export function assertNotReadOnly(cfg: ConnectionConfig): void {
  if (cfg.readOnly) {
    throw withCode(Object.assign(new Error('Connection is read-only'), { statusCode: 403 }), 'read_only_connection');
  }
}

export interface DbDriver {
  readonly kind: DbKind;
  test(cfg: ConnectionConfig): Promise<{ ok: boolean; latencyMs: number }>;
  listDatabases(cfg: ConnectionConfig): Promise<string[]>;
  listTables(cfg: ConnectionConfig, db: string): Promise<string[]>;
  getSchema(cfg: ConnectionConfig, db: string, table: string): Promise<TableSchema>;
  getPage(cfg: ConnectionConfig, db: string, table: string, page: number, pageSize: number, sort?: string, filter?: string): Promise<TablePage>;
  query(cfg: ConnectionConfig, sql: string, limits: QueryLimits): Promise<TabularResult>;
  /**
   * План выполнения запроса. Опционально: поддерживают не все СУБД.
   * analyze=true в PostgreSQL ВЫПОЛНЯЕТ запрос — вызывающий обязан убедиться,
   * что это SELECT (см. routes/explain.ts).
   */
  explain?(cfg: ConnectionConfig, db: string, sql: string, opts?: { analyze?: boolean }): Promise<TabularResult>;
  /** Импорт: выполнить SQL-скрипт (несколько стейтментов). Опционально — драйвер может не поддерживать. */
  execScript?(cfg: ConnectionConfig, db: string, script: string): Promise<{ statements: number; execMs: number }>;
  /**
   * Импорт: вставить строки в таблицу (имена колонок валидируются драйвером).
   * `keepIds` — сохранить переданные _id (MongoDB): нужно для отката checkpoint,
   * иначе документы получат новые ObjectId и ссылки из других коллекций разорвутся.
   * При обычном импорте _id не передаётся, и Mongo генерирует его сама.
   */
  importRows?(cfg: ConnectionConfig, db: string, table: string, rows: Record<string, unknown>[], opts?: { keepIds?: boolean }): Promise<{ inserted: number; execMs: number }>;
  /**
   * Стриминг таблицы батчами для экспорта любого объёма.
   * Генератор держит курсор открытым до конца итерации — вызывать в try/finally через .return().
   */
  streamRows?(cfg: ConnectionConfig, db: string, table: string, batchSize?: number): AsyncGenerator<Record<string, unknown>[], void, unknown>;
  /** ER-диаграмма: внешние ключи базы. Пусто если нет/не поддерживается. */
  getRelations?(cfg: ConnectionConfig, db: string): Promise<Relation[]>;
  /** Мониторинг: версия, аптайм, процессы, размеры БД. */
  getStatus?(cfg: ConnectionConfig): Promise<ServerStatus>;
  /** Очистить таблицу (для restore). Возвращает число удалённых строк. */
  clearTable?(cfg: ConnectionConfig, db: string, table: string): Promise<{ deleted: number }>;
  /** Конструктор: создать таблицу. */
  createTable?(cfg: ConnectionConfig, db: string, def: CreateTableDef): Promise<{ ok: true; statement: string }>;
  /**
   * Конструктор: создать представление (`CREATE VIEW ... AS <SELECT>`).
   * SELECT проверяется валидатором (только чтение); MongoDB/Redis без метода → 400.
   */
  createView?(cfg: ConnectionConfig, db: string, def: ViewDef): Promise<{ ok: true; statement: string }>;
  /** Конструктор: удалить представление. */
  dropView?(cfg: ConnectionConfig, db: string, name: string): Promise<{ ok: true; statement: string }>;
  /**
   * Схемы PostgreSQL (`CREATE SCHEMA`). Остальные СУБД: у MySQL/MariaDB схема =
   * база, у Oracle схема = пользователь, у SQLite/MongoDB/Redis схем нет —
   * метод не определён → 400.
   */
  createSchema?(cfg: ConnectionConfig, db: string, name: string): Promise<{ ok: true; statement: string }>;
  /** Удалить схему. `cascade=true` — вместе с содержимым (требует подтверждения в UI). */
  dropSchema?(cfg: ConnectionConfig, db: string, name: string, cascade?: boolean): Promise<{ ok: true; statement: string }>;
  /**
   * Конструктор: набор DDL-операций. Возвращает выполненные SQL — их пишет
   * маршрут в историю и аудит, поэтому «что именно применилось» видно всегда.
   */
  alterTable?(cfg: ConnectionConfig, db: string, table: string, ops: AlterOp[]): Promise<{ ok: true; statements: string[]; applied: number; transactional: boolean }>;
  /** Конструктор: удалить таблицу. */
  dropTable?(cfg: ConnectionConfig, db: string, table: string): Promise<{ ok: true; statement: string }>;
  /**
   * Построить SQL для alter-пакета, ничего не выполняя. Нужен для предпросмотра
   * (diff «до → после») и для undo: драйвер возвращает ровно те же стейтменты,
   * которые затем применит alterTable, поэтому предпросмотр не расходится с
   * реальностью. Отсутствие метода = драйвер не умеет DDL.
   */
  planAlter?(cfg: ConnectionConfig, db: string, table: string, ops: AlterOp[]): Promise<{ statements: string[]; transactional: boolean }>;
  /** Конструктор: создать триггер. */
  createTrigger?(cfg: ConnectionConfig, db: string, table: string, def: TriggerDef): Promise<{ ok: true; statement: string }>;
  /** Конструктор: удалить триггер (PostgreSQL требует имени таблицы). */
  dropTrigger?(cfg: ConnectionConfig, db: string, table: string, name: string): Promise<{ ok: true; statement: string }>;
  /** Управление пользователями СУБД (SQLite — пусто). host — хост MySQL-пользователя (user@host). */
  listDbUsers?(cfg: ConnectionConfig): Promise<DbUser[]>;
  createDbUser?(cfg: ConnectionConfig, username: string, password: string, db?: string, host?: string): Promise<{ ok: true }>;
  dropDbUser?(cfg: ConnectionConfig, username: string, db?: string, host?: string): Promise<{ ok: true }>;
  listGrants?(cfg: ConnectionConfig, username: string, db?: string, host?: string): Promise<string[]>;
  grant?(cfg: ConnectionConfig, username: string, privilege: string, db?: string, table?: string, host?: string): Promise<{ ok: true }>;
  revoke?(cfg: ConnectionConfig, username: string, privilege: string, db?: string, table?: string, host?: string): Promise<{ ok: true }>;
  insertRow?(cfg: ConnectionConfig, db: string, table: string, row: Record<string, unknown>): Promise<{ insertedId?: unknown }>;
  updateRow?(cfg: ConnectionConfig, db: string, table: string, filter: Record<string, unknown>, patch: Record<string, unknown>): Promise<{ matched: number }>;
  /**
   * Массовое обновление/удаление одним выражением по строке фильтра панели
   * (`col=value AND col2>10`). Необязательно: драйвер без этих методов обрабатывается
   * построчно в routes/bulk.ts, просто медленнее.
   *
   * Фильтр трактуется ровно так же, как в getPage, — оба собирают условие через
   * buildWhere(), поэтому предпросмотр и применение не могут разойтись.
   */
  updateRowsBulk?(cfg: ConnectionConfig, db: string, table: string, filter: string | undefined, patch: Record<string, unknown>): Promise<{ affected: number }>;
  deleteRowsBulk?(cfg: ConnectionConfig, db: string, table: string, filter: string | undefined): Promise<{ affected: number }>;
  /**
   * Точное чтение строк по тому же фильтру-объекту, что использует updateRow/deleteRow.
   * Нужно для отката изменений данных: сначала воть объект до операции, потому что возврат строку по значениям, а не по шаблону всей таблице.
   * `limit` ограничивается сверху (возврат на limit+1, чтобы понять, обрезано ли это не все строки).
   */
  findRows?(cfg: ConnectionConfig, db: string, table: string, filter: Record<string, unknown>, limit?: number): Promise<Record<string, unknown>[]>;
  deleteRow?(cfg: ConnectionConfig, db: string, table: string, filter: Record<string, unknown>): Promise<{ deleted: number }>;
  killQuery?(cfg: ConnectionConfig, pid: string): Promise<{ ok: true }>;
}

export interface DbUser { username: string; host?: string; db?: string; roles?: string[]; }

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
  autoInc?: boolean;
  default?: string | null;
  /** Комментарий к колонке (MySQL inline, PG/Oracle через COMMENT ON). */
  comment?: string | null;
}

export interface CreateTableDef {
  name: string;
  columns: ColumnDef[];
  /**
   * Внешние ключи, объявляемые прямо в CREATE TABLE.
   *
   * Нужны SQLite: у него нет `ALTER TABLE ADD CONSTRAINT`, поэтому ключ,
   * добавленный после создания таблицы, добавить нельзя. Модель, применённая к
   * SQLite, раньше теряла все связи с объяснением «пересоздайте таблицу»; теперь
   * они попадают в определение таблицы, как это и сделано в SQL.
   *
   * Для MySQL/PG/Oracle тоже учитываются: иначе конструктор создавал таблицу
   * без связей, хотя UI их уже показывает.
   */
  foreignKeys?: ForeignKeySpec[];
  /** Индексы: создаются отдельными CREATE INDEX после CREATE TABLE. */
  indexes?: IndexDef[];
  /** Комментарий к таблице (MySQL inline, PG/Oracle через COMMENT ON). */
  comment?: string | null;
  /** Только MySQL/MariaDB: ENGINE и CHARSET/COLLATE таблицы. */
  engine?: string | null;
  charset?: string | null;
  collate?: string | null;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique?: boolean;
  /** BTREE/HASH/GIN — только если СУБД это поддерживает. */
  type?: string;
  /** Частичный индекс (PostgreSQL). */
  where?: string;
}

export interface ForeignKeyDef {
  /** Обязателен для MySQL/PG, для SQLite имя генерирует сервер. */
  name?: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TriggerDef {
  name: string;
  /** BEFORE | AFTER | INSTEAD OF. */
  timing: string;
  /** INSERT | UPDATE | DELETE. */
  event: string;
  /**
   * Тело триггера. Для PostgreSQL — имя уже созданной функции
   * (pg_get_triggerdef показывает EXECUTE FUNCTION), для MySQL и SQLite —
   * SQL-тело: у SQLite оно оборачивается в BEGIN ... END.
   */
  statement: string;
}

/** Определение представления: имя + SELECT-запрос (проверяется checkViewSql). */
export interface ViewDef {
  name: string;
  sql: string;
}

export type AlterOp =
  | { op: 'addColumn'; column: ColumnDef }
  | { op: 'dropColumn'; name: string }
  | { op: 'renameColumn'; from: string; to: string }
  /** Тип / nullable / DEFAULT существующей колонки. */
  | { op: 'alterColumn'; name: string; column: ColumnDef }
  | { op: 'renameTable'; to: string }
  | { op: 'addIndex'; index: IndexDef }
  | { op: 'dropIndex'; name: string }
  | { op: 'addForeignKey'; fk: ForeignKeyDef }
  | { op: 'dropForeignKey'; name: string }
  /** Первичный ключ отдельно от колонки: он может быть составным. */
  | { op: 'setPrimaryKey'; columns: string[] }
  | { op: 'dropPrimaryKey' };
