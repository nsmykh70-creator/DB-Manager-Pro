import React, { useState } from 'react';
import { X, Plus, Key, Trash2, Check, Sparkles, Database } from 'lucide-react';
import { SupportedDbDialect, DB_DIALECTS } from '../../dbDialects';
import { ColumnDef } from '../../api';
import { QuickEdit } from '../QuickEdit';
import { useLanguage } from '../../contexts/LanguageContext';

interface TableField {
  id: number;
  name: string;
  type: string;
  length: string;
  isNull: boolean;
  isPk: boolean;
  default: string;
  autoInc: boolean;
}

interface CreateTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, dialect: SupportedDbDialect, columns: ColumnDef[], opts?: { comment?: string; engine?: string; charset?: string; collate?: string }) => void | Promise<void>;
  initialDialect?: SupportedDbDialect;
  dialectLocked?: boolean;
}

export function CreateTableModal({ isOpen, onClose, onCreate, initialDialect = 'mysql', dialectLocked = false }: CreateTableModalProps) {
  const { t } = useLanguage();
  const [selectedDialect, setSelectedDialect] = useState<SupportedDbDialect>(initialDialect);
  const [tableName, setTableName] = useState('');
  // Необязательные атрибуты таблицы: комментарий (mysql/pg/oracle),
  // движок/кодировка/сравнение (только mysql/mariadb).
  const [tableComment, setTableComment] = useState('');
  const [tableEngine, setTableEngine] = useState('');
  const [tableCharset, setTableCharset] = useState('');
  const [tableCollate, setTableCollate] = useState('');

  const currentConfig = DB_DIALECTS[selectedDialect] || DB_DIALECTS.mysql;

  // Счётчик идентификаторов полей. Раньше новый id был Date.now(), и при
  // быстрых кликах «добавить поле» два поля получали один ключ — React
  // переиспользовал строку и правки применялись не к тому полю.
  const nextFieldId = React.useRef(4);

  const [fields, setFields] = useState<TableField[]>([
    { id: 1, name: 'id', type: 'INT', length: '11', isNull: false, isPk: true, default: '', autoInc: true },
    { id: 2, name: 'name', type: 'VARCHAR', length: '191', isNull: false, isPk: false, default: '', autoInc: false },
    { id: 3, name: 'created_at', type: 'TIMESTAMP', length: '', isNull: false, isPk: false, default: 'CURRENT_TIMESTAMP', autoInc: false }
  ]);

  React.useEffect(() => {
    setSelectedDialect(initialDialect);
    const cfg = DB_DIALECTS[initialDialect];
    setFields(prev => prev.map(field => {
      const type = cfg.types.find(candidate => candidate.toLowerCase() === field.type.toLowerCase())
        || cfg.types.find(candidate => field.type.toLowerCase().includes(candidate.toLowerCase().split(' ')[0]))
        || cfg.defaultType;
      return { ...field, type, length: field.length || cfg.defaultLength, autoInc: field.isPk && field.autoInc };
    }));
  }, [initialDialect]);

  const addField = () => {
    // Обновление функциональное: setFields([...fields, ...]) брал с��писок из
    // замыкания, и несколько быстрых кликов подряд добавляли одно поле вместо
    // нескольких — состояние ещё не успевало перерисоваться.
    setFields(prev => [
      ...prev, 
      { 
        // Идентификатор из счётчика, а не из времени: Date.now() совпадал при
        // быстрых кликах, и React ругался на одинаковые key в списке.
        id: nextFieldId.current++, 
        name: '', 
        type: currentConfig.defaultType, 
        length: currentConfig.defaultLength, 
        isNull: true,
        isPk: false,
        default: '',
        autoInc: false
      }
    ]);
  };

  const removeField = (id: number) => {
    setFields(fields.filter(f => f.id !== id));
  };

  const toggleFieldPk = (index: number) => {
    const updated = [...fields];
    const current = updated[index];
    const nextPk = !current.isPk;
    current.isPk = nextPk;
    if (nextPk) {
      current.isNull = false;
    } else {
      current.autoInc = false;
    }
    setFields(updated);
  };

  const handleDialectChange = (newDialect: SupportedDbDialect) => {
    setSelectedDialect(newDialect);
    const cfg = DB_DIALECTS[newDialect];
    setFields(fields.map(field => {
      const type = cfg.types.find(candidate => candidate.toLowerCase() === field.type.toLowerCase())
        || cfg.types.find(candidate => field.type.toLowerCase().includes(candidate.toLowerCase().split(' ')[0]))
        || cfg.defaultType;
      return { ...field, type, length: field.length || cfg.defaultLength, autoInc: field.isPk && field.autoInc };
    }));
  };

  const handleCreate = async () => {
    if (!tableName.trim()) {
      alert(t('createTable.nameRequired'));
      return;
    }
    const columns: ColumnDef[] = fields
      .filter(field => field.name.trim())
      .map(field => {
        const baseType = field.type.trim();
        const type = /^(VARCHAR|CHAR)$/i.test(baseType) && field.length.trim()
          ? `${baseType}(${field.length.trim()})`
          : baseType;
        return {
          name: field.name.trim(),
          type,
          nullable: field.isNull,
          primary: field.isPk,
           autoInc: field.isPk && field.autoInc,
          default: field.default.trim() || null,
        };
      });
    if (columns.length === 0) {
      alert(t('createTable.oneFieldRequired'));
      return;
    }
    const opts: { comment?: string; engine?: string; charset?: string; collate?: string } = {};
    if (tableComment.trim()) opts.comment = tableComment.trim();
    if ((selectedDialect === 'mysql' || selectedDialect === 'mariadb')) {
      if (tableEngine.trim()) opts.engine = tableEngine.trim();
      if (tableCharset.trim()) opts.charset = tableCharset.trim();
      if (tableCollate.trim()) opts.collate = tableCollate.trim();
    }
    await onCreate(tableName.trim(), selectedDialect, columns, opts);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">{t('createTable.designerTitle')}</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('createTable.designerHint')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dialect Switcher Bar */}
        <div className="px-6 py-2.5 bg-gray-100/70 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 font-medium">
            <Sparkles className="w-3.5 h-3.5 text-blue-500" />
            <span>{t('createTable.targetDb')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!dialectLocked && (Object.keys(DB_DIALECTS) as SupportedDbDialect[]).map((dialectKey) => {
              const d = DB_DIALECTS[dialectKey];
              const isActive = selectedDialect === dialectKey;
              return <button type="button" key={dialectKey} onClick={() => handleDialectChange(dialectKey)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${isActive ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-500' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>{d.name}</button>;
            })}
            {dialectLocked && <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white">{currentConfig.name}</span>}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 flex-1 min-w-0 overflow-y-auto space-y-6">
          
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('createTable.tableName')}<span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder={t('createTable.nameHint')}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Fields */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider">
                {t('createTable.fieldsTitle', { count: fields.length })}
              </h3>
              <span className="text-xs text-gray-400">{t('createTable.pkHint')}</span>
            </div>
            
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                {/* Таблица полей не фиксирует ширину колонок: раньше здесь стоял
                    whitespace-nowrap, из-за чего минимальная ширина таблицы
                    (8 колонок с полями ввода) превышала окно, и появлялась
                    горизонтальная прокрутка. Теперь колонки сжимаются, а
                    прокрутка остаётся лишь как запасной вариант для совсем
                    узкого экрана. */}
                <table className="w-full table-fixed text-sm text-left">
                  <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-800">
                    {/* Ширины заданы долями: при table-fixed колонки делят
                        окно, а не требуют свою минимальную ширину. Заголовки
                        переносятся, поэтому длинные названия не растягивают
                        колонку и не вызывают горизонтальную прокрутку. */}
                    <tr>
                      <th className="px-2 py-2.5 font-medium w-[6%] text-center" title={t('createTable.primaryKey')}>PK</th>
                      <th className="px-2 py-2.5 font-medium w-[20%] break-words">{t('createTable.fieldName')}</th>
                      <th className="px-2 py-2.5 font-medium w-[20%] break-words">{t('createTable.typeHeader', { name: currentConfig.name })}</th>
                      <th className="px-2 py-2.5 font-medium w-[12%] break-words">{t('createTable.length')}</th>
                       <th className="px-2 py-2.5 font-medium w-[9%] text-center break-words">{t('createTable.null')}</th>
                       <th className="px-2 py-2.5 font-medium w-[19%] break-words">{t('createTable.default')}</th>
                       <th className="px-2 py-2.5 font-medium w-[10%] text-center break-words">{t('createTable.autoincrement')}</th>
                      <th className="px-2 py-2.5 font-medium w-[4%] text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                    {fields.map((field, index) => (
                      <tr key={field.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors ${field.isPk ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}>
                        
                        {/* PK Toggle Button */}
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => toggleFieldPk(index)}
                            className={`p-1.5 rounded transition-all ${
                              field.isPk 
                                ? 'bg-amber-500 text-white shadow-xs hover:bg-amber-600' 
                                : 'text-gray-300 dark:text-gray-600 hover:text-amber-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                            title={field.isPk ? "Первичный ключ (нажмите чтобы снять)" : "Назначить первичным ключом (Primary Key)"}
                          >
                            <Key className="w-3.5 h-3.5 stroke-[2.5]" />
                          </button>
                        </td>

                        {/* Name */}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={field.name}
                              placeholder={t('createTable.columnNameHint')}
                              onChange={(e) => {
                                const newFields = [...fields];
                                newFields[index].name = e.target.value;
                                setFields(newFields);
                              }}
                              className="w-full px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white font-mono focus:border-blue-500 outline-none"
                            />
                            <QuickEdit
                              value={field.name}
                              kind="text"
                              mono
                              label={`${t('tableFields.name')} · ${field.name || '—'}`}
                              placeholder={t('createTable.columnNameHint')}
                              onSave={value => {
                                const newFields = [...fields];
                                newFields[index].name = String(value);
                                setFields(newFields);
                              }}
                            />
                          </div>
                        </td>

                        {/* Type */}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <select
                              value={field.type}
                              onChange={(e) => {
                                const newFields = [...fields];
                                newFields[index].type = e.target.value;
                                setFields(newFields);
                              }}
                              className="w-full px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white font-mono focus:border-blue-500 outline-none"
                            >
                              {currentConfig.types.map(t => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                            <QuickEdit
                              value={field.type}
                              kind="select"
                              mono
                              options={Array.from(new Set([field.type, ...currentConfig.types]))}
                              label={`${t('tableFields.type')} · ${field.name || '—'}`}
                              onSave={value => {
                                const newFields = [...fields];
                                newFields[index].type = String(value);
                                setFields(newFields);
                              }}
                            />
                          </div>
                        </td>

                        {/* Length */}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={field.length}
                              placeholder="255, 11..."
                              onChange={(e) => {
                                const newFields = [...fields];
                                newFields[index].length = e.target.value;
                                setFields(newFields);
                              }}
                              className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white font-mono focus:border-blue-500 outline-none"
                            />
                            <QuickEdit
                              value={field.length}
                              kind="text"
                              mono
                              fallback={currentConfig.defaultLength}
                              label={`${t('tableFields.length')} · ${field.name || '—'}`}
                              placeholder={currentConfig.defaultLength}
                              onSave={value => {
                                const newFields = [...fields];
                                newFields[index].length = String(value);
                                setFields(newFields);
                              }}
                            />
                          </div>
                        </td>

                        {/* Null */}
                        <td className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <input
                              type="checkbox"
                              checked={field.isNull}
                              disabled={field.isPk}
                              onChange={(e) => {
                                const newFields = [...fields];
                                newFields[index].isNull = e.target.checked;
                                setFields(newFields);
                              }}
                              className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                              title={field.isPk ? "Первичный ключ не может быть NULL" : "Разрешить NULL"}
                            />
                            <QuickEdit
                              value={field.isNull}
                              kind="boolean"
                              disabled={field.isPk}
                              label={`${t('tableFields.null')} · ${field.name || '—'}`}
                              onSave={value => {
                                const newFields = [...fields];
                                newFields[index].isNull = Boolean(value);
                                setFields(newFields);
                              }}
                            />
                          </div>
                        </td>

                         <td className="px-2 py-2">
                           <div className="flex items-center gap-1">
                             <input
                               type="text"
                               value={field.default}
                               placeholder="NULL"
                               onChange={(e) => {
                                 const newFields = [...fields];
                                 newFields[index].default = e.target.value;
                                 setFields(newFields);
                               }}
                               className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white font-mono focus:border-blue-500 outline-none"
                             />
                             <QuickEdit
                               value={field.default}
                               kind="multiline"
                               mono
                               placeholder="NULL"
                               label={`${t('tableFields.default')} · ${field.name || '—'}`}
                               hint={t('tableFields.defaultHint')}
                               onSave={value => {
                                 const newFields = [...fields];
                                 newFields[index].default = String(value);
                                 setFields(newFields);
                               }}
                             />
                           </div>
                         </td>

                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={field.autoInc}
                            disabled={!field.isPk}
                            onChange={(e) => {
                              const newFields = [...fields];
                              newFields[index].autoInc = e.target.checked;
                              setFields(newFields);
                            }}
                            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                            title={field.isPk ? t('createTable.autoIncLabel') : t('createTable.autoIncHint')}
                          />
                        </td>

                        {/* Remove Button */}
                        <td className="px-2 py-2 text-center">
                          <button 
                            type="button"
                            onClick={() => removeField(field.id)} 
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                            title={t('createTable.dropField')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-800/40 border-t border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2">
                <button 
                  type="button"
                  onClick={addField} 
                  className="text-xs font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5 hover:underline"
                >
                  <Plus className="w-4 h-4" />{t('createTable.addField')}</button>
                <span className="text-xs text-gray-400 break-all">
                  {t('createTable.selectedPk', { list: fields.filter(f => f.isPk).map(f => f.name || 'id').join(', ') || t('createTable.none') })}
                </span>
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">{t('createTable.engineNote')}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('createTable.tableComment')}</label>
              <input
                type="text"
                value={tableComment}
                onChange={(e) => setTableComment(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {(selectedDialect === 'mysql' || selectedDialect === 'mariadb') && (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('createTable.engine')}</label>
                  <select
                    value={tableEngine}
                    onChange={(e) => setTableEngine(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">—</option>
                    <option value="INNODB">InnoDB</option>
                    <option value="MYISAM">MyISAM</option>
                    <option value="MEMORY">Memory</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('createTable.charset')}</label>
                  <input
                    type="text"
                    value={tableCharset}
                    onChange={(e) => setTableCharset(e.target.value)}
                    placeholder="utf8mb4"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('createTable.collate')}</label>
                  <input
                    type="text"
                    value={tableCollate}
                    onChange={(e) => setTableCollate(e.target.value)}
                    placeholder="utf8mb4_unicode_ci"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </>
            )}
          </div>

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2 shrink-0 bg-gray-50 dark:bg-gray-900/50">
          <button 
            type="button" 
            onClick={onClose} 
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >{t('ui.cancel')}</button>
          <button 
            type="button" 
            onClick={handleCreate} 
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
          >
            <Check className="w-4 h-4 stroke-[2.5]" />{t('createTable.createTable')}</button>
        </div>
      </div>
    </div>
  );
}
