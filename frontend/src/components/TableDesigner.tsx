import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Columns3, GripVertical, Key, Plus, RefreshCcw, Trash2, TriangleAlert, Wand2, X } from 'lucide-react';
import { ColumnDef, api } from '../api';
import { ChangePlan, ColumnCard, LoadedColumn, cardFromLoaded, cardToColumnDef, composeType, planChanges } from '../core/columnPlan';
import { DB_DIALECTS, SupportedDbDialect, dialectForKind } from '../dbDialects';
import { QuickEdit } from './QuickEdit';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Визуальный конструктор колонок — замена форме «строка на колонку».
 *
 * Что здесь принципиально:
 *
 *  - Порядок карточек задаёт порядок колонок в таблице, но только для НОВОЙ
 *    таблицы. У существующей порядок зафиксирован в СУБД, а AlterOp не умеет
 *    переставлять колонки, поэтому для неё перетаскивание отключено и сказано
 *    почему. Иначе панель обещала бы перестановку, которую сервер не выполнит.
 *  - Изменения не применяются «по мере ввода»: карточки сравниваются со схемой,
 *    и сначала показывается предпросмотр SQL, как в остальных операциях со
 *    структурой.
 *  - Удаление колонки в существующей таблице помечается отдельно, потому что
 *    это необратимая потеря данных, и требует подтверждения дважды.
 */

interface TableDesignerProps {
  connId: string | null;
  db: string;
  connKind?: string;
  tables: string[];
  canMutate: boolean;
  /** Тип тоста в компоненте совпадает с типом в App: параметр не обязателен. */
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** Вызывается после применения, чтобы внешний список таблиц/схем обновился. */
  onChanged?: () => void;
}

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `c${keyCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Типы для палитры. Список PALETTE_HINTS — короткий, он показывается только
 * если такой тип есть у выбранной СУБД: предлагать «JSON» в SQLite, где его нет,
 * значило бы тихо подменить тип на другой и показать не то, что применят.
 */
const PALETTE_HINTS = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'DECIMAL', 'DATE', 'DATETIME', 'BOOLEAN', 'JSON'];

export function TableDesigner({ connId, db, connKind, tables, canMutate, addToast, onChanged }: TableDesignerProps) {
  const { t } = useLanguage();
  const dialect: SupportedDbDialect = dialectForKind(connKind);
  const config = DB_DIALECTS[dialect] ?? DB_DIALECTS.mysql;
  // Структуру в MongoDB и Redis через design API не меняют, поэтому редактор
  // там просто не предлагается.
  const supported = connKind !== 'mongodb' && connKind !== 'redis';

  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [tableName, setTableName] = useState('');
  const [cards, setCards] = useState<ColumnCard[]>([]);
  const [original, setOriginal] = useState<ColumnCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);

  const isExisting = mode === 'existing';
  // Порядок колонок меняется только у новой таблицы (см. комментарий наверху).
  const reorderEnabled = !isExisting;
  const paletteTypes = useMemo(
    () => PALETTE_HINTS.filter(type => config.types.includes(type)),
    [config.types]
  );

  const resetNew = useCallback(() => {
    setMode('new');
    setTableName('');
    setOriginal(null);
    setPreview(null);
    setCards([
      { key: nextKey(), name: 'id', type: config.defaultType, length: config.defaultLength, nullable: false, primary: true, autoInc: true, def: '' },
      { key: nextKey(), name: '', type: config.defaultType, length: '', nullable: true, primary: false, autoInc: false, def: '' }
    ]);
  }, [config.defaultLength, config.defaultType]);

  useEffect(() => { resetNew(); }, [resetNew]);

  const loadExisting = useCallback(async (name: string) => {
    if (!connId || !name) return;
    setLoading(true);
    setPreview(null);
    try {
      const raw = (await api.schema(connId, db, name)) as any;
      const list: LoadedColumn[] = Array.isArray(raw) ? raw : (raw?.columns ?? []);
      const ordered = [...list].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
      const next = ordered.map(column => cardFromLoaded(column, nextKey()));
      setCards(next);
      setOriginal(next.map(card => ({ ...card })));
      setTableName(name);
      setMode('existing');
    } catch (error: any) {
      addToast(t('designer.errorLoadSchema') + error.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, connId, db]);

  const update = (key: string, patch: Partial<ColumnCard>) => {
    setCards(prev => prev.map(card => {
      if (card.key !== key) return card;
      const next = { ...card, ...patch };
      // Первичный ключ не может быть NULL, а автоинкремент без ключа не имеет смысла
      if (patch.primary === true) { next.nullable = false; next.autoInc = true; }
      if (patch.primary === false) next.autoInc = false;
      return next;
    }));
    setPreview(null);
  };

  const removeCard = (key: string) => {
    setCards(prev => prev.filter(card => card.key !== key));
    setPreview(null);
  };

  const addCard = (type?: string) => {
    const chosen = (type && config.types.includes(type.toUpperCase()) ? type.toUpperCase() : config.defaultType);
    setCards(prev => [...prev, {
      key: nextKey(), name: '', type: chosen,
      length: /^(VARCHAR|CHAR)$/.test(chosen) ? config.defaultLength : '',
      nullable: true, primary: false, autoInc: false, def: ''
    }]);
    setPreview(null);
  };

  const moveCard = (fromKey: string, toIndex: number) => {
    setCards(prev => {
      const from = prev.findIndex(card => card.key === fromKey);
      if (from < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      const target = toIndex > from ? toIndex - 1 : toIndex;
      next.splice(Math.max(0, Math.min(next.length, target)), 0, moved);
      return next;
    });
    setPreview(null);
  };

  const problems = useMemo(() => {
    const list: string[] = [];
    const named = cards.filter(card => card.name.trim());
    if (!isExisting && !tableName.trim()) list.push(t('designer.tableNameRequired'));
    if (!named.length) list.push(t('designer.oneColumnRequired'));
    const seen = new Set<string>();
    for (const card of named) {
      const name = card.name.trim();
      if (seen.has(name.toLowerCase())) list.push(t('designer.duplicateColumn', { name: name }));
      seen.add(name.toLowerCase());
      if (!/^[\p{L}0-9_]+$/u.test(name)) list.push(t('designer.invalidColumnName', { name: name }));
    }
    const pk = named.filter(card => card.primary);
    if (pk.length > 1) list.push(t('designer.singlePkOnly'));
    return [...new Set(list)];
  }, [cards, isExisting, tableName]);

  const plan: ChangePlan | null = useMemo(
    () => (isExisting && original ? planChanges(cards, original) : null),
    [cards, isExisting, original]
  );
  // Колонки без имени не отправляются на сервер: и в подсказке об ошибках, и
  // здесь считается одно и то же.
  const columnsToSend: ColumnDef[] = useMemo(
    () => cards.filter(card => card.name.trim()).map(cardToColumnDef),
    [cards]
  );
  const hasChanges = isExisting ? Boolean(plan && plan.ops.length) : columnsToSend.length > 0;

  const describeOps = (): string[] => {
    if (!plan) return [];
    const out: string[] = [];
    if (plan.add) out.push(t('designer.planAdd', { count: plan.add }));
    if (plan.rename) out.push(t('designer.planRename', { count: plan.rename }));
    if (plan.alter) out.push(t('designer.planAlter', { count: plan.alter }));
    if (plan.pkChanged) out.push(t('designer.planPk'));
    if (plan.drop) out.push(t('designer.planDrop', { count: plan.drop }));
    return out;
  };

  const apply = async () => {
    if (!connId || problems.length || busy) return;
    setBusy(true);
    try {
      if (!isExisting) {
        const columns = columnsToSend;
        if (!confirm(`Создать таблицу «${tableName.trim()}»?\n\nКолонки (${columns.length}): ${columns.map(c => `${c.name} ${c.type}`).join(', ')}`)) return;
        await api.createTable(connId, db, { name: tableName.trim(), columns });
        addToast(t('designer.tableCreated', { name: tableName.trim() }), 'success');
        resetNew();
        onChanged?.();
        return;
      }

      if (!plan?.ops.length) { addToast(t('designer.noChanges'), 'info'); return; }
      if (plan.drop && !confirm(t('designer.confirmDropColumns', { count: plan.drop }))) return;

      // Предпросмотр обязателен: показываем SQL до применения, как в остальных
      // операциях со структурой.
      const shown = await api.previewAlter(connId, db, tableName, plan.ops);
      const statements = shown.statements ?? [];
      setPreview(statements);
      const sql = statements.join(';\n');
      if (!confirm(t('designer.applyConfirm', { table: tableName, sql }))) {
        setPreview(null);
        return;
      }
      const result = await api.alterTable(connId, db, tableName, plan.ops);
      addToast(t('designer.appliedSuffix', { extra: result.applied ? t('designer.appliedCount', { count: result.applied }) : '' }), 'success');
      setPreview(null);
      await loadExisting(tableName);
      onChanged?.();
    } catch (error: any) {
      addToast(t('designer.errorApply') + error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        {t('designer.sqlOnlyHint', { kind: connKind === 'mongodb' ? 'MongoDB' : 'Redis' })}
      </div>
    );
  }

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
      <div className="px-3 py-2.5 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2 text-gray-900 dark:text-gray-100">
        <div className="flex items-center gap-2 text-sm">
          <Columns3 className="w-4 h-4 text-indigo-500" />
          <select
            value={isExisting ? tableName : '__new__'}
            onChange={event => {
              const value = event.target.value;
              if (value === '__new__') resetNew();
              else void loadExisting(value);
            }}
            className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="__new__">{t('designer.newTableSuffix')}</option>
            {tables.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          {!isExisting && (
            <input
              value={tableName}
              onChange={event => { setTableName(event.target.value); setPreview(null); }}
              placeholder={t('designer.tableNameHint')}
              className="px-2 py-1.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {isExisting && <span className="text-xs text-gray-500 dark:text-gray-400">СУБД: {config.name}</span>}
          {isExisting && (
            <button onClick={() => void loadExisting(tableName)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1">
              <RefreshCcw className="w-3.5 h-3.5" />{t('designer.reload')}</button>
          )}
          <button
            onClick={() => void apply()}
            disabled={!canMutate || busy || loading || problems.length > 0 || !hasChanges}
            title={!canMutate ? t('designer.readOnlyRole') : undefined}
            className="px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? t('designer.applying') : isExisting ? t('designer.applyChanges') : t('designer.createTable')}
          </button>
        </div>
      </div>

      {loading && <div className="p-4 text-sm text-gray-500 dark:text-gray-400">{t('designer.loadingSchema')}</div>}

      {!loading && (
        <div className="p-3 space-y-3">
          {problems.length > 0 && (
            <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
              {problems.map(problem => <li key={problem}>• {problem}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('designer.dragTypeHint')}</span>
            {paletteTypes.map(type => (
              <button
                key={type}
                draggable
                onDragStart={event => event.dataTransfer.setData('text/plain', `type:${type}`)}
                onClick={() => addCard(type)}
                disabled={!canMutate}
                title={t('designer.addColumnOfType', { type: type })}
                className="px-2 py-0.5 text-[11px] font-mono rounded border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-40 cursor-grab"
              >
                {type}
              </button>
            ))}
          </div>

          <div
            onDragOver={event => { if (reorderEnabled || event.dataTransfer.types.includes('text/plain')) event.preventDefault(); }}
            onDrop={event => {
              event.preventDefault();
              const payload = event.dataTransfer.getData('text/plain');
              if (payload.startsWith('type:')) { addCard(payload.slice(5)); return; }
            }}
            className="min-h-[120px] rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-800 p-2 space-y-2"
          >
            {cards.length === 0 && (
              <div className="p-6 text-center text-xs text-gray-400">{t('designer.emptyHint')}</div>
            )}
            {cards.map((card, index) => (
              <div key={card.key}>
                {reorderEnabled && overIndex === index && <div className="h-0.5 bg-indigo-500 rounded mb-1" />}
                <div
                  draggable={reorderEnabled && canMutate}
                  onDragStart={event => {
                    if (!reorderEnabled) { event.preventDefault(); return; }
                    setDragKey(card.key);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', `move:${card.key}`);
                  }}
                  onDragEnd={() => { setDragKey(null); setOverIndex(null); }}
                  onDragOver={event => {
                    if (!reorderEnabled) return;
                    event.preventDefault();
                    setOverIndex(index);
                  }}
                  onDrop={event => {
                    if (!reorderEnabled) return;
                    event.preventDefault();
                    const payload = event.dataTransfer.getData('text/plain');
                    if (payload.startsWith('move:')) moveCard(payload.slice(5), index);
                    else if (payload.startsWith('type:')) addCard(payload.slice(5));
                    setOverIndex(null);
                  }}
                  className={`flex items-start gap-2 p-2 rounded border bg-white dark:bg-gray-900/40 ${
                    dragKey === card.key ? 'opacity-50' : ''
                  } ${card.primary ? 'border-amber-300 dark:border-amber-700' : 'border-gray-200 dark:border-gray-800'}`}
                >
                  {reorderEnabled && (
                    <span className="mt-1.5 text-gray-300 dark:text-gray-600 cursor-grab" title={t('designer.dragToReorder')}>
                      <GripVertical className="w-4 h-4" />
                    </span>
                  )}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        value={card.name}
                        onChange={event => update(card.key, { name: event.target.value })}
                        placeholder={t('ui.columnNameHint')}
                        className="px-2 py-1 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 min-w-[140px] flex-1 text-gray-900 dark:text-gray-100"
                      />
                      <QuickEdit
                        value={card.name}
                        kind="text"
                        mono
                        label={t('tableFields.name')}
                        placeholder={t('ui.columnNameHint')}
                        onSave={value => update(card.key, { name: String(value) })}
                      />
                      <select
                        value={card.type}
                        onChange={event => update(card.key, { type: event.target.value })}
                        className="px-2 py-1 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      >
                        {Array.from(new Set([card.type, ...config.types])).filter(Boolean).map(type => <option key={type} value={type}>{type}</option>)}
                      </select>
                      <QuickEdit
                        value={card.type}
                        kind="select"
                        mono
                        options={Array.from(new Set([card.type, ...config.types])).filter(Boolean)}
                        label={t('tableFields.type')}
                        onSave={value => update(card.key, { type: String(value) })}
                      />
                      {/^(VARCHAR|CHAR)$/.test(card.type) && (
                        <>
                          <input
                            value={card.length}
                            onChange={event => update(card.key, { length: event.target.value })}
                            placeholder={t('designer.lengthHint')}
                            className="w-20 px-2 py-1 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                          />
                          <QuickEdit
                            value={card.length}
                            kind="text"
                            mono
                            fallback={config.defaultLength}
                            label={t('tableFields.length')}
                            placeholder={config.defaultLength}
                            onSave={value => update(card.key, { length: String(value) })}
                          />
                        </>
                      )}
                      <button
                        onClick={() => update(card.key, { primary: !card.primary })}
                        title={card.primary ? t('designer.dropPk') : t('designer.makePk')}
                        className={`p-1 rounded ${card.primary ? 'bg-amber-500 text-white' : 'text-gray-300 dark:text-gray-600 hover:text-amber-500'}`}
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>
                      <label className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400" title={t('designer.allowNull')}>
                        <input
                          type="checkbox"
                          checked={card.nullable}
                          disabled={card.primary}
                          onChange={event => update(card.key, { nullable: event.target.checked })}
                        />
                        NULL
                      </label>
                      <QuickEdit
                        value={card.nullable}
                        kind="boolean"
                        disabled={card.primary}
                        label={t('tableFields.null')}
                        onSave={value => update(card.key, { nullable: Boolean(value) })}
                      />
                      <label className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400" title={t('designer.autoIncHint')}>
                        <input
                          type="checkbox"
                          checked={card.autoInc}
                          disabled={!card.primary}
                          onChange={event => update(card.key, { autoInc: event.target.checked })}
                        />
                        AUTO
                      </label>
                      <input
                        value={card.def}
                        onChange={event => update(card.key, { def: event.target.value })}
                        placeholder={t('ui.defaultHint')}
                        className="w-32 px-2 py-1 text-xs font-mono rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      />
                      <QuickEdit
                        value={card.def}
                        kind="multiline"
                        mono
                        placeholder={t('ui.defaultHint')}
                        label={t('tableFields.default')}
                        hint={t('tableFields.defaultHint')}
                        onSave={value => update(card.key, { def: String(value) })}
                      />
                      <button
                        onClick={() => removeCard(card.key)}
                        disabled={!canMutate}
                        title={t('designer.dropColumn')}
                        className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {isExisting && original && !original.some(o => o.name === card.name) && (
                      <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{t('designer.newColumnSuffix')}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {reorderEnabled && overIndex === cards.length && cards.length > 0 && <div className="h-0.5 bg-indigo-500 rounded" />}
          </div>

          {reorderEnabled && cards.length > 0 && (
            <button onClick={() => addCard()} disabled={!canMutate} className="text-xs text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5 disabled:opacity-40">
              <Plus className="w-3.5 h-3.5" />{t('designer.addColumn')}</button>
          )}

          {isExisting && !reorderEnabled && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('designer.orderNote')}</p>
          )}

          {plan && plan.ops.length > 0 && (
            <div className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2 bg-gray-50 dark:bg-gray-900/40 text-gray-900 dark:text-gray-100">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <Wand2 className="w-3.5 h-3.5 text-indigo-500" /> Запланировано: {describeOps().join('; ')}
              </div>
              {plan.drop > 0 && (
                <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
                  <TriangleAlert className="w-3.5 h-3.5 mt-0.5" />
                  <span>{t('designer.dropNote')}</span>
                </div>
              )}
            </div>
          )}

          {preview && preview.length > 0 && (
            <div className="text-xs">
              <div className="mb-1 text-gray-500 dark:text-gray-400">{t('designer.willRun')}</div>
              <pre className="p-2 font-mono text-[11px] bg-gray-900 text-emerald-300 rounded overflow-x-auto whitespace-pre-wrap">{preview.join(';\n')}</pre>
            </div>
          )}

          {isExisting && plan && plan.ops.length === 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400">{t('designer.noChanges')}</div>
          )}

          {!canMutate && (
            <div className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <X className="w-3.5 h-3.5" />{t('designer.viewForbidden')}</div>
          )}
        </div>
      )}
    </div>
  );
}
