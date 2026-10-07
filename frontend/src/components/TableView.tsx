import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Copy, Download, Edit2, FileCode2, Key, LayoutTemplate, Play, Plus, Search, Settings2, Trash2, Undo2, X } from 'lucide-react';
import { SqlEditor } from './SqlEditor';
import { EditRowModal } from './modals/EditRowModal';
import { EditColumnModal } from './modals/EditColumnModal';
import { QuickOpen } from './QuickEdit';
import { api, BulkRowsResult, DataUndoEntry, DbKind, errorText, notifyTablesChanged, PanelUser, TabularResult } from '../api';
import { useLanguage } from '../contexts/LanguageContext';
import { formatDateTime } from '../intl';
import { SupportedDbDialect } from '../dbDialects';

function dialectFor(kind?: DbKind): SupportedDbDialect {
return kind === 'postgres' ? 'postgresql' : kind === 'sqlite' ? 'sqlite' : kind === 'mongodb' ? 'mongodb' : kind === 'redis' ? 'redis' : kind === 'mariadb' ? 'mariadb' : kind === 'oracle' ? 'oracle' : 'mysql';
}

function quote(name: string, kind?: DbKind): string {
  if (kind === 'postgres' || kind === 'sqlite' || kind === 'oracle') return `"${name}"`;
  return `\`${name}\``;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function makeDefaultSql(table: string, kind?: DbKind): string {
  if (kind === 'mongodb') return JSON.stringify({ collection: table, filter: {}, limit: 50 });
  if (kind === 'redis') return JSON.stringify({ cmd: 'KEYS', pattern: '*' });
  return `SELECT * FROM ${quote(table, kind)} LIMIT 50;`;
}

/**
 * Ключ пользователя БД в селекте привилегий: `username@host`.
 * Хост нужен MySQL/MariaDB (`SHOW GRANTS FOR user@host`); у остальных драйверов
 * хоста нет и ключ вырождается в `username@`. Символа `@` в именах быть не может
 * (валидатор имён его запрещает), поэтому разбор по последнему `@` однозначен.
 */
function privilegeUserKey(user: { username: string; host?: string | null }): string {
  return `${user.username}@${user.host ?? ''}`;
}

function splitPrivilegeUserKey(key: string): { username: string; host?: string } {
  const at = key.lastIndexOf('@');
  if (at < 0) return { username: key };
  return { username: key.slice(0, at), host: key.slice(at + 1) || undefined };
}

type NullToken = 'YES' | 'NO' | '-';

/** Любое значение «разрешён ли NULL» приводим к токену.
 * Принимаем русские «Да»/«Нет» и английские Yes/No: правка значения идёт
 * через QuickEdit, где пользователь может ввести любой из них, а раньше поле
 * сравнивалось с русским литералом и тихо становилось NOT NULL. */
function toNullToken(value: unknown): NullToken {
  const s = String(value ?? '').trim().toLowerCase();
  if (['yes', 'да', 'y', 'true', '1'].includes(s)) return 'YES';
  if (['no', 'нет', 'n', 'false', '0'].includes(s)) return 'NO';
  return '-';
}

interface LocalColumn {
  id: number;
  name: string;
  type: string;
  length: string;
  /** Токен «разрешает ли NULL», а не надпись: 'YES' | 'NO' | '-'.
   * Раньше здесь лежало русское «Да»/«Нет», поэтому колонка оставалась
   * русской при любом языке, а правка из QuickEdit писала в поле русский текст.
   * Показывается через t('ui.yes') / t('ui.no'), а принимается обратно через
   * toNullToken — старые значения из сохранённых планов тоже. */
  isNull: 'YES' | 'NO' | '-';
  default: string;
  extra: string;
  isPk: boolean;
  isNew?: boolean;
}

type LocalIndex = { name: string; type: string; unique: boolean; primary: boolean; columns: string };

/** Собственный FK таблицы — из TableSchema (с именем констрейнта и правилами). */
type LocalForeignKey = { name: string; columns: string; refTable: string; refColumns: string; onDelete: string; onUpdate: string; outgoing: boolean };
type LocalTrigger = { name: string; timing: string; event: string; statement: string };

function normalizeColumn(column: any, id: number): LocalColumn {
  const name = String(column.name ?? column.column_name ?? column.Field ?? column.field ?? '');
  const type = name === '_id'
    ? 'ObjectId'
    : String(column.type ?? column.data_type ?? column.Type ?? column.dataType ?? '-');
  return {
    id,
    name,
    type,
    length: String(column.length ?? column.character_maximum_length ?? column.Length ?? '-'),
    isNull: column.nullable === false || column.is_nullable === 'NO' || column.Null === 'NO' ? 'NO' : column.nullable === true || column.is_nullable === 'YES' ? 'YES' : '-',
    default: String(column.default ?? column.column_default ?? column.Default ?? '-'),
    extra: String(column.extra ?? column.Extra ?? '-'),
    isPk: Boolean(column.primary || column.is_primary || column.Key === 'PRI' || column.pk || name === '_id'),
  };
}

function normalizeIndexes(schema: any): LocalIndex[] {
  const raw = Array.isArray(schema) ? [] : schema?.indexes;
  if (!Array.isArray(raw)) return [];
  return raw.map((index: any) => ({
    name: String(index.name ?? index.Key_name ?? index.index_name ?? '-'),
    type: String(index.type ?? index.Index_type ?? index.index_type ?? '-'),
    unique: Boolean(index.unique ?? (index.Non_unique === 0 || index.non_unique === 0)),
    primary: Boolean(index.primary),
    // Новая модель отдаёт columns как string[]; старые драйверы — одной строкой.
    columns: Array.isArray(index.columns) ? index.columns.join(', ') : String(index.columns ?? index.column ?? index.Column_name ?? index.indexdef ?? '-'),
  }));
}

function normalizeForeignKeys(schema: any): LocalForeignKey[] {
  const raw = Array.isArray(schema) ? [] : schema?.foreignKeys;
  if (!Array.isArray(raw)) return [];
  return raw.map((fk: any) => ({
    name: String(fk.name ?? '-'),
    columns: Array.isArray(fk.columns) ? fk.columns.join(', ') : String(fk.columns ?? '-'),
    refTable: String(fk.refTable ?? fk.ref_table ?? '-'),
    refColumns: Array.isArray(fk.refColumns) ? fk.refColumns.join(', ') : String(fk.refColumns ?? fk.ref_columns ?? '-'),
    onDelete: String(fk.onDelete ?? fk.on_delete ?? '') || '—',
    onUpdate: String(fk.onUpdate ?? fk.on_update ?? '') || '—',
    outgoing: true,
  }));
}

function normalizeTriggers(schema: any): LocalTrigger[] {
  const raw = Array.isArray(schema) ? [] : schema?.triggers;
  if (!Array.isArray(raw)) return [];
  return raw.map((trg: any) => ({
    name: String(trg.name ?? '-'),
    timing: String(trg.timing ?? '') || '—',
    event: String(trg.event ?? '') || '—',
    statement: String(trg.statement ?? ''),
  }));
}

interface TableViewProps {
  activeDb: string;
  tableName: string;
  onBack: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isDetached?: boolean;
  onToggleDetach?: () => void;
  connId?: string | null;
  connKind?: DbKind;
  connectionReadOnly?: boolean;
  userRole?: PanelUser['role'];
  /** Кнопки управления панелью в шапке (свернуть, развернуть, открепить). */
  headerExtra?: React.ReactNode;
}

export function TableView({ activeDb, tableName, onBack, addToast, isDetached, onToggleDetach, connId, connKind, connectionReadOnly, userRole, headerExtra }: TableViewProps) {
  const { t, lang } = useLanguage();
  // props уже пробраны из App: подключение read-only или роль панели readonly.
  // Controls, которые всё равно нельзя выполнить, не показываем вовсе.
  const readOnly = Boolean(connectionReadOnly) || userRole === 'readonly';
  const [activeTab, setActiveTab] = useState('structure');
  const [columns, setColumns] = useState<LocalColumn[]>([]);
  const [indexes, setIndexes] = useState<LocalIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<LocalForeignKey[]>([]);
  const [triggers, setTriggers] = useState<LocalTrigger[]>([]);
  const [tableMeta, setTableMeta] = useState<{ kind: string; comment: string; extra: Record<string, string | null> }>({ kind: 'table', comment: '', extra: {} });
  // Формы конструктора индексов и внешних ключей (вкладки «Индексы»/«Связи»)
  const [indexDraft, setIndexDraft] = useState({ name: '', columns: [] as string[], unique: false, type: '' });
  const [fkDraft, setFkDraft] = useState({ name: '', columns: [] as string[], refTable: '', refColumns: [] as string[], onDelete: '', onUpdate: '' });
  const [triggerDraft, setTriggerDraft] = useState({ name: '', timing: 'BEFORE', event: 'INSERT', statement: '' });
  const [designBusy, setDesignBusy] = useState(false);
  // Откат изменений ДАННЫХ (не структуры): последние операции над строками этой
  // таблицы с возможностью отменить или повторить последнюю из них.
  const [dataUndoEntries, setDataUndoEntries] = useState<DataUndoEntry[]>([]);
  const [dataUndoOpen, setDataUndoOpen] = useState(false);
  const [dataUndoBusy, setDataUndoBusy] = useState(false);
  // Последний предпросмотр DDL: показывается в панели над вкладками, чтобы
  // пользователь видел фактический SQL до и после применения.
  const [designPreview, setDesignPreview] = useState<{ statements: string[]; before: string[]; transactional: boolean; hint: string } | null>(null);
  const [dataRows, setDataRows] = useState<Record<string, unknown>[]>([]);
  const [dataColumns, setDataColumns] = useState<string[]>([]);
  const [relationRows, setRelationRows] = useState<any[]>([]);
  const [privilegeUsers, setPrivilegeUsers] = useState<{ username: string; host?: string }[]>([]);
  const [privilegeUser, setPrivilegeUser] = useState('');
  const [privilegeGrants, setPrivilegeGrants] = useState<string[]>([]);
  const [privilege, setPrivilege] = useState('SELECT');
  const [privilegeUsersLoading, setPrivilegeUsersLoading] = useState(false);
  const [privilegeGrantsLoading, setPrivilegeGrantsLoading] = useState(false);
  const [privilegeAction, setPrivilegeAction] = useState<'grant' | 'revoke' | null>(null);
  const [privilegeError, setPrivilegeError] = useState('');
  const [editingColumn, setEditingColumn] = useState<LocalColumn | null>(null);
  const [editingRow, setEditingRow] = useState<any | null>(null);
  // Быстрое редактирование значения в сетке: {rowIndex, column, value}
  const [cellEdit, setCellEdit] = useState<{ rowIndex: number; column: string; value: string } | null>(null);
  const [cellSaving, setCellSaving] = useState(false);
  const [editingRowOriginal, setEditingRowOriginal] = useState<Record<string, unknown> | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  // Постраничность данных приходит из /rows: page/pageSize — реальные
  // параметры запроса, а не локальный срез уже загруженной страницы.
  const [dataPage, setDataPage] = useState(1);
  const [dataPageSize, setDataPageSize] = useState(50);
  const [dataTotal, setDataTotal] = useState<number | null>(null);
  const [dataTruncated, setDataTruncated] = useState(false);
  const [filter, setFilter] = useState('');
  const [sql, setSql] = useState(makeDefaultSql(tableName, connKind));
  const [sqlResult, setSqlResult] = useState<TabularResult | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);
  const dialect = dialectFor(connKind);
  const canAlter = !readOnly && connKind !== 'mongodb' && connKind !== 'redis';
  const canClone = !readOnly && (connKind === 'mysql' || connKind === 'mariadb');
  const canWriteRows = !readOnly;
  // Быстрое редактирование по ячейке работает только при известном PK: без него
  // фильтр строки неоднозначен и PATCH может задеть не ту запись.
  const rowsEditable = canWriteRows && columns.some(column => column.isPk);
  const privilegesReadOnly = Boolean(connectionReadOnly) || userRole !== 'admin';
  // Oracle отдаёт GRANT только на объектных правах таблицы: CREATE/DROP/ALTER/
// INDEX у него — права схемы, а не таблицы, и GRANT по таблице их не примет.
const privilegeOptions = connKind === 'postgres'
    ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL PRIVILEGES']
    : connKind === 'oracle'
      ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'ALL PRIVILEGES'];

  const loadTable = useCallback(async () => {
    if (!connId || !activeDb || !tableName) return;
    try {
      const [schema, page] = await Promise.all([
        api.schema(connId, activeDb, tableName),
        api.rows(connId, activeDb, tableName, { page: dataPage, pageSize: dataPageSize }),
      ]);
      const schemaAny = schema as any;
      const rawColumns = connKind === 'redis' ? [] : Array.isArray(schemaAny) ? schemaAny : schemaAny?.columns;
      const nextColumns = Array.isArray(rawColumns) ? rawColumns.map(normalizeColumn) : [];
      setColumns(nextColumns);
      setIndexes(normalizeIndexes(schemaAny));
      setForeignKeys(normalizeForeignKeys(schemaAny));
      setTriggers(normalizeTriggers(schemaAny));
      setTableMeta({
        kind: String(schemaAny?.kind ?? 'table'),
        comment: String(schemaAny?.comment ?? ''),
        extra: (schemaAny?.extra ?? {}) as Record<string, string | null>,
      });
      setDataColumns(page.columns || []);
      setDataRows(page.rows || []);
      setDataTotal(typeof page.totalApprox === 'number' ? page.totalApprox : null);
      setDataTruncated(Boolean(page.truncated));
    } catch (error: any) {
      addToast(t('table.errorLoadTable') + error.message, 'error');
    }
  }, [activeDb, addToast, connId, dataPage, dataPageSize, tableName]);

  const loadRelations = useCallback(async () => {
    if (!connId || !activeDb) return;
    try {
      const result = await api.er(connId, activeDb);
      // Собственные FK берём из схемы таблицы (там есть имя констрейнта и правила),
      // отсюда забираем только входящие ссылки на эту таблицу.
      setRelationRows(result.relations.filter(item => item.refTable === tableName && item.table !== tableName));
    } catch {
      setRelationRows([]);
    }
  }, [activeDb, connId, tableName]);

  const loadPrivilegeUsers = useCallback(async () => {
    if (!connId) return;
    setPrivilegeUsersLoading(true);
    setPrivilegeError('');
    try {
      const users = await api.dbUsers(connId);
      setPrivilegeUsers(users);
      setPrivilegeUser(current => users.some(user => privilegeUserKey(user) === current) ? current : users[0] ? privilegeUserKey(users[0]) : '');
      if (!users.length) setPrivilegeGrants([]);
    } catch (error: any) {
      setPrivilegeUsers([]);
      setPrivilegeUser('');
      setPrivilegeGrants([]);
      setPrivilegeError(t('table.errorLoadDbUsers') + error.message);
    } finally {
      setPrivilegeUsersLoading(false);
    }
  }, [activeDb, connId, tableName]);

  const loadPrivilegeGrants = useCallback(async () => {
    if (!connId || !privilegeUser) {
      setPrivilegeGrants([]);
      return;
    }
    setPrivilegeGrantsLoading(true);
    setPrivilegeError('');
    try {
      const { username, host } = splitPrivilegeUserKey(privilegeUser);
      setPrivilegeGrants(await api.grants(connId, username, activeDb, host));
    } catch (error: any) {
      setPrivilegeGrants([]);
      setPrivilegeError(t('table.errorLoadPrivileges') + error.message);
    } finally {
      setPrivilegeGrantsLoading(false);
    }
  }, [activeDb, connId, privilegeUser, tableName]);

  const changePrivilege = async (action: 'grant' | 'revoke') => {
    if (!connId || !privilegeUser || privilegesReadOnly) return;
    setPrivilegeAction(action);
    setPrivilegeError('');
    try {
      const change = action === 'grant' ? api.grant : api.revoke;
      const { username, host } = splitPrivilegeUserKey(privilegeUser);
      await change(connId, username, privilege, activeDb, tableName, host);
      addToast(action === 'grant' ? t('table.privilegeGranted') : t('table.privilegeRevoked'), 'success');
      await loadPrivilegeGrants();
    } catch (error: any) {
      const message = action === 'grant' ? t('table.errorGrantPrivilege') : t('table.errorRevokePrivilege');
      setPrivilegeError(message + error.message);
      addToast(message + error.message, 'error');
    } finally {
      setPrivilegeAction(null);
    }
  };

  useEffect(() => {
    setSql(makeDefaultSql(tableName, connKind));
    setSqlResult(null);
    loadTable();
  }, [activeDb, connId, connKind, dataVersion, loadTable, tableName]);

  useEffect(() => {
    loadRelations();
  }, [loadRelations]);

  useEffect(() => {
    if (activeTab === 'privileges') loadPrivilegeUsers();
  }, [activeTab, loadPrivilegeUsers]);

  useEffect(() => {
    if (activeTab === 'privileges' && privilegeUser) loadPrivilegeGrants();
  }, [activeTab, loadPrivilegeGrants, privilegeUser]);

  useEffect(() => {
    setPrivilegeUser('');
    setPrivilegeGrants([]);
    setPrivilegeError('');
  }, [connId, activeDb, tableName]);

  const refresh = () => {
    setDataVersion(value => value + 1);
    loadRelations();
  };

  // Журнал отката данных: подтягиваем при открытии панели и после любой правки строк,
  // иначе список показывал бы уже отменённые операции.
  const loadDataUndo = useCallback(async () => {
    if (!connId) return;
    try {
      const entries = await api.dataUndo.list(connId, { db: activeDb, table: tableName, limit: 20 });
      setDataUndoEntries(entries);
    } catch {
      setDataUndoEntries([]);
    }
  }, [activeDb, connId, tableName]);

  const openDataUndo = async () => {
    setDataUndoOpen(true);
  };

  // Список отката должен отражать и уже отменённые операции, поэтому после любой
  // правки данных (dataVersion) перечитываем его заново.
  useEffect(() => {
    if (dataUndoOpen) void loadDataUndo();
  }, [dataUndoOpen, dataVersion, loadDataUndo]);

  const applyDataUndoAction = async (entry: DataUndoEntry, direction: 'undo' | 'redo') => {
    if (!confirm(direction === 'undo'
      ? t('table.confirmRestoreData', { summary: entry.summary })
      : t('table.confirmRedoOperation', { summary: entry.summary }))) return;
    setDataUndoBusy(true);
    try {
      const r = direction === 'undo' ? await api.dataUndo.undo(entry.id) : await api.dataUndo.redo(entry.id);
      addToast(`${direction === 'undo' ? t('table.undone') : t('table.redone')}: ${r.affected} ${r.affected === 1 ? t('table.rowsAffected') : t('table.rowsPlural')}`, 'success');
      await loadDataUndo();
      refresh();
    } catch (error: any) {
      addToast(t('table.errorGeneric') + error.message, 'error');
    } finally {
      setDataUndoBusy(false);
    }
  };

  const executeSql = async () => {
    if (!connId || !sql.trim()) return;
    setSqlLoading(true);
    try {
      const result = await api.query(connId, sql.trim(), activeDb);
      setSqlResult(result);
      addToast(t('table.queryDone', { rows: result.rowCount }), 'success');
      // DDL в SQL-вкладке меняет и данные, и список таблиц: и то и другое должно
      // обновиться сразу, а не после перезагрузки страницы.
      if (/\b(create|drop|alter|truncate)\s+(table|collection|index)\b/i.test(sql)) {
        refresh();
        notifyTablesChanged();
      }
    } catch (error: any) {
      setSqlResult(null);
      addToast(t('table.errorSql') + error.message, 'error');
    } finally {
      setSqlLoading(false);
    }
  };

  const exportTable = async () => {
    if (!connId) return;
    try {
      const response = await api.exportTable(connId, activeDb, tableName, 'sql');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${tableName}.sql`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      addToast(t('table.errorExport') + error.message, 'error');
    }
  };

  const cloneTable = async () => {
    if (!connId || !canClone) return;
    const name = window.prompt(t('table.copyNameLabel'), `${tableName}_copy`);
    if (!name || name === tableName) return;
    try {
      await api.query(connId, `CREATE TABLE ${quote(name, connKind)} LIKE ${quote(tableName, connKind)};`, activeDb);
      addToast(t('table.cloneDone', { name: name }), 'success');
      // Клон появился в базе, но список таблиц Sidebar знает только о том, что
      // загружал раньше: без этого увидеть клон можно было только после F5.
      notifyTablesChanged();
    } catch (error: any) {
      addToast(t('table.errorClone') + error.message, 'error');
    }
  };

  const buildColumnDef = (column: LocalColumn) => ({
    name: column.name,
    type: /^(VARCHAR|CHAR|NUMERIC|DECIMAL)$/i.test(column.type) && column.length && column.length !== '-' ? `${column.type}(${column.length})` : column.type,
    nullable: column.isNull === 'YES',
    primary: column.isPk,
    autoInc: column.isPk && /AUTO_INCREMENT|AUTOINCREMENT|IDENTITY|SERIAL/i.test(column.extra),
    default: column.default && column.default !== '-' ? column.default : null,
  });

  /**
   * Изменение существующей колонки уходит в design API (alterColumn + операции
   * над PK), а не в ad-hoc SQL: раньше здесь собирался ALTER TABLE вручную,
   * у PostgreSQL имя PK-констрейнта угадывалось по шаблону `${table}_pkey`.
   *
   * `targetName` — имя колонки ПОСЛЕ возможного переименования. Операции
   * выполняются по порядку, и renameColumn идёт первым, поэтому alterColumn
   * должен обращаться к новому имени: со старым он падал бы с «колонки нет»,
   * переименование применялось, а пользователь видел ошибку и оставшееся
   * открытым окно.
   */
  const buildColumnOps = (column: LocalColumn, original: LocalColumn, targetName: string) => {
    const ops: any[] = [];
    const def = buildColumnDef(column);
    const typeChanged = original.type !== column.type || original.length !== column.length;
    const nullChanged = toNullToken(original.isNull) !== toNullToken(column.isNull);
    const defaultChanged = original.default !== column.default;
    if (typeChanged || nullChanged || defaultChanged) {
      ops.push({ op: 'alterColumn', name: targetName, column: def });
    }
    if (original.isPk !== column.isPk) {
      if (original.isPk) ops.push({ op: 'dropPrimaryKey' });
      if (column.isPk) ops.push({ op: 'setPrimaryKey', columns: [column.name] });
    }
    return ops;
  };

  const saveColumn = async (updated: LocalColumn) => {
    if (!connId || !canAlter) {
      addToast(t('table.driverNoAlter'), 'info');
      return;
    }
    setSavingColumn(true);
    try {
      if (updated.isNew) {
        await api.alterTable(connId, activeDb, tableName, [{ op: 'addColumn', column: buildColumnDef(updated) }]);
      } else {
        const original = columns.find(column => column.id === updated.id);
        if (!original) return;
        const ops: any[] = [];
        if (original.name !== updated.name) ops.push({ op: 'renameColumn', from: original.name, to: updated.name });
        // alterColumn выполняется после переименования, поэтому обращается к
        // новому имени: со старым колонка уже не существует.
        ops.push(...buildColumnOps(updated, original, updated.name));
        if (ops.length) await api.alterTable(connId, activeDb, tableName, ops);
      }
      setEditingColumn(null);
      addToast(t('table.columnSaved'), 'success');
      refresh();
    } catch (error: any) {
      addToast(t('table.errorAlterColumn') + error.message, 'error');
    } finally {
      setSavingColumn(false);
    }
  };

  const deleteColumn = async (column: LocalColumn) => {
    if (!connId || !canAlter) return;
    if (!confirm(t('table.confirmDropColumn', { name: column.name }))) return;
    try {
      await api.alterTable(connId, activeDb, tableName, [{ op: 'dropColumn', name: column.name }]);
      addToast(t('table.columnDropped'), 'success');
      refresh();
    } catch (error: any) {
      addToast(t('table.errorDropColumn') + error.message, 'error');
    }
  };

  // SQLite пересобирает таблицу под alterColumn/PK/FK (rebuild в драйвере),
  // поэтому контролы показываем везде, где есть alter: прятать нужно только
  // там, где DDL нет вовсе (mongodb/redis — это уже исключает canAlter).
  const canDesignIndexes = canAlter;
  const canDesignForeignKeys = canAlter;

  const runDesignOps = async (ops: any[], successMessage: string) => {
    if (!connId || ops.length === 0) return;
    setDesignBusy(true);
    try {
      // Предпросмотр: показываем ровно тот SQL, который сейчас применим.
      // Применять можно и без предпросмотра, но он обязателен при отказе.
      let preview: Awaited<ReturnType<typeof api.previewAlter>> | null = null;
      try {
        preview = await api.previewAlter(connId, activeDb, tableName, ops);
      } catch (e: any) {
        addToast(t('table.errorDdlPreview') + e.message, 'error');
        return;
      }
      setDesignPreview({ statements: preview.statements, before: preview.before, transactional: preview.transactional, hint: preview.applyHint });
      const result = await api.alterTable(connId, activeDb, tableName, ops);
      const count = result?.statements?.length ?? 0;
      addToast(successMessage + (count > 1 ? t('table.rollbackInfo', { count, mode: result?.transactional ? t('table.rollbackInfoMode') : t('table.ddlNoRollbackShort') }) : ''), 'success');
      refresh();
    } catch (error: any) {
      addToast(t('table.errorLabel') + error.message, 'error');
    } finally {
      setDesignBusy(false);
    }
  };

  const toggleIndexColumn = (column: string) => {
    setIndexDraft(draft => ({
      ...draft,
      columns: draft.columns.includes(column) ? draft.columns.filter((c) => c !== column) : [...draft.columns, column],
    }));
  };

  const addIndex = async () => {
    if (!indexDraft.name.trim()) { addToast(t('table.indexNameRequired'), 'error'); return; }
    if (!indexDraft.columns.length) { addToast(t('table.pickColumnRequired'), 'error'); return; }
    const index: any = { name: indexDraft.name.trim(), columns: indexDraft.columns, unique: indexDraft.unique };
    if (indexDraft.type.trim()) index.type = indexDraft.type.trim();
    await runDesignOps([{ op: 'addIndex', index }], t('table.indexCreated'));
    setIndexDraft({ name: '', columns: [], unique: false, type: '' });
  };

  const dropIndex = async (index: LocalIndex) => {
    if (!confirm(t('table.confirmDropIndex', { name: index.name }))) return;
    if (index.primary) { addToast(t('table.pkIndexNote'), 'info'); return; }
    await runDesignOps([{ op: 'dropIndex', name: index.name }], t('table.indexDropped'));
  };

  const toggleFkColumn = (side: 'columns' | 'refColumns', column: string) => {
    setFkDraft(draft => ({
      ...draft,
      [side]: draft[side].includes(column) ? draft[side].filter((c) => c !== column) : [...draft[side], column],
    }));
  };

  const addForeignKey = async () => {
    if (!fkDraft.refTable.trim()) { addToast(t('table.fkTableRequired'), 'error'); return; }
    if (!fkDraft.columns.length || fkDraft.columns.length !== fkDraft.refColumns.length) {
      addToast(t('table.fkColumnsMismatch'), 'error');
      return;
    }
    const fk: any = {
      columns: fkDraft.columns,
      refTable: fkDraft.refTable.trim(),
      refColumns: fkDraft.refColumns,
    };
    if (fkDraft.name.trim()) fk.name = fkDraft.name.trim();
    if (fkDraft.onDelete) fk.onDelete = fkDraft.onDelete;
    // У Oracle нет ON UPDATE для внешних ключей (только ON DELETE): селект для
    // него скрыт ниже, здесь — страховка, чтобы не уехал мусор из состояния.
    if (fkDraft.onUpdate && connKind !== 'oracle') fk.onUpdate = fkDraft.onUpdate;
    await runDesignOps([{ op: 'addForeignKey', fk }], t('table.fkCreated'));
    setFkDraft({ name: '', columns: [], refTable: '', refColumns: [], onDelete: '', onUpdate: '' });
  };

  const dropForeignKey = async (fk: LocalForeignKey) => {
    if (!confirm(t('table.confirmDropForeignKey', { name: fk.name }))) return;
    await runDesignOps([{ op: 'dropForeignKey', name: fk.name }], t('table.fkDropped'));
  };

  // canAlter уже исключает mongodb/redis: у них нет ни DDL, ни триггеров
  const canDesignTriggers = canAlter;

  const addTrigger = async () => {
    if (!connId) return;
    if (!triggerDraft.name.trim()) { addToast(t('table.triggerNameRequired'), 'error'); return; }
    if (!triggerDraft.statement.trim()) { addToast(t('table.triggerBodyRequired'), 'error'); return; }
    setDesignBusy(true);
    try {
      await api.createTrigger(connId, activeDb, tableName, {
        name: triggerDraft.name.trim(),
        timing: triggerDraft.timing,
        event: triggerDraft.event,
        statement: triggerDraft.statement.trim(),
      });
      addToast(t('table.triggerCreated'), 'success');
      setTriggerDraft({ name: '', timing: triggerDraft.timing, event: triggerDraft.event, statement: '' });
      refresh();
    } catch (error: any) {
      addToast(t('table.errorCreateTrigger') + error.message, 'error');
    } finally {
      setDesignBusy(false);
    }
  };

  const dropTrigger = async (trigger: LocalTrigger) => {
    if (!connId) return;
    if (!confirm(t('table.confirmDropTrigger', { name: trigger.name }))) return;
    setDesignBusy(true);
    try {
      await api.dropTrigger(connId, activeDb, tableName, trigger.name);
      addToast(t('table.triggerDropped'), 'success');
      refresh();
    } catch (error: any) {
      addToast(t('table.errorDropTrigger') + error.message, 'error');
    } finally {
      setDesignBusy(false);
    }
  };

  /**
   * Откат последнего DDL-пакета. Автоматически возвращаются индексы, внешние
   * ключи и триггеры; изменения колонок сервер откатить не может, поэтому в
   * этом случае показываем DDL «до», а не сообщаем об успехе.
   */
  const undoLastDesign = async () => {
   if (!connId) return;
    if (!confirm(t('table.rollbackSchemaConfirm'))) return;
    setDesignBusy(true);
    try {
      const r = await api.undoAlter(connId, activeDb, tableName);
      const skipped = r.skipped ?? [];
      addToast(t('table.rollbackDone', { count: r.restored ?? 0, skipped: skipped.length ? t('table.skippedList', { list: skipped.join('; ') }) : '' }), 'success');
      refresh();
    } catch (error: any) {
      const body = (error as { body?: { ddlBefore?: string; structuralOps?: unknown[] } }).body;
      // Отказ сервера различаем по машинному коду, а не по английскому тексту:
      // переводить текст сервера нечем, и он меняется вместе с формулировкой.
      // errorText сам отдаёт перевод по коду — поэтому в подсказку ничего
      // дописывать не нужно. Раньше здесь подставлялся русский текст и сырой
      // english-ответ сервера, из-за чего пользователь видел смесь языков.
      const code = (error as { code?: string }).code;
      const nothing = code === 'undo_nothing' || (error?.status === 404 && !body?.ddlBefore);
      const structural = code === 'undo_structural';
      // DDL «до изменения» показываем под текстом отказа: он и есть инструкция
      // что делать руками, а переводить его нельзя — это SQL.
      const hint = structural
        ? errorText(error) + (body?.ddlBefore ? `\n${body.ddlBefore}` : '')
        : nothing
          ? t('table.rollbackNothing')
          : t('table.rollbackFailed') + errorText(error);
      setDesignPreview({
        statements: [],
        before: [],
        transactional: false,
        hint,
      });
      addToast(nothing ? t('table.rollbackNothing') : t('table.rollbackSkipped'), 'error');
    } finally {
      setDesignBusy(false);
    }
  };

  const addRow = () => {
    if (!columns.length) {
      addToast(t('table.schemaUnavailable'), 'error');
      return;
    }
    const row: Record<string, unknown> = { __isNew: true };
    columns.forEach(column => { row[column.name] = ''; });
    setEditingRowOriginal(null);
    setEditingRow(row);
  };

  const openRowEditor = (row: Record<string, unknown>) => {
    setEditingRowOriginal(row);
    setEditingRow(row);
  };

  /**
   * Быстрое редактирование одного значения прямо в сетке: клик по «карандашу»
   * у ячейки меняет только эту колонку (PATCH по первичному ключу строки),
   * без открытия модалки на всю запись. Тип значения сохраняется: число остаётся
   * числом, null — null, всё остальное приходит строкой.
   */
  const rowFilter = (row: Record<string, unknown>): Record<string, unknown> => {
    const pks = columns.filter(column => column.isPk).map(column => column.name);
    if (pks.length) return Object.fromEntries(pks.map(key => [key, row[key]]));
    // Без первичного ключа строку не опознать надёжно: фильтр по всем значениям
    // опасен (не совпадёт — обновится лишнее), поэтомуquick-edit отключён.
    return {};
  };

  const castCellValue = (original: unknown, input: string): unknown => {
    if (original === null) return input === '' ? null : input;
    if (typeof original === 'number') {
      const parsed = Number(input);
      return input.trim() === '' || Number.isNaN(parsed) ? input : parsed;
    }
    if (typeof original === 'boolean') return /^(true|1|да|yes)$/i.test(input.trim());
    if (input === '' && (typeof original === 'object' || original === undefined)) return null;
    return input;
  };

  /**
   * Массовые операции по фильтру строк. Сначала ВСЕГДА предпросмотр: панель
   * показывает, сколько строк затронуто, и только после подтверждения
   * отправляет dryRun:false + confirm:true. Перед применением сервер снимает
   * точку восстановления таблицы.
   */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkColumn, setBulkColumn] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkPreview, setBulkPreview] = useState<BulkRowsResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMode, setBulkMode] = useState<'update' | 'delete'>('update');
  const [rowFilterText, setRowFilterText] = useState('');

  /**
   * Значение для массовой правки приводим к типу КОЛОНКИ, а не к типу соседней
   * ячейки: у castCellValue(null, …) всегда строка, и обновление INTEGER
   * уходило бы как '42' — в SQLite такое значение осталось бы текстом.
   */
  const castBulkValue = (columnName: string, input: string): unknown => {
    const type = (columns.find(c => c.name === columnName)?.type ?? '').toUpperCase();
    if (input === '') return null;
    if (/BOOL/.test(type)) return /^(true|1|да|yes)$/i.test(input.trim());
    if (/(INT|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|MONEY|SERIAL)/.test(type)) {
      const n = Number(input.trim());
      return Number.isNaN(n) ? input : n;
    }
    return input;
  };

  const bulkRequest = (where: string, mode: 'update' | 'delete', extra?: { dryRun?: boolean; confirm?: boolean; allowWithoutCheckpoint?: boolean }) =>
    api.bulkRows(connId!, activeDb, tableName, mode === 'delete'
      ? { where, delete: true, ...extra }
      : { where, patch: { [bulkColumn]: castBulkValue(bulkColumn, bulkValue) }, ...extra });

  const runBulkPreview = async (mode: 'update' | 'delete') => {
    if (!connId) return;
    const where = rowFilterText.trim();
    if (!where) { addToast(t('bulk.needFilter'), 'error'); return; }
    setBulkBusy(true);
    try {
      const r = await bulkRequest(where, mode);
      setBulkPreview(r);
      setBulkMode(mode);
    } catch (error: any) {
      addToast(t('bulk.previewFailed', { msg: error.message }), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const applyBulk = async (allowWithoutCheckpoint = false) => {
    if (!bulkPreview || !connId) return;
    const mode = bulkMode;
    if (!confirm(t(mode === 'delete' ? 'bulk.confirmDelete' : 'bulk.confirmUpdate', { n: bulkPreview.matched }))) return;
    setBulkBusy(true);
    try {
      const where = rowFilterText.trim();
      const r = await bulkRequest(where, mode, { dryRun: false, confirm: true, allowWithoutCheckpoint });
      addToast(t('bulk.done', { n: r.affected ?? 0 }) + (r.checkpointId ? t('bulk.checkpointTaken') : ''), 'success');
      if (r.failed?.length) addToast(t('bulk.partial', { n: r.failed.length }), 'error');
      setBulkPreview(null);
      refresh();
    } catch (error: any) {
      // Сервер отказывается применять массовую правку, если не смог снять точку
      // восстановления. Предлагаем осознанный выход, а не молчаливую потерю данных.
      if (!allowWithoutCheckpoint && /restore point|allowWithoutCheckpoint/i.test(error.message)) {
        if (confirm(t('bulk.noCheckpoint', { msg: error.message }))) {
          await applyBulk(true);
        }
        return;
      }
      addToast(t('bulk.applyFailed', { msg: error.message }), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const saveCell = async (row: Record<string, unknown>, column: string, input: string) => {
    if (!connId) return;
    const filter = rowFilter(row);
    if (!Object.keys(filter).length) {
      addToast(t('table.quickEditNoPk'), 'info');
      setCellEdit(null);
      return;
    }
    const value = castCellValue(row[column], input);
    setCellSaving(true);
    try {
      // expected — значение ячейки, на основе которого правили: если её уже
      // изменили, сервер вернёт 409, и мы не затрём чужое изменение
      const result = await api.updateRows(connId, activeDb, tableName, filter, { [column]: value }, { [column]: row[column] });
      if (result.matched === 0) {
        addToast(t('table.rowGoneOtherSession'), 'error');
      } else {
        addToast(t('table.cellSaved', { column: column }), 'success');
      }
      setCellEdit(null);
      refresh();
    } catch (error: any) {
      if (error?.status === 409) {
        addToast(t('table.cellConflict', { column: column }), 'error');
        setCellEdit(null);
        refresh();
      } else {
        addToast(t('table.errorSave') + error.message, 'error');
      }
    } finally {
      setCellSaving(false);
    }
  };

  const saveRow = async (_id: number, data: any) => {
    if (!connId) return;
    const { __isNew, ...values } = data;
    const pks = columns.filter(column => column.isPk).map(column => column.name);
    const source = editingRowOriginal || data;
    try {
      if (__isNew) {
        const clean = Object.fromEntries(columns
          .filter(column => !column.isPk)
          .map(column => [column.name, values[column.name]])
          .filter(([, value]) => value !== '' && value !== undefined && value !== null));
        if (Object.keys(clean).length === 0) throw new Error(t('table.fillOneField'));
        await api.insertRow(connId, activeDb, tableName, clean);
      } else {
        const filter: Record<string, unknown> = pks.length
          ? Object.fromEntries(pks.map(key => [key, source[key]]))
          : Object.fromEntries(Object.entries(source).filter(([key, value]) => key !== '__isNew' && (value === null || typeof value !== 'object')));
        if (Object.keys(filter).length === 0) throw new Error(t('table.rowNotResolved'));
        const patch = Object.fromEntries(columns
          .filter(column => !column.isPk && values[column.name] !== undefined && values[column.name] !== source[column.name])
          .map(column => [column.name, values[column.name] === '' ? null : values[column.name]]));
        if (Object.keys(patch).length === 0) {
          setEditingRow(null);
          setEditingRowOriginal(null);
          addToast(t('table.noChangesShort'), 'info');
          return;
        }
        // Проверяем те колонки, которые меняем: если их уже изменили, сервер
        // вернёт 409 и правка не перезапишет чужое изменение
        const expected = Object.fromEntries(Object.keys(patch).map(k => [k, source[k]]));
        await api.updateRows(connId, activeDb, tableName, filter, patch, expected);
      }
      setEditingRow(null);
      setEditingRowOriginal(null);
      addToast(t('table.rowSaved'), 'success');
      refresh();
    } catch (error: any) {
      if (error?.status === 409) {
        addToast(t('table.rowConflictEdit'), 'error');
        setEditingRow(null);
        setEditingRowOriginal(null);
        refresh();
        return;
      }
      addToast(t('table.errorSaveRow') + error.message, 'error');
    }
  };

  const deleteRow = async (row: Record<string, unknown>) => {
    if (!connId || !confirm(t('table.confirmDeleteRow'))) return;
    const pks = columns.filter(column => column.isPk).map(column => column.name);
    const filter = pks.length
      ? Object.fromEntries(pks.map(key => [key, row[key]]))
      : Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== '__isNew' && (value === null || typeof value !== 'object')));
    try {
      // expected = все колонки, как их видели при открытии: удалять можно только
      // ту строку, которую читали (иначе 409, а не тихая потеря чужих правок)
      const expected: Record<string, unknown> = Object.fromEntries(
        Object.keys(row).filter(k => k !== '__isNew' && row[k] !== null && row[k] !== undefined).map(k => [k, row[k]])
      );
      const result = await api.deleteRows(connId, activeDb, tableName, filter, Object.keys(expected).length ? expected : undefined);
      if (result.deleted === 0) throw new Error(t('table.rowNotFound'));
      setDataRows(rows => rows.filter(item => item !== row));
      addToast(t('table.rowDeleted'), 'success');
    } catch (error: any) {
      if (error?.status === 409) {
        addToast(t('table.rowConflictDelete'), 'error');
        refresh();
        return;
      }
      addToast(t('table.errorDeleteRow') + error.message, 'error');
    }
  };

  const visibleColumns = useMemo(() => columns.filter(column => column.name.toLowerCase().includes(filter.toLowerCase())), [columns, filter]);
  // Подписи вкладок идут через t(): держать их русскими значило оставить
  // карточку таблицы единственным русским экраном при любом языке.
  const tabs = [
    { id: 'structure', label: t('table.tabs.structure'), icon: <LayoutTemplate className="w-4 h-4" /> },
    { id: 'indexes', label: t('table.tabs.indexes'), icon: <Key className="w-4 h-4" /> },
    { id: 'relations', label: t('table.tabs.relations'), icon: <Settings2 className="w-4 h-4" /> },
    { id: 'privileges', label: t('table.tabs.privileges'), icon: <Key className="w-4 h-4" /> },
    { id: 'triggers', label: t('table.tabs.triggers'), icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'data', label: t('table.tabs.data'), icon: <Search className="w-4 h-4" /> },
    { id: 'sql', label: t('table.tabs.sql'), icon: <FileCode2 className="w-4 h-4" /> },
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#151923] overflow-hidden">
      <div className="px-4 py-2 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2 min-w-0 text-sm text-gray-500 dark:text-gray-400">
          <button onClick={onBack} className="flex items-center gap-1 text-xs hover:text-blue-600"><ArrowLeft className="w-3.5 h-3.5" />{t('table.back')}</button>
          <ChevronRight className="w-3.5 h-3.5" />
          <button onClick={onBack} className="truncate">{activeDb}</button>
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="font-semibold text-gray-900 dark:text-gray-200 truncate">{tableName}</span>
        </div>
        {onToggleDetach && <button onClick={onToggleDetach} className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600">{isDetached ? t('table.pin') : t('table.unpin')}</button>}
        {headerExtra}
      </div>

      {readOnly && (
        <div className="px-4 py-1.5 border-b border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 text-xs text-amber-700 dark:text-amber-300">
          {connectionReadOnly ? t('table.readonly.connection') : t('table.readonly.role')}
        </div>
      )}

      <div className="p-4 md:p-6 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h2 className="text-xl font-bold">{tableName}{tableMeta.kind === 'view' && <span className="ml-2 text-xs font-normal px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">VIEW</span>}</h2>
            {tableMeta.comment && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{tableMeta.comment}</div>}
            {Object.entries(tableMeta.extra).filter(([, value]) => value).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">{Object.entries(tableMeta.extra).filter(([, value]) => value).map(([key, value]) => <span key={key} className="text-[11px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">{key}: <span className="font-mono">{String(value)}</span></span>)}</div>
            )}
          </div>
          {/* Кнопки действий — единый стиль блока «Таблицы базы данных»: одинаковая
              высота, рамка, hover как у кнопок в списке таблиц. */}
          <div className="flex flex-wrap items-center gap-2">
            {canWriteRows && (
              <button onClick={addRow}
                className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-blue-600 hover:bg-blue-700 text-white">
                <Plus className="w-4 h-4" />{t('table.add')}</button>
            )}
            <button onClick={() => setActiveTab('sql')} title={t('table.openSqlEditor')}
              className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              <FileCode2 className="w-4 h-4 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors" /> SQL
            </button>
            {canAlter && (
              <button onClick={undoLastDesign} disabled={designBusy} title={t('table.rollbackSchema')}
                className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40">
                <Undo2 className="w-4 h-4 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors" />{t('table.rollbackDdl')}</button>
            )}
            {canWriteRows && (
              <button onClick={openDataUndo} title={t('table.dataChangesHint')}
                className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                <Undo2 className="w-4 h-4 text-gray-400" />{t('table.rollbackData')}</button>
            )}
            {canClone && (
              <button onClick={cloneTable} title={t('table.cloneHint')}
                className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                <Copy className="w-4 h-4 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors" />{t('table.clone')}</button>
            )}
            <button onClick={exportTable} title={t('table.exportDataTitle')}
              className="px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              <Download className="w-4 h-4 text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors" />{t('table.export')}</button>
          </div>
        </div>

        {dataUndoOpen && <div className="mb-4 border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 flex items-center justify-between gap-3 border-b text-gray-900 dark:text-gray-100">
            <span className="text-sm font-medium">{t('table.dataChanges')}</span>
            <button onClick={() => setDataUndoOpen(false)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600">{t('ui.hide')}</button>
          </div>
          {dataUndoEntries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">{t('table.dataChangesEmpty')}</div>
          ) : (
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 dark:bg-gray-800/30 text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{t('ui.time')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('table.operation')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('table.rows')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('table.author')}</th>
                  <th className="px-3 py-1.5 font-medium text-right">{t('table.action')}</th>
                </tr>
              </thead>
              <tbody>
                {dataUndoEntries.map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-100 dark:border-gray-800/60">
                    <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(entry.at, lang)}</td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded mr-1.5 ${
                        entry.op === 'insert' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                          : entry.op === 'update' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                      }`}>
                        {entry.op === 'insert' ? t('table.opInsert') : entry.op === 'update' ? t('table.opUpdate') : t('table.opDelete')}
                      </span>
                      {entry.undone ? <span className="text-gray-400">{t('table.undone')}</span> : null}
                      {!entry.undoable && <span className="text-amber-600 dark:text-amber-400"> · {entry.summary}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">{entry.rows}</td>
                    <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">{entry.actor || 'system'}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {entry.undoable && !entry.undone && (
                        <button onClick={() => void applyDataUndoAction(entry, 'undo')} disabled={dataUndoBusy}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40">{t('table.undo')}</button>
                      )}
                      {entry.canRedo && (
                        <button onClick={() => void applyDataUndoAction(entry, 'redo')} disabled={dataUndoBusy}
                          className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-40 ml-2">{t('ui.retry')}</button>
                      )}
                      {!entry.undoable && !entry.canRedo && <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>}

        {designPreview && <div className="mb-4 border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 flex items-center justify-between gap-3 border-b text-gray-900 dark:text-gray-100">
            <span className="text-sm font-medium">{t('table.ddlApplied')}</span>
            <button onClick={() => setDesignPreview(null)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600">{t('ui.hide')}</button>
          </div>
          <div className={`px-3 py-1.5 text-xs border-b ${designPreview.transactional ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/20' : 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/20'}`}>{designPreview.hint}</div>
          <pre className="p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">{designPreview.statements.join(';\n') + ';'}</pre>
        </div>}

        {/* Полоса вкладок переносится, а не прокручивается: карточка делит ширину с
            списком таблиц, и при узкой панели горизонтальная прокрутка
            уводила половину вкладок за край. */}
        <div className="flex flex-wrap gap-1 border-b mb-4">
          {tabs.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 dark:text-gray-400'}`}>{tab.icon}{tab.label}</button>)}
        </div>

        {activeTab === 'structure' && <section className="border rounded-lg overflow-hidden">
          <div className="p-3 bg-gray-50 dark:bg-gray-800/30 flex flex-wrap justify-between gap-2 border-b text-gray-900 dark:text-gray-100">
            {canAlter && <button onClick={() => setEditingColumn({ id: Date.now(), name: '', type: dialect === 'postgresql' ? 'integer' : dialect === 'oracle' ? 'NUMBER' : 'INTEGER', length: '', isNull: 'YES', default: '-', extra: '-', isPk: false, isNew: true })} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm"><Plus className="w-4 h-4 inline" />{t('designer.addColumn')}</button>}
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('table.columnFilter')} className="border rounded px-2 py-1 text-sm bg-white dark:bg-[#151923]" />
          </div>
          {/* Таблица колонок умещается в панель: card делит ширину со списком, и при
              table-auto семь колонок с кнопками давали горизонтальную
              прокрутку всей карточки. Длинные значения обрезаются. */}
          <div className="overflow-x-hidden"><table className="w-full table-fixed text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr>{['#', t('tableFields.name'), t('tableFields.type'), t('tableFields.null'), t('tableFields.default'), t('tableFields.extra'), ''].map((title, i) => <th key={i} className="px-3 py-2 truncate">{title}</th>)}</tr></thead><tbody>
            {visibleColumns.map(column => <tr key={column.id} className="border-t"><td className="px-3 py-2 w-[5%]">{column.id}</td><td className="px-3 py-2 font-mono w-[22%] min-w-0"><div className="flex items-center gap-1 min-w-0 overflow-hidden"><QuickOpen value={column.name} mono label={t('tableFields.name')} disabled={!canAlter}
              onOpen={() => setEditingColumn(column)} /><span className="text-amber-600 text-xs">{column.isPk ? 'PK' : ''}</span></div></td><td className="px-3 py-2 font-mono w-[16%] min-w-0"><QuickOpen value={`${column.type}${column.length && column.length !== '-' ? `(${column.length})` : ''}`} mono label={t('tableFields.type')} disabled={!canAlter}
              onOpen={() => setEditingColumn(column)} /></td><td className="px-3 py-2 w-[11%] min-w-0"><QuickOpen value={column.isNull === 'YES' ? t('ui.yes') : column.isNull === 'NO' ? t('ui.no') : '-'} label={t('tableFields.null')} disabled={!canAlter}
              onOpen={() => setEditingColumn(column)} /></td><td className="px-3 py-2 font-mono w-[19%] min-w-0"><QuickOpen value={column.default} mono label={t('tableFields.default')} disabled={!canAlter}
              onOpen={() => setEditingColumn(column)} /></td><td className="px-3 py-2 font-mono w-[17%] min-w-0"><QuickOpen value={column.extra} mono label={t('tableFields.extra')} disabled={!canAlter}
              onOpen={() => setEditingColumn(column)} /></td><td className="px-3 py-2 w-[10%]">{canAlter && <div className="flex gap-1"><button onClick={() => setEditingColumn(column)} className="p-1 text-blue-500"><Edit2 className="w-4 h-4" /></button><button onClick={() => deleteColumn(column)} className="p-1 text-red-500"><Trash2 className="w-4 h-4" /></button></div>}</td></tr>)}
            {!visibleColumns.length && <tr><td colSpan={7} className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.columnsNotFound')}</td></tr>}
          </tbody></table></div>
        </section>}

        {activeTab === 'indexes' && <section className="border rounded-lg overflow-hidden">
          {canDesignIndexes && (
            <div className="border-b border-gray-200 dark:border-gray-800">
              <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-gray-100">{t('table.newIndex')}</div>
              <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.name')}<input value={indexDraft.name} onChange={event => setIndexDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="idx_table_col"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.type')}<input value={indexDraft.type} onChange={event => setIndexDraft(draft => ({ ...draft, type: event.target.value }))} placeholder="BTREE"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 min-w-0">
                  <input type="checkbox" checked={indexDraft.unique} onChange={event => setIndexDraft(draft => ({ ...draft, unique: event.target.checked }))}
                    className="rounded border-gray-300 dark:border-gray-600" />{t('table.uniqueIndex')}</label>
              </div>
              <div className="px-3 pb-3">
                <span className="block text-xs text-gray-600 dark:text-gray-300 mb-1.5">
                  Колонки {indexDraft.columns.length > 0 && <span className="text-gray-400">(в порядке нажатия: {indexDraft.columns.join(', ')})</span>}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {columns.map(column => {
                    const position = indexDraft.columns.indexOf(column.name);
                    const active = position >= 0;
                    return (
                      <button key={column.name} type="button" onClick={() => toggleIndexColumn(column.name)}
                        className={`px-2 py-1 rounded text-xs font-mono transition-colors border ${
                          active
                            ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                            : 'bg-white dark:bg-[#151923] border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600'
                        }`}>
                        {active ? `${position + 1}. ${column.name}` : column.name}
                      </button>
                    );
                  })}
                  {!columns.length && <span className="text-xs text-gray-400">{t('ui.schemaUnavailable')}</span>}
                </div>
              </div>
              <div className="px-3 pb-3 flex justify-end">
                <button onClick={addIndex} disabled={designBusy}
                  className="h-9 px-3 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap">
                  {designBusy ? t('table.creating') : t('table.createIndex')}
                </button>
              </div>
            </div>
          )}
          {!canDesignIndexes && <div className="p-3 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">{readOnly ? t('table.readOnlyAlter') : t('table.driverNoAlterShort')}</div>}
          <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr><th className="p-3">{t('ui.columnName')}</th><th className="p-3">{t('table.type')}</th><th className="p-3">{t('table.unique')}</th><th className="p-3">{t('table.columns')}</th>{canDesignIndexes && <th className="p-3 w-10" />}</tr></thead><tbody>
            {indexes.map(index => <tr key={`${index.name}-${index.columns}`} className="border-t"><td className="p-3 font-mono">{index.name}{index.primary && <span className="ml-2 text-amber-600 text-xs">PK</span>}</td><td className="p-3">{index.type}</td><td className="p-3">{index.unique ? t('ui.yes') : t('ui.no')}</td><td className="p-3 font-mono">{index.columns}</td>{canDesignIndexes && <td className="p-3">{!index.primary && <button title={t('table.dropIndex')} onClick={() => dropIndex(index)} className="p-1 text-red-500"><Trash2 className="w-4 h-4" /></button>}</td>}</tr>)}
            {!indexes.length && <tr><td colSpan={5} className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.noIndexes')}</td></tr>}
          </tbody></table></div>
        </section>}

        {activeTab === 'relations' && <section className="border rounded-lg overflow-hidden">
          {canDesignForeignKeys && (
            <div className="border-b border-gray-200 dark:border-gray-800">
              <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-gray-100">{t('table.newForeignKey')}</div>
              <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <label className="block text-xs text-gray-600 dark:text-gray-300">{t('table.constraintName')}<input value={fkDraft.name} onChange={event => setFkDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="fk_table_col"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300">{t('table.referencesTable')}<input value={fkDraft.refTable} onChange={event => setFkDraft(draft => ({ ...draft, refTable: event.target.value }))} placeholder="ref_table"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300">
                  {t('table.refColumnsLabel')}
                  <input value={fkDraft.refColumns.join(',')} onChange={event => setFkDraft(draft => ({ ...draft, refColumns: event.target.value.split(',').map((v) => v.trim()).filter(Boolean) }))} placeholder="id"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300">
                  ON DELETE
                  <select value={fkDraft.onDelete} onChange={event => setFkDraft(draft => ({ ...draft, onDelete: event.target.value }))}
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500">
                    <option value="">{t('table.noRule')}</option>{['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'].map(action => <option key={action} value={action}>{action}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">
                  ON UPDATE
                  {connKind === 'oracle' ? (
                    <div className="mt-1 w-full h-9 flex items-center px-2 text-sm text-gray-400 border border-gray-200 dark:border-gray-800 rounded">—</div>
                  ) : (
                  <select value={fkDraft.onUpdate} onChange={event => setFkDraft(draft => ({ ...draft, onUpdate: event.target.value }))}
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500">
                    <option value="">{t('table.noRule')}</option>{['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'].map(action => <option key={action} value={action}>{action}</option>)}
                  </select>
                  )}
                </label>
              </div>
              <div className="px-3 pb-3">
                <span className="block text-xs text-gray-600 dark:text-gray-300 mb-1.5">
                  {t('table.tableColumns')} {fkDraft.columns.length > 0 && <span className="text-gray-400">({t('table.pickOrder', { cols: fkDraft.columns.join(', ') })})</span>}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {columns.map(column => {
                    const position = fkDraft.columns.indexOf(column.name);
                    const active = position >= 0;
                    return (
                      <button key={column.name} type="button" onClick={() => toggleFkColumn('columns', column.name)}
                        className={`px-2 py-1 rounded text-xs font-mono transition-colors border ${
                          active
                            ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                            : 'bg-white dark:bg-[#151923] border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600'
                        }`}>
                        {active ? `${position + 1}. ${column.name}` : column.name}
                      </button>
                    );
                  })}
                  {!columns.length && <span className="text-xs text-gray-400">{t('ui.schemaUnavailable')}</span>}
                </div>
              </div>
              <div className="px-3 pb-3 flex justify-end">
                <button onClick={addForeignKey} disabled={designBusy}
                  className="h-9 px-3 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap">
                  {designBusy ? t('table.creating') : t('table.createForeignKey')}
                </button>
              </div>
            </div>
          )}
          {!canDesignForeignKeys && <div className="p-3 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">{readOnly ? t('table.readOnlyAlter') : connKind === 'sqlite' ? t('table.sqliteNoAddConstraint') : t('table.driverNoAlterShort')}</div>}
          <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr><th className="p-3">{t('table.constraint')}</th><th className="p-3">{t('table.column')}</th><th className="p-3">{t('table.referencesTo')}</th><th className="p-3">ON DELETE</th><th className="p-3">ON UPDATE</th>{canDesignForeignKeys && <th className="p-3 w-10" />}</tr></thead><tbody>
            {foreignKeys.map((fk, index) => <tr key={`own-${fk.name}-${index}`} className="border-t"><td className="p-3 font-mono text-xs">{fk.name}</td><td className="p-3 font-mono">{fk.columns}</td><td className="p-3 font-mono text-purple-600">{fk.refTable}.{fk.refColumns}</td><td className="p-3">{fk.onDelete}</td><td className="p-3">{fk.onUpdate}</td>{canDesignForeignKeys && <td className="p-3"><button title={t('table.dropForeignKey')} onClick={() => dropForeignKey(fk)} className="p-1 text-red-500"><Trash2 className="w-4 h-4" /></button></td>}</tr>)}
            {relationRows.map((relation, index) => <tr key={`in-${index}`} className="border-t"><td className="p-3 font-mono text-xs">{String(relation.constraint ?? '—')}</td><td className="p-3 font-mono text-purple-600">{relation.table}.{relation.column}</td><td className="p-3 font-mono">{tableName}.{relation.refColumn}</td><td className="p-3">{String(relation.onDelete ?? '—')}</td><td className="p-3">{String(relation.onUpdate ?? '—')}</td><td className="p-3 text-xs text-gray-400">{t('table.incoming')}</td></tr>)}
            {!foreignKeys.length && !relationRows.length && <tr><td colSpan={6} className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.relationsUnsupported')}</td></tr>}
          </tbody></table></div>
        </section>}

        {activeTab === 'privileges' && <section className="border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-gray-100">{t('table.userPrivileges')}</div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-3 border-b border-gray-200 dark:border-gray-800">
            <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('app.user')}<select value={privilegeUser} disabled={privilegeUsersLoading || !privilegeUsers.length} onChange={event => setPrivilegeUser(event.target.value)}
                className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500 disabled:opacity-50">
                {!privilegeUsers.length && <option value="">{t('table.noUsers')}</option>}
                {privilegeUsers.map(user => <option key={privilegeUserKey(user)} value={privilegeUserKey(user)}>{user.username}{user.host ? `@${user.host}` : ''}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.privilege')}<select value={privilege} onChange={event => setPrivilege(event.target.value)} disabled={privilegesReadOnly}
                className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500 disabled:opacity-50">
                {privilegeOptions.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <div className="text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.scope')}<div className="mt-1 h-9 flex items-center font-mono text-sm text-gray-800 dark:text-gray-200 truncate">{activeDb}.{tableName}</div>
            </div>
          </div>
          {/* Кнопки — своей строкой: в колонке сетки длинные подписи не помещались */}
          <div className="px-3 py-2 flex flex-wrap items-center justify-end gap-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30 text-gray-900 dark:text-gray-100">
            <button onClick={() => void loadPrivilegeUsers()} disabled={privilegeUsersLoading} title={t('table.reloadDbUsers')}
              className="h-9 px-3 rounded text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 transition-colors disabled:opacity-40 whitespace-nowrap">{t('table.refreshList')}</button>
            <button onClick={() => void changePrivilege('grant')} disabled={!privilegeUser || privilegesReadOnly || privilegeAction !== null}
              className="h-9 px-3 rounded text-sm bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-40 whitespace-nowrap">
              {privilegeAction === 'grant' ? t('table.granting') : t('table.grant')}
            </button>
            <button onClick={() => void changePrivilege('revoke')} disabled={!privilegeUser || privilegesReadOnly || privilegeAction !== null}
              className="h-9 px-3 rounded text-sm border border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors disabled:opacity-40 whitespace-nowrap">
              {privilegeAction === 'revoke' ? t('table.revoking') : t('table.revoke')}
            </button>
          </div>
          {privilegesReadOnly && <div className="p-3 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30">Read-only: {connectionReadOnly ? t('table.readonlyConnection') : t('table.privilegesAdminOnly')}.</div>}
          {privilegeError && <div className="p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 flex items-center justify-between gap-3"><span>{privilegeError}</span><button onClick={() => void (privilegeUsers.length ? loadPrivilegeGrants() : loadPrivilegeUsers())} className="shrink-0 underline">{t('ui.retry')}</button></div>}
          <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">{t('table.currentPrivileges')}</div>
          <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr><th className="p-3">{t('table.privilege')}</th></tr></thead><tbody>
            {privilegeGrants.map((grant, index) => <tr key={`${grant}-${index}`} className="border-t"><td className="p-3 font-mono text-xs">{grant}</td></tr>)}
            {privilegeGrantsLoading && <tr><td className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.loadingPrivileges')}</td></tr>}
            {!privilegeGrantsLoading && !privilegeUser && <tr><td className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.selectUser')}</td></tr>}
            {!privilegeGrantsLoading && privilegeUser && !privilegeGrants.length && !privilegeError && <tr><td className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.privilegesUnsupported')}</td></tr>}
          </tbody></table></div>
        </section>}

        {activeTab === 'triggers' && <section className="border rounded-lg overflow-x-auto">
          {canDesignTriggers && (
            <div className="border-b border-gray-200 dark:border-gray-800">
              <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-gray-100">{t('table.newTrigger')}</div>
              <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.name')}<input value={triggerDraft.name} onChange={event => setTriggerDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="trg_table_event"
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.when')}<select value={triggerDraft.timing} onChange={event => setTriggerDraft(draft => ({ ...draft, timing: event.target.value }))}
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500">
                    {(connKind === 'mysql' || connKind === 'mariadb' || connKind === 'oracle' ? ['BEFORE', 'AFTER'] : ['BEFORE', 'AFTER', 'INSTEAD OF']).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300 min-w-0">{t('table.event')}<select value={triggerDraft.event} onChange={event => setTriggerDraft(draft => ({ ...draft, event: event.target.value }))}
                    className="mt-1 w-full h-9 border border-gray-300 dark:border-gray-700 rounded px-2 text-sm bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500">
                    {['INSERT', 'UPDATE', 'DELETE'].map(e => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-gray-600 dark:text-gray-300 sm:col-span-3 min-w-0">
                  {connKind === 'postgres'
                    ? t('table.triggerFunctionHint')
                    : connKind === 'sqlite'
                      ? t('table.triggerBodyHintSqlite')
                      : connKind === 'oracle'
                        ? t('table.triggerBodyHintOracle')
                        : t('table.triggerBodyHintMysql')}
                  <textarea value={triggerDraft.statement} onChange={event => setTriggerDraft(draft => ({ ...draft, statement: event.target.value }))} rows={3}
                    placeholder={connKind === 'postgres' ? 'trg_touch' : connKind === 'oracle' ? 'UPDATE t SET name = :NEW.name WHERE id = :OLD.id' : connKind === 'sqlite' ? 'UPDATE t SET name = NEW.name WHERE id = NEW.id' : 'SET @x = NEW.name'}
                    className="mt-1 w-full border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none focus:border-blue-500" />
                </label>
              </div>
              <div className="px-3 pb-3 flex justify-end">
                <button onClick={addTrigger} disabled={designBusy}
                  className="h-9 px-3 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap">
                  {designBusy ? t('table.creating') : t('table.createTrigger')}
                </button>
              </div>
            </div>
          )}
          {!canDesignTriggers && <div className="p-3 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">{readOnly ? t('table.readOnlyAlter') : t('table.driverNoAlterShort')}</div>}
          <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr><th className="p-3">{t('ui.columnName')}</th><th className="p-3">{t('table.when')}</th><th className="p-3">{t('table.event')}</th><th className="p-3">{t('table.body')}</th>{canDesignTriggers && <th className="p-3 w-10" />}</tr></thead><tbody>
            {triggers.map((trigger, index) => <tr key={index} className="border-t"><td className="p-3 font-mono">{trigger.name}</td><td className="p-3">{trigger.timing}</td><td className="p-3">{trigger.event}</td><td className="p-3 font-mono text-xs whitespace-pre-wrap">{trigger.statement}</td>{canDesignTriggers && <td className="p-3"><button title={t('table.dropTrigger')} onClick={() => dropTrigger(trigger)} className="p-1 text-red-500"><Trash2 className="w-4 h-4" /></button></td>}</tr>)}
            {!triggers.length && <tr><td colSpan={5} className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.triggersUnsupported')}</td></tr>}
          </tbody></table></div>
        </section>}

        {activeTab === 'data' && <section className="border rounded-lg overflow-hidden"><div className="p-3 flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 dark:bg-gray-800/30"><span>{dataTotal !== null ? t('table.data.total', { count: dataRows.length, total: dataTotal }) : t('table.data.count', { count: dataRows.length })}{dataTruncated ? t('table.data.truncated') : ''}</span>
          {canWriteRows && bulkOpen && (
            <div className="px-3 pb-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/20 space-y-2 text-gray-900 dark:text-gray-100">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">{t('bulk.filterHint')}</div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={rowFilterText}
                  onChange={e => { setRowFilterText(e.target.value); setBulkPreview(null); }}
                  placeholder={t('bulk.filterPlaceholder')}
                  className="flex-1 min-w-[220px] px-2 py-1.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                />
                <select
                  value={bulkColumn}
                  onChange={e => { setBulkColumn(e.target.value); setBulkPreview(null); }}
                  className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                >
                  <option value="">{t('bulk.column')}</option>
                  {columns.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
                </select>
                <input
                  value={bulkValue}
                  onChange={e => { setBulkValue(e.target.value); setBulkPreview(null); }}
                  placeholder={t('bulk.valuePlaceholder')}
                  className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                />
                <button
                  onClick={() => void runBulkPreview('update')}
                  disabled={bulkBusy || !bulkColumn}
                  className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                >
                  {t('bulk.previewUpdate')}
                </button>
                <button
                  onClick={() => void runBulkPreview('delete')}
                  disabled={bulkBusy}
                  className="px-2 py-1.5 text-xs rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                >
                  {t('bulk.previewDelete')}
                </button>
              </div>
              {bulkPreview && (
                <div className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2 bg-white dark:bg-gray-900/40 text-gray-900 dark:text-gray-100">
                  <div className="mb-1">{t('bulk.affected')} <span className="font-semibold">{bulkPreview.matched}</span></div>
                  {bulkPreview.preview && <div className="font-mono text-gray-500 dark:text-gray-400 break-all mb-1">{bulkPreview.preview}</div>}
                  {bulkPreview.sample && bulkPreview.sample.length > 0 && (
                    <details className="mb-1">
                      <summary className="cursor-pointer text-gray-500 dark:text-gray-400">{t('bulk.firstRows')}</summary>
                      <pre className="font-mono whitespace-pre-wrap mt-1 text-gray-500 dark:text-gray-400">{JSON.stringify(bulkPreview.sample, null, 1)}</pre>
                    </details>
                  )}
                  <button
                    onClick={() => void applyBulk()}
                    disabled={bulkBusy}
                    className={`px-2 py-1.5 text-xs rounded text-white disabled:opacity-50 ${bulkMode === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}`}
                  >
                    {t(bulkMode === 'delete' ? 'bulk.applyDelete' : 'bulk.applyUpdate', { n: bulkPreview.matched })}
                  </button>
                </div>
              )}
            </div>
          )}<div className="flex items-center gap-2">{canWriteRows && <button onClick={addRow} className="text-sm text-blue-600">{t('table.addRow')}</button>}{canWriteRows && <button onClick={() => { setBulkOpen(!bulkOpen); setBulkPreview(null); }} title={t('bulk.title')} className="text-sm text-amber-600 dark:text-amber-400">{t('bulk.title')}</button>}<button onClick={refresh} className="text-sm text-gray-500">{t('table.data.refresh')}</button></div></div><div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr>{dataColumns.map(column => <th key={column} className="p-3">{column}</th>)}{canWriteRows && <th className="p-3" />}</tr></thead><tbody>
          {dataRows.map((row, index) => {
            const editing = cellEdit?.rowIndex === index ? cellEdit : null;
            return (
              <tr key={index} className="border-t">
                {dataColumns.map(column => {
                  const isEditing = editing?.column === column;
                  const isPk = columns.find(c => c.name === column)?.isPk;
                  return (
                    <td key={column} className="p-3 whitespace-nowrap">
                      {isEditing ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            autoFocus
                            value={editing.value}
                            onChange={event => setCellEdit({ ...editing, value: event.target.value })}
                            onKeyDown={event => {
                              if (event.key === 'Enter') { event.preventDefault(); void saveCell(row, column, editing.value); }
                              if (event.key === 'Escape') setCellEdit(null);
                            }}
                            className="border border-blue-500 rounded px-1.5 py-0.5 text-sm font-mono bg-white dark:bg-[#151923] focus:outline-none" />
                          <button title={t('ui.save')} disabled={cellSaving} onClick={() => void saveCell(row, column, editing.value)} className="p-1 text-emerald-600 disabled:opacity-40"><Check className="w-4 h-4" /></button>
                          <button title={t('ui.cancel')} onClick={() => setCellEdit(null)} className="p-1 text-gray-500 dark:text-gray-400"><X className="w-4 h-4" /></button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 group">
                          <span>{cell(row[column])}</span>
                          {rowsEditable && !isPk && (
                            <button
                              title={t('table.editColumnTitle', { column: column })}
                              onClick={() => setCellEdit({ rowIndex: index, column, value: row[column] === null || row[column] === undefined ? '' : String(row[column]) })}
                              className="p-0.5 text-amber-500 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
                {canWriteRows && <td className="p-3 whitespace-nowrap"><button title={t('table.editRow')} onClick={() => openRowEditor(row)} className="p-1 text-amber-500"><Edit2 className="w-4 h-4" /></button><button title={t('table.deleteRow')} onClick={() => deleteRow(row)} className="p-1 text-red-500"><Trash2 className="w-4 h-4" /></button></td>}
              </tr>
            );
          })}
          {!dataRows.length && <tr><td colSpan={dataColumns.length + (canWriteRows ? 1 : 0)} className="p-6 text-center text-gray-500 dark:text-gray-400">{t('table.data.empty')}</td></tr>}
        </tbody></table></div><div className="p-2 border-t bg-gray-50 dark:bg-gray-800/30 flex flex-wrap items-center justify-end gap-3 text-xs text-gray-500 dark:text-gray-400"><label className="flex items-center gap-2">{t('table.data.pageSize')}<select value={dataPageSize} onChange={event => { setDataPageSize(Number(event.target.value)); setDataPage(1); }} className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 rounded px-2 py-1">{[25, 50, 100, 200].map(size => <option key={size} value={size}>{size}</option>)}</select></label><button onClick={() => setDataPage(page => Math.max(1, page - 1))} disabled={dataPage <= 1} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-800">{t('table.data.prev')}</button><span>{t('table.data.page', { page: dataPage })}</span><button onClick={() => setDataPage(page => page + 1)} disabled={dataRows.length < dataPageSize} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-800">{t('table.data.next')}</button></div></section>}

        {activeTab === 'sql' && <section className="border rounded-lg overflow-hidden"><div className="p-3 flex justify-end gap-2 bg-gray-50 dark:bg-gray-800/30"><button onClick={() => void navigator.clipboard.writeText(sql).then(() => addToast(t('table.sqlCopied'), 'success')).catch(() => addToast(t('table.clipboardUnavailable'), 'error'))} className="border px-3 py-1.5 rounded text-sm"><Copy className="w-4 h-4 inline" />{t('table.copy')}</button><button onClick={executeSql} disabled={sqlLoading} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm"><Play className="w-4 h-4 inline" /> {sqlLoading ? t('table.executing') : t('table.execute')}</button></div><div className="h-64 p-3"><SqlEditor value={sql} onChange={setSql} className="h-full" /></div>{sqlResult && <div className="border-t overflow-x-auto"><div className="p-2 text-xs text-gray-500 dark:text-gray-400">{sqlResult.rowCount} строк, {sqlResult.execMs.toFixed(1)} ms{sqlResult.truncated ? t('table.resultTruncated') : ''}</div><table className="w-full text-sm text-left"><thead className="bg-gray-50 dark:bg-gray-800/30"><tr>{sqlResult.columns.map(column => <th key={column} className="p-2">{column}</th>)}</tr></thead><tbody>{sqlResult.rows.map((row, index) => <tr key={index} className="border-t">{sqlResult.columns.map(column => <td key={column} className="p-2 whitespace-nowrap">{cell(row[column])}</td>)}</tr>)}</tbody></table></div>}</section>}
      </div>

       <EditRowModal isOpen={!!editingRow} onClose={() => { setEditingRow(null); setEditingRowOriginal(null); }} onSave={saveRow} row={editingRow} columns={columns} />
      <EditColumnModal isOpen={!!editingColumn} onClose={() => setEditingColumn(null)} onSave={saveColumn} column={editingColumn} activeDb={activeDb} defaultDialect={dialect} dialectLocked />
    </div>
  );
}
