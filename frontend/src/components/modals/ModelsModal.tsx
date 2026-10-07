import React, { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { formatDateTime } from '../../intl';
import { Boxes, Download, GitCompare, History, Save, Trash2, Upload, X, Loader2, AlertTriangle } from 'lucide-react';
import { api, DbKind, ModelApplyResult, ModelDiffResult, ModelSummary, ModelVersionSummary, ProjectModel } from '../../api';

interface ModelsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  connId?: string | null;
  connKind?: DbKind;
  activeDb?: string;
  databases?: string[];
  userRole?: 'admin' | 'editor' | 'readonly';
}

/**
 * Модели проекта — сохранённые схемы целиком. Здесь можно забрать схему текущей
 * базы в модель, посмотреть версии и применить модель к другой базе.
 * Не путать с точкой восстановления (дамп одной таблицы) и «Откатить DDL».
 */
export function ModelsModal({ isOpen, onClose, addToast, connId, connKind, activeDb, databases = [], userRole }: ModelsModalProps) {
  const { t, lang } = useLanguage();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ProjectModel | null>(null);
  const [versions, setVersions] = useState<ModelVersionSummary[]>([]);
  const [importName, setImportName] = useState('');
  const [applyDb, setApplyDb] = useState('');
  const [applyResult, setApplyResult] = useState<ModelApplyResult | null>(null);
  const [diff, setDiff] = useState<ModelDiffResult | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [q, setQ] = useState('');

  const canWrite = userRole !== 'readonly';
  const canDelete = userRole === 'admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setModels(await api.models.list({ q: q || undefined, limit: 200 }));
    } catch (e: any) {
      addToast(t('models.errorLoad') + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, q]);

  useEffect(() => {
    if (isOpen) { void load(); setApplyDb(activeDb || ''); }
    else { setSelected(null); setApplyResult(null); setVersions([]); }
  }, [isOpen, load, activeDb]);

  const openModel = async (id: string) => {
    try {
      const m = await api.models.get(id);
      setSelected(m);
      setApplyResult(null);
      setDiff(null);
      setVersions(await api.models.versions(id));
    } catch (e: any) {
      addToast(t('models.errorOpen') + e.message, 'error');
    }
  };

  const importFromDatabase = async () => {
    if (!connId || !activeDb) { addToast(t('models.pickConnAndDb'), 'error'); return; }
    const name = importName.trim() || `${activeDb}_${new Date().toISOString().slice(0, 10)}`;
    setBusy(true);
    try {
      const m = await api.models.importFromDatabase({ connId, db: activeDb, name });
      addToast(t('models.saved', { name: m.name, count: m.tables.length }), 'success');
      setImportName('');
      await load();
      await openModel(m.id);
    } catch (e: any) {
      addToast(t('models.errorSave') + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Сравнение модели с базой: показываем, чего не хватает, что лишнее и что
   * разошлось. Ничего не меняет — только отчёт, поэтому readonly может его
   * смотреть так же, как схему таблицы.
   */
  const compare = async () => {
    if (!selected || !connId || !applyDb) { addToast(t('models.pickModelConnDb'), 'error'); return; }
    setDiffBusy(true);
    setDiff(null);
    try {
      const r = await api.models.diff(selected.id, { connId, db: applyDb });
      setDiff(r);
      addToast(
        r.equal
          ? t('models.schemaMatches')
          : t('models.diff', { missing: r.summary.missing, extra: r.summary.extra, changed: r.summary.changed }),
        r.equal ? 'success' : 'info'
      );
    } catch (e: any) {
      addToast(t('models.errorCompare') + e.message, 'error');
    } finally {
      setDiffBusy(false);
    }
  };

  const apply = async (dropExisting: boolean) => {
    if (!selected || !connId || !applyDb) { addToast(t('models.pickModelConnDb'), 'error'); return; }
    const what = dropExisting
      ? t('models.confirmRecreate', { name: selected.name, db: applyDb })
      : t('models.confirmCreateMissing', { name: selected.name, db: applyDb });
    if (!confirm(what)) return;
    setBusy(true);
    setApplyResult(null);
    try {
      const r = await api.models.apply(selected.id, { connId, db: applyDb, dropExisting });
      setApplyResult(r);
      const parts = [t('models.appliedCreated', { count: r.created.length })];
      if (r.replaced.length) parts.push(t('models.appliedReplaced', { count: r.replaced.length }));
      if (r.skipped.length) parts.push(t('models.appliedSkipped', { count: r.skipped.length }));
      addToast(t('models.applied', { parts: parts.join(', ') }), r.errors.length ? 'error' : 'success');
    } catch (e: any) {
      addToast(t('models.errorApply') + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveAsNewVersion = async () => {
    if (!selected) return;
    const note = prompt(t('models.versionNote'), t('models.modelEdit'));
    if (note === null) return;
    setBusy(true);
    try {
      const m = await api.models.save(selected.id, { tables: selected.tables, expectedVersion: selected.version, note });
      setSelected(m);
      setVersions(await api.models.versions(m.id));
      addToast(t('models.versionSaved', { version: m.version }), 'success');
      await load();
    } catch (e: any) {
      addToast(t('models.errorSaveVersion') + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (versionId: string, version: number) => {
    if (!selected) return;
    if (!confirm(t('models.confirmRestoreVersion', { version: version }))) return;
    setBusy(true);
    try {
      const m = await api.models.restoreVersion(selected.id, versionId);
      setSelected(m);
      setVersions(await api.models.versions(m.id));
      addToast(t('models.versionRestored', { from: version, to: m.version }), 'success');
      await load();
    } catch (e: any) {
      addToast(t('models.errorRestoreVersion') + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: ModelSummary) => {
    if (!confirm(t('models.confirmDropModel', { name: m.name }))) return;
    setBusy(true);
    try {
      await api.models.remove(m.id);
      if (selected?.id === m.id) setSelected(null);
      addToast(t('models.deleted'), 'success');
      await load();
    } catch (e: any) {
      addToast(t('models.errorDelete') + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (at: number) => formatDateTime(at, lang);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
 <div className="w-full max-w-6xl max-h-[90vh] my-auto bg-white dark:bg-[#1e2330] rounded-lg shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Boxes className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold">{t('ui.projectModels')}</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('models.savedSchemasHint')}</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded" title={t('header.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="min-w-0">
            <div className="flex gap-2 mb-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
                placeholder={t('models.searchHint')}
                className="flex-1 px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
              <button onClick={() => void load()} className="px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">{t('models.find')}</button>
            </div>

            {canWrite && connId && activeDb && (
              <div className="mb-3 p-3 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40 text-gray-900 dark:text-gray-100">
                <div className="text-xs font-medium mb-2">{t('models.saveSchemaTitle', { db: activeDb })}</div>
                <div className="flex gap-2">
                  <input
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder={`${activeDb}_${new Date().toISOString().slice(0, 10)}`}
                    className="flex-1 px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                  <button
                    onClick={() => void importFromDatabase()}
                    disabled={busy}
                    className="px-2 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />{t('models.captureSchema')}</button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Загрузка…</div>
            ) : models.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('models.empty')}</div>
            ) : (
              <table className="w-full table-fixed text-xs">
                <thead className="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                  <tr>
                    <th className="text-left py-1.5 w-[26%]">{t('ui.name')}</th>
                    <th className="text-left py-1.5 w-[22%]">{t('models.source')}</th>
                    <th className="text-right py-1.5 w-[9%]">{t('models.tables')}</th>
                    <th className="text-right py-1.5 w-[9%]">{t('models.version')}</th>
                    <th className="text-right py-1.5 w-[24%]">{t('models.updated')}</th>
                    <th className="w-[10%]" />
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b border-gray-100 dark:border-gray-800/60 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40 ${selected?.id === m.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                      onClick={() => void openModel(m.id)}
                    >
                      <td className="py-1.5 pr-2">
                        <div className="font-medium truncate">{m.name}</div>
                        {m.comment && <div className="text-gray-500 dark:text-gray-400 truncate">{m.comment}</div>}
                      </td>
                      <td className="py-1.5 pr-2 text-gray-500 dark:text-gray-400 truncate">{m.dbKind ?? '—'}{m.dbName ? `/${m.dbName}` : ''}</td>
                      <td className="py-1.5 text-right">{m.tables}</td>
                      <td className="py-1.5 text-right">v{m.version}</td>
                      <td className="py-1.5 text-right text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmt(m.updatedAt)}</td>
                      <td className="py-1.5 text-right">
                        {canDelete && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void remove(m); }}
                            className="p-1 text-red-500 hover:text-red-700"
                            title={t('models.deleteModel')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="min-w-0 border-t lg:border-t-0 lg:border-l border-gray-200 dark:border-gray-800 pl-0 lg:pl-4 pt-4 lg:pt-0">
            {!selected ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('models.pickModelLeft')}</div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="font-semibold">{selected.name} <span className="text-xs text-gray-500 dark:text-gray-400">v{selected.version}</span></div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {selected.tables.length} таблиц · {selected.actor ?? 'system'} · {fmt(selected.updatedAt)}
                  </div>
                </div>

                <div className="max-h-40 overflow-y-auto text-xs border border-gray-200 dark:border-gray-800 rounded">
                  {selected.tables.map((t) => (
                    <div key={t.name} className="px-2 py-1 border-b border-gray-100 dark:border-gray-800/60 last:border-b-0">
                      <span className="font-mono">{t.name}</span>
                      <span className="text-gray-500 dark:text-gray-400"> · {t.columns.length} кол. · {(t.indexes ?? []).length} idx · {(t.foreignKeys ?? []).length} fk</span>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => void saveAsNewVersion()} disabled={busy} className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 flex items-center gap-1">
                    <Save className="w-3.5 h-3.5" />{t('ui.saveVersion')}</button>
                </div>

                {versions.length > 0 && (
                  <div>
                    <div className="text-xs font-medium mb-1 flex items-center gap-1"><History className="w-3.5 h-3.5" />{t('models.versionHistory')}</div>
                    <div className="max-h-32 overflow-y-auto text-xs">
                      {versions.map((v) => (
                        <div key={v.id} className="flex items-center justify-between gap-2 py-1 border-b border-gray-100 dark:border-gray-800/60">
                          <span className="truncate">
                            v{v.version} · {v.tables} табл. · {v.actor ?? 'system'} · {fmt(v.at)}
                            {v.note ? ` · ${v.note}` : ''}
                          </span>
                          <button onClick={() => void restore(v.id, v.version)} disabled={busy} className="text-blue-600 dark:text-blue-400 hover:underline shrink-0 disabled:opacity-50">{t('models.restore')}</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
                  <div className="text-xs font-medium mb-2 flex items-center gap-1"><Upload className="w-3.5 h-3.5" />{t('models.applyToDb')}</div>
                  {connId ? (
                    <>
                      <div className="flex gap-2 mb-2">
                        <select
                          value={applyDb}
                          onChange={(e) => setApplyDb(e.target.value)}
                          className="flex-1 px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        >
                          <option value="">{t('models.noDb')}</option>
                          {databases.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={() => void compare()} disabled={diffBusy || !applyDb} className="px-2 py-1.5 text-xs rounded border border-blue-300 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50 flex items-center gap-1">
                          {diffBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />} {t('models.compareBtn')}
                        </button>
                        <button onClick={() => void apply(false)} disabled={busy || !applyDb} className="px-2 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 flex items-center gap-1">
                          <Download className="w-3.5 h-3.5" />{t('models.addMissing')}</button>
                        <button onClick={() => void apply(true)} disabled={busy || !applyDb} className="px-2 py-1.5 text-xs rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50 flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Пересоздать (с точкой восстановления)
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t('models.pickConnLeft')}</div>
                  )}
                </div>

                {diff && (
                  <div className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <GitCompare className="w-3.5 h-3.5" />
                      <span className="font-medium">Сравнение с {diff.db}</span>
                      {diff.equal
                        ? <span className="text-emerald-600 dark:text-emerald-400">схемы совпадают ({diff.summary.same} таблиц)</span>
                        : <span className="text-amber-600 dark:text-amber-400">{t('models.hasDiffs')}</span>}
                    </div>
                    {diff.missingTables.length > 0 && (
                      <div className="mb-1">Нет в базе: {diff.missingTables.join(', ')}</div>
                    )}
                    {diff.extraTables.length > 0 && (
                      <div className="mb-1">Лишние в базе: {diff.extraTables.join(', ')}</div>
                    )}
                    {diff.changedTables.map((t) => (
                      <div key={t.table} className="mb-1 border-t border-gray-100 dark:border-gray-800/60 pt-1">
                        <span className="font-mono">{t.table}</span>
                        {t.missingColumns.length > 0 && <div>• нет колонок: {t.missingColumns.join(', ')}</div>}
                        {t.extraColumns.length > 0 && <div>• лишние колонки: {t.extraColumns.join(', ')}</div>}
                        {t.changedColumns.map((c) => (
                          <div key={c.column}>• {c.column}: {c.changes.join('; ')}</div>
                        ))}
                        {t.missingIndexes.length > 0 && <div>• нет индексов: {t.missingIndexes.join(', ')}</div>}
                        {t.extraIndexes.length > 0 && <div>• лишние индексы: {t.extraIndexes.join(', ')}</div>}
                        {t.missingForeignKeys.length > 0 && <div>• нет связей: {t.missingForeignKeys.join(', ')}</div>}
                        {t.extraForeignKeys.length > 0 && <div>• лишние связи: {t.extraForeignKeys.join(', ')}</div>}
                        {t.missingTriggers.length > 0 && <div>• нет триггеров: {t.missingTriggers.join(', ')}</div>}
                        {t.extraTriggers.length > 0 && <div>• лишние триггеры: {t.extraTriggers.join(', ')}</div>}
                      </div>
                    ))}
                    <div className="text-gray-500 dark:text-gray-400 mt-1">
                      {t('models.diffSummary', { same: diff.summary.same, missing: diff.summary.missing, extra: diff.summary.extra, changed: diff.summary.changed })}
                    </div>
                  </div>
                )}

                {applyResult && (
                  <div className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2 max-h-48 overflow-y-auto">
                    <div className="mb-1">
                      Создано: {applyResult.created.join(', ') || '—'}
                      {applyResult.replaced.length > 0 && <> · пересоздано: {applyResult.replaced.join(', ')}</>}
                      {applyResult.skipped.length > 0 && <> · пропущено: {applyResult.skipped.join(', ')}</>}
                    </div>
                    {applyResult.errors.length > 0 && (
                      <div className="text-red-600 dark:text-red-400 mb-1">
                        {applyResult.errors.map((e) => `${e.table}: ${e.error}`).join('; ')}
                      </div>
                    )}
                    <pre className="font-mono whitespace-pre-wrap text-gray-600 dark:text-gray-400">{applyResult.statements.join(';\n')}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
