import React, { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { Check, Database, X } from 'lucide-react';
import { CreateConnectionInput, DbKind, ConnectionInfo } from '../../api';
import { isKindEnabled } from '../../engineKinds';

interface CreateConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateConnectionInput) => Promise<void>;
  initialConnection?: ConnectionInfo | null;
  onSave?: (input: CreateConnectionInput) => Promise<void>;
  enabledKinds?: string[];
}

const kinds: { value: DbKind; label: string; defaultPort: number }[] = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'mariadb', label: 'MariaDB', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'mongodb', label: 'MongoDB', defaultPort: 27017 },
  { value: 'redis', label: 'Redis', defaultPort: 6379 },
  { value: 'oracle', label: 'Oracle', defaultPort: 1521 },
  { value: 'sqlite', label: 'SQLite', defaultPort: 0 },
];

const initialForm = (connection?: ConnectionInfo | null): CreateConnectionInput => ({
  name: connection?.name ?? '',
  kind: connection?.kind ?? 'mysql',
  host: connection?.host ?? 'localhost',
  port: connection?.port ?? 3306,
  database: connection?.database ?? '',
  user: connection?.user ?? '',
  password: '',
  readOnly: Boolean(connection?.readOnly),
  filePath: connection?.filePath,
});

export function CreateConnectionModal({ isOpen, onClose, onCreate, initialConnection = null, onSave, enabledKinds }: CreateConnectionModalProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState<CreateConnectionInput>(initialForm());
  const [busy, setBusy] = useState(false);
  // Типы, выключенные в настройках, не предлагаем. При правке существующего
  // подключения его тип остаётся в списке — иначе поле схлопнулось бы.
  const visibleKinds = kinds.filter(item => isKindEnabled(item.value, enabledKinds) || item.value === form.kind);
  const kindConfig = useMemo(() => kinds.find(item => item.value === form.kind) || kinds[0], [form.kind]);

  useEffect(() => {
    if (!isOpen) return;
    setForm(initialForm(initialConnection));
    setBusy(false);
  }, [isOpen]);

  const setField = <K extends keyof CreateConnectionInput>(key: K, value: CreateConnectionInput[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleKindChange = (kind: DbKind) => {
    const config = kinds.find(item => item.value === kind) || kinds[0];
    setForm(prev => ({
      ...prev,
      kind,
      port: config.defaultPort || undefined,
      database: kind === 'redis' ? '0' : prev.database,
      host: kind === 'sqlite' ? '' : prev.host || 'localhost',
      user: kind === 'sqlite' ? '' : prev.user,
      password: kind === 'sqlite' ? '' : prev.password,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || busy) return;
    if (form.kind === 'sqlite' && !form.filePath?.trim()) return;
    setBusy(true);
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        host: form.host?.trim() || undefined,
        port: form.port || undefined,
        user: form.user?.trim() || undefined,
        database: form.database?.trim() || undefined,
        filePath: form.filePath?.trim() || undefined,
        password: form.password || undefined,
        createDatabase: form.kind === 'sqlite' ? true : undefined,
      };
      if (onSave) await onSave(payload);
      else await onCreate(payload);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-3xl my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
             <Database className="w-5 h-5 text-blue-500" /> {initialConnection ? t('createConnection.editTitle') : t('createConnection.newTitle')}
          </h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createConnection.connType')}</label>
            <select value={form.kind} onChange={event => handleKindChange(event.target.value as DbKind)} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500">
              {visibleKinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createConnection.name')}<span className="text-red-500">*</span></label>
            <input autoFocus required value={form.name} onChange={event => setField('name', event.target.value)} placeholder={t('createConnection.nameExample')} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
          </div>
          {form.kind === 'sqlite' ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createConnection.filePath')}<span className="text-red-500">*</span></label>
              <input required value={form.filePath || ''} onChange={event => setField('filePath', event.target.value)} placeholder="data/local.sqlite" className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createConnection.host')}</label>
                  <input value={form.host || ''} onChange={event => setField('host', event.target.value)} placeholder="localhost" className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('createConnection.port')}</label>
                  <input type="number" min="1" max="65535" value={form.port || ''} onChange={event => setField('port', event.target.value ? Number(event.target.value) : undefined)} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{form.kind === 'redis' ? t('createConnection.dbIndex') : t('createConnection.database')}</label>
                  <input value={form.database || ''} onChange={event => setField('database', event.target.value)} placeholder={form.kind === 'redis' ? '0' : 'необязательно'} className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('ui.user')}</label>
                  <input value={form.user || ''} onChange={event => setField('user', event.target.value)} placeholder={t('createConnection.optional')} autoComplete="off" className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('ui.password')}</label>
                <input type="password" value={form.password || ''} onChange={event => setField('password', event.target.value)} autoComplete="new-password" className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white focus:outline-none focus:border-blue-500" />
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={Boolean(form.readOnly)} onChange={event => setField('readOnly', event.target.checked)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />{t('createConnection.readOnly')}</label>
          <div className="pt-2 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{t('ui.cancel')}</button>
            <button type="submit" disabled={busy || !form.name.trim() || (form.kind === 'sqlite' && !form.filePath?.trim())} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md text-sm font-medium flex items-center gap-2">
               <Check className="w-4 h-4" /> {busy ? t('createConnection.saving') : initialConnection ? t('createConnection.save') : t('createConnection.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
