import React, { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { X, Check, Database } from 'lucide-react';
import { ConnectionInfo, DbKind } from '../../api';
import { isKindEnabled } from '../../engineKinds';

export interface CreateDatabaseOptions {
  charset?: string;
  collate?: string;
  encoding?: string;
  template?: string;
  owner?: string;
}

interface CreateDatabaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, connectionId: string, kind: DbKind, opts?: CreateDatabaseOptions) => void | Promise<void>;
  connections: ConnectionInfo[];
  activeConnId: string | null;
  enabledKinds?: string[];
}

/**
 * Правила имени БД — те же, что на сервере (backend/src/core/dbname.ts), но по одному
 * набору на СУБД: у MongoDB и PostgreSQL предел 63, дефис в MongoDB допустим.
 * Копия держится здесь, чтобы пользователь видел подсказку сразу, а не 400 после отправки.
 */
// Подсказка хранится ключом перевода, а не текстом: константа объявлена вне
// компонента, и t() здесь недоступен. Раньше подсказки оставались русскими при
// любом языке.
const NAME_RULES: Record<DbKind, { max: number; re: RegExp; hintKey: string }> = {
  mysql: { max: 64, re: /^[A-Za-z0-9_$]+$/, hintKey: 'dbName.mysqlHint' },
  mariadb: { max: 64, re: /^[A-Za-z0-9_$]+$/, hintKey: 'dbName.mysqlHint' },
  postgres: { max: 63, re: /^[A-Za-z_][A-Za-z0-9_$]*$/, hintKey: 'dbName.pgHint' },
  mongodb: { max: 63, re: /^[A-Za-z0-9_-]+$/, hintKey: 'dbName.mongoHint' },
  sqlite: { max: 64, re: /^[A-Za-z0-9_-]+$/, hintKey: 'dbName.mongoHint' },
  redis: { max: 64, re: /^[A-Za-z0-9_.:-]+$/, hintKey: 'dbName.redisHint' },
  // Oracle: «база» здесь — схема, она не может начинаться с цифры.
  oracle: { max: 128, re: /^[A-Za-z][A-Za-z0-9_$#]*$/, hintKey: 'dbName.oracleHint' }
};

function validateDbName(name: string, kind: DbKind, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const value = name.trim();
  const rule = NAME_RULES[kind];
  if (!value) return t('dbName.required');
  if (value.length > rule.max) return t('dbName.maxLength', { max: rule.max, now: value.length });
  if (kind === 'mongodb' && /^system\./i.test(value)) return t('dbName.systemPrefix');
  if (kind === 'sqlite' && /[\\/:*?"<>|]/.test(value)) return t('dbName.fileChars');
  if (!rule.re.test(value)) return t('dbName.onlyHint', { hint: t(rule.hintKey) });
  return '';
}

const KINDS: { value: DbKind; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'redis', label: 'Redis' },
  { value: 'oracle', label: 'Oracle' },
];

export function CreateDatabaseModal({ isOpen, onClose, onCreate, connections, activeConnId, enabledKinds }: CreateDatabaseModalProps) {
  const { t } = useLanguage();
  const [dbName, setDbName] = useState('');
  const [kind, setKind] = useState<DbKind>('mysql');
  const [selectedConnId, setSelectedConnId] = useState<string>(activeConnId || '');
  const [nameError, setNameError] = useState('');
  // Необязательные параметры создания: кодировка/сравнение (MySQL/MariaDB),
  // encoding/template/owner (PostgreSQL). Остальные СУБД опций не принимают.
  const [charset, setCharset] = useState('utf8mb4');
  const [collate, setCollate] = useState('');
  const [encoding, setEncoding] = useState('');
  const [template, setTemplate] = useState('');
  const [owner, setOwner] = useState('');

  // Типы, выключенные в настройках, не предлагаем.
  const visibleKinds = KINDS.filter(k => isKindEnabled(k.value, enabledKinds));

  const availableConnections = useMemo(() => kind === 'sqlite' ? connections : connections.filter(connection => connection.kind === kind), [connections, kind]);

  useEffect(() => {
    if (!isOpen) return;
    const active = connections.find(connection => connection.id === activeConnId);
    setKind(active?.kind ?? 'mysql');
  }, [activeConnId, connections, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const candidates = kind === 'sqlite' ? connections : connections.filter(connection => connection.kind === kind);
    if (!candidates.some(connection => connection.id === selectedConnId)) {
      setSelectedConnId(candidates[0]?.id ?? activeConnId ?? '');
    }
  }, [activeConnId, connections, isOpen, kind, selectedConnId]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = dbName.trim();
    const problem = validateDbName(name, kind, t);
    setNameError(problem);
    if (problem || !selectedConnId) return;
    const opts: CreateDatabaseOptions = {};
    if (kind === 'mysql' || kind === 'mariadb') {
      if (charset.trim()) opts.charset = charset.trim();
      if (collate.trim()) opts.collate = collate.trim();
    } else if (kind === 'postgres') {
      if (encoding.trim()) opts.encoding = encoding.trim();
      if (template.trim()) opts.template = template.trim();
      if (owner.trim()) opts.owner = owner.trim();
    }
    await onCreate(name, selectedConnId, kind, opts);
    setDbName('');
    setNameError('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-lg my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-gray-50 dark:bg-gray-900/50">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-500" />{t('createDatabase.title')}</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.category')}</label>
            <select value={kind} onChange={event => setKind(event.target.value as DbKind)} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors">
              {visibleKinds.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.connection')}</label>
            <select value={selectedConnId} onChange={event => setSelectedConnId(event.target.value)} required className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors">
              {availableConnections.length === 0 && <option value="">{t('createDatabase.noConnections')}</option>}
              {availableConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} ({connection.kind})</option>)}
            </select>
            {kind !== 'sqlite' && availableConnections.length === 0 && <p className="text-xs text-amber-600">Сначала создайте подключение к {KINDS.find(option => option.value === kind)?.label}.</p>}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.dbName')}<span className="text-red-500">*</span></label>
            <input
              autoFocus
              type="text"
              value={dbName}
              onChange={event => { setDbName(event.target.value); setNameError(''); }}
              onBlur={() => setNameError(dbName.trim() ? validateDbName(dbName, kind, t) : '')}
              placeholder={kind === 'sqlite' ? 'my_database' : 'my_database'} required className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
            {nameError
              ? <p className="text-xs text-red-600 dark:text-red-400">{nameError}</p>
              : <p className="text-xs text-gray-500 dark:text-gray-400">{t('dbName.allowedHint', { hint: t(NAME_RULES[kind].hintKey), max: NAME_RULES[kind].max })}</p>}
            {kind === 'oracle' && !nameError && <p className="text-xs text-amber-600 dark:text-amber-500">{t('createDatabase.oracleSchemaNote')}</p>}
          </div>

          {(kind === 'mysql' || kind === 'mariadb') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.charset')}</label>
                <input
                  type="text"
                  value={charset}
                  onChange={event => setCharset(event.target.value)}
                  placeholder="utf8mb4"
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.collate')}</label>
                <input
                  type="text"
                  value={collate}
                  onChange={event => setCollate(event.target.value)}
                  placeholder="utf8mb4_unicode_ci"
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
            </div>
          )}

          {kind === 'postgres' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.encoding')}</label>
                <input
                  type="text"
                  value={encoding}
                  onChange={event => setEncoding(event.target.value)}
                  placeholder="UTF8"
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.template')}</label>
                <input
                  type="text"
                  value={template}
                  onChange={event => setTemplate(event.target.value)}
                  placeholder="template0"
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createDatabase.owner')}</label>
                <input
                  type="text"
                  value={owner}
                  onChange={event => setOwner(event.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
            </div>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">{t('createDatabase.settingsNote')}</p>
          <div className="pt-2 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{t('ui.cancel')}</button>
            <button type="submit" disabled={!dbName.trim() || !!validateDbName(dbName, kind, t) || !selectedConnId} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2"><Check className="w-4 h-4" />{t('createDatabase.create')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
