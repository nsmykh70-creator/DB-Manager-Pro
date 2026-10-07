import React, { useState, useEffect } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { X, Check, FileType, Key, Database, AlertCircle } from 'lucide-react';
import { SupportedDbDialect, DB_DIALECTS, detectDatabaseType } from '../../dbDialects';

interface EditColumnModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (updatedColumn: any) => void;
  column: any;
  activeDb?: string;
  defaultDialect?: SupportedDbDialect;
  dialectLocked?: boolean;
}

export function EditColumnModal({ 
  isOpen, 
  onClose, 
  onSave, 
  column, 
  activeDb = 'testdb',
  defaultDialect,
  dialectLocked = false
}: EditColumnModalProps) {
  const { t } = useLanguage();
  const detected = defaultDialect || detectDatabaseType(activeDb);
  const [selectedDialect, setSelectedDialect] = useState<SupportedDbDialect>(detected);
  const [formData, setFormData] = useState<any>({
    name: '',
    type: 'VARCHAR',
    length: '255',
    isNull: 'NO',
    default: '',
    extra: '-',
    isPk: false
  });

  useEffect(() => {
    if (column) {
      const isPk = Boolean(
        column.isPk || 
        column.extra?.includes('PRIMARY KEY') || 
        column.extra?.includes('AUTO_INCREMENT') || 
        column.extra === '_id' ||
        column.name === 'id' && column.extra !== '-'
      );

      let cleanExtra = column.extra || '-';
      if (cleanExtra === 'PRIMARY KEY' && !cleanExtra.includes('AUTO_INCREMENT')) {
        cleanExtra = '-';
      }

      setFormData({
        ...column,
        // '-' — служебная заглушка нормализатора колонок (TableView.tsx:80-82)
        // для «значения нет». В поле ввода она занимала то же место, что и
        // подсказка, и placeholder становился не виден: казалось, что поле
        // заполнено. Показываем пустое поле — с подсказкой внутри.
        length: column.length === '-' ? '' : column.length,
        default: column.default === '-' ? '' : column.default,
        type: column.type === '-' ? '' : column.type,
        extra: cleanExtra,
        isPk: isPk,
        isNull: isPk ? 'NO' : (column.isNull || 'NO')
      });

      // Update dialect if not explicitly changed
      if (defaultDialect) {
        setSelectedDialect(defaultDialect);
      } else {
        setSelectedDialect(detectDatabaseType(activeDb));
      }
    }
  }, [column, activeDb, defaultDialect]);

  if (!isOpen || !column) return null;

  const currentConfig = DB_DIALECTS[selectedDialect] || DB_DIALECTS.mysql;

  const handleDialectChange = (newDialect: SupportedDbDialect) => {
    setSelectedDialect(newDialect);
    const cfg = DB_DIALECTS[newDialect];
    // If the current type is not supported in the new dialect, switch to default
    if (!cfg.types.includes(formData.type)) {
      setFormData((prev: any) => ({
        ...prev,
        type: cfg.defaultType,
        length: cfg.defaultLength,
        extra: prev.isPk ? cfg.pkExtraDefault : '-'
      }));
    }
  };

  const handlePkToggle = () => {
    const nextPk = !formData.isPk;
    setFormData((prev: any) => {
      let updatedExtra = prev.extra;
      if (nextPk) {
        // If enabling PK and extra is currently empty or '-', suggest the DB's default PK extra
        if (updatedExtra === '-' || !updatedExtra) {
          updatedExtra = currentConfig.pkExtraDefault;
        }
      } else {
        // If disabling PK and extra was the default PK extra, reset to '-'
        if (updatedExtra === currentConfig.pkExtraDefault) {
          updatedExtra = '-';
        }
      }
      return {
        ...prev,
        isPk: nextPk,
        isNull: nextPk ? 'NO' : prev.isNull, // PK is strictly NOT NULL in relational DBs
        extra: updatedExtra
      };
    });
  };

  const handleTypeChange = (newType: string) => {
    setFormData((prev: any) => {
      let length = prev.length;
      if (newType === 'VARCHAR' || newType === 'varchar') {
        length = length || '255';
      } else if (newType === 'INT' || newType === 'integer') {
        length = length || '11';
      } else if (newType === 'TEXT' || newType === 'text' || newType === 'JSON' || newType === 'json' || newType === 'jsonb' || newType === 'UUID' || newType === 'uuid' || newType === 'BOOLEAN' || newType === 'boolean') {
        length = '';
      }
      return { ...prev, type: newType, length };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    // Пустое поле возвращаем заглушкой '-': её ждёт buildColumnDef, а пустая
    // строка выглядела бы как «пользователь стёр значение», и сохранение без
    // правок лишний раз сбрасывало бы DEFAULT у колонки без него.
    onSave({
      ...formData,
      name: formData.name.trim(),
      length: formData.length === '' ? '-' : formData.length,
      default: formData.default === '' ? '-' : formData.default,
      extra: formData.extra || '-'
    });
  };

  // Generate preview of column definition
  const generatePreview = () => {
    const name = formData.name || 'column_name';
    const type = formData.type || currentConfig.defaultType;
    // '-' — это заглушка «длины нет», которую кладёт нормализатор колонок
    // (TableView.tsx:61). Раньше она попадала в скобки, и предпросмотр показывал
    // невалидное `timestamp(-)`, хотя запрос уходил корректный: buildColumnDef
    // эту заглушку отфильтровывает. Предпросмотр и запрос должны считаться
    // одинаково, иначе он пугает пользователя несуществующей ошибкой.
    const rawLength = String(formData.length ?? '').trim();
    const hasLength = rawLength !== '' && rawLength !== '-';
    const len = hasLength ? `(${rawLength})` : '';
    const rawDefault = String(formData.default ?? '').trim();
    const notNull = formData.isNull === 'NO' ? 'NOT NULL' : 'NULL';
    const pk = formData.isPk ? ' PRIMARY KEY' : '';
    // Отсекаем только заглушку '-', ровно как buildColumnDef. Слово NULL здесь
    // не трогаем: его вводят осознанно (placeholder предлагает «NULL,
    // CURRENT_TIMESTAMP, 0, ''»), и запрос уходит с DEFAULT NULL как есть.
    const hasDefault = rawDefault !== '' && rawDefault !== '-';
    const def = hasDefault ? ` DEFAULT ${rawDefault}` : '';

    if (selectedDialect === 'mongodb') {
      return `${name}: ${type} ${formData.isPk ? '[PRIMARY _id]' : ''}`;
    }

    if (selectedDialect === 'postgresql') {
      return `"${name}" ${type}${len} ${notNull}${def}${pk}`;
    }

    return `\`${name}\` ${type}${len} ${notNull}${def}${pk}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold">
              <FileType className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                {column?.isNew ? t('editColumn.addNewField') : `${t('editColumn.editTitle')}: ${column?.name || ''}`}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('editColumn.schemaHint')}</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dialect Selector Banner */}
        <div className="px-6 py-2.5 bg-gray-100/70 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 font-medium">
            <Database className="w-3.5 h-3.5 text-blue-500" />
            <span>{t('editColumn.dialect')}: {currentConfig.name}</span>
          </div>
          {/* Полоса диалектов переносится, а не прокручивается: на узком окне
            прокрутка внутри шапки выглядела как обрезанный ряд кнопок. */}
          {!dialectLocked && <div className="flex flex-wrap items-center gap-1 py-0.5 min-w-0">
            {(Object.keys(DB_DIALECTS) as SupportedDbDialect[]).map((dialectKey) => {
              const d = DB_DIALECTS[dialectKey];
              const isActive = selectedDialect === dialectKey;
              return <button type="button" key={dialectKey} onClick={() => handleDialectChange(dialectKey)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${isActive ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-500' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>{d.name}</button>;
            })}
          </div>}
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto overflow-x-hidden flex-1 min-w-0">
          
          {/* Field Name & Primary Key Toggle */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-7 space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider flex items-center gap-1">{t('editColumn.fieldName')}<span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                placeholder={t('editColumn.nameHint')}
                autoFocus
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-mono"
              />
            </div>

            {/* Primary Key Checkbox / Button */}
            <div className="md:col-span-5">
              <button
                type="button"
                onClick={handlePkToggle}
                className={`w-full py-2 px-3 rounded-lg border text-sm font-semibold flex items-center justify-between transition-all ${
                  formData.isPk
                    ? 'bg-amber-500/10 dark:bg-amber-950/30 border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 shadow-sm'
                    : 'bg-gray-50 dark:bg-gray-800/40 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`p-1 rounded ${formData.isPk ? 'bg-amber-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                    <Key className="w-3.5 h-3.5 stroke-[2.5]" />
                  </div>
                  <span>Primary Key (PK)</span>
                </div>
                <div className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                  formData.isPk ? 'bg-amber-500 border-amber-600 text-white' : 'border-gray-400 dark:border-gray-600'
                }`}>
                  {formData.isPk && <Check className="w-3 h-3 stroke-[3]" />}
                </div>
              </button>
            </div>
          </div>

          {/* Type & Length / Values */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-7 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
                  {t('editColumn.dataType')} ({currentConfig.name})
                </label>
                <span className="text-[11px] text-gray-400">
                  {currentConfig.types.length} {t('editColumn.typesCount')}
                </span>
              </div>
              <select
                value={formData.type || currentConfig.defaultType}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              >
                {currentConfig.types.map((typeOption) => (
                  <option key={typeOption} value={typeOption}>
                    {typeOption}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-5 space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('editColumn.lengthValues')}</label>
              <input
                type="text"
                value={formData.length || ''}
                onChange={(e) => setFormData({ ...formData, length: e.target.value })}
                placeholder={t('editColumn.valuesHint')}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>
          </div>

          {/* NULL & Default */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-5 space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
                NULL ({t('editColumn.nullability')})
              </label>
              <select
                value={formData.isPk ? 'NO' : (formData.isNull || 'NO')}
                disabled={formData.isPk}
                onChange={(e) => setFormData({ ...formData, isNull: e.target.value })}
                className={`w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
                  formData.isPk 
                    ? 'bg-gray-100 dark:bg-gray-800/80 text-gray-400 cursor-not-allowed'
                    : 'bg-white dark:bg-[#151923] text-gray-900 dark:text-white'
                }`}
              >
                <option value="NO">{t('editColumn.notNull')}</option>
                <option value="YES">{t('editColumn.null')}</option>
              </select>
              {formData.isPk && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">{t('editColumn.pkNoNull')}</p>
              )}
            </div>

            <div className="sm:col-span-7 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
                  {t('editColumn.default')}
                </label>
                <div className="flex items-center gap-1">
                  {currentConfig.defaultOptions.filter(d => d).slice(0, 3).map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      onClick={() => setFormData({ ...formData, default: preset })}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono transition-colors"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="text"
                value={formData.default || ''}
                onChange={(e) => setFormData({ ...formData, default: e.target.value })}
                placeholder={t('editColumn.defaultHint')}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#151923] text-gray-900 dark:text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>
          </div>

          {/* SQL Preview Box */}
          <div className="rounded-lg bg-gray-900 text-gray-200 p-3 font-mono text-xs border border-gray-800 shadow-inner">
            <div className="text-[10px] text-gray-400 mb-1 flex items-center justify-between uppercase tracking-wider font-sans">
              <span>{t('editColumn.preview')} ({currentConfig.name}):</span>
              {formData.isPk && (
                <span className="text-amber-400 flex items-center gap-1 font-semibold">
                  <Key className="w-3 h-3" /> {t('editColumn.pkActive')}
                </span>
              )}
            </div>
            <div className="text-emerald-400 select-all overflow-x-auto whitespace-pre">
              {generatePreview()}
            </div>
            {/* Атрибут «Дополнительно» приходит с сервера и только показывается:
                произвольные выражения СУБД (COLLATE, GENERATED, INVISIBLE) API
                конструктора не принимает, поэтому редактировать его здесь нельзя. */}
            {formData.extra && formData.extra !== '-' && (
              <div className="text-gray-400 mt-2 pt-2 border-t border-gray-800">
                {t('editColumn.extraFromServer')}: <span className="text-gray-300">{formData.extra}</span>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="pt-2 flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-800">
            <button 
              type="button" 
              onClick={onClose} 
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >{t('ui.cancel')}</button>
            <button 
              type="submit" 
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-sm font-medium transition-all shadow-sm flex items-center gap-2 hover:scale-[1.01]"
            >
              <Check className="w-4 h-4 stroke-[2.5]" />{t('ui.saveChanges')}</button>
          </div>
        </form>

      </div>
    </div>
  );
}
