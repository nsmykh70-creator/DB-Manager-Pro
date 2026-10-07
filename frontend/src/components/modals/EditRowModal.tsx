import React, { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { X, Check } from 'lucide-react';

interface EditRowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: number, data: any) => void;
  row: any;
  columns: any[];
}

export function EditRowModal({ isOpen, onClose, onSave, row, columns }: EditRowModalProps) {
  const { t } = useLanguage();
  const [formData, setFormData] = useState<any>(row || {});

  // Update internal state when row prop changes
  React.useEffect(() => {
    setFormData(row || {});
  }, [row]);

  if (!isOpen || !row) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#1e2330] rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200">
        
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-gray-50 dark:bg-gray-900/50">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{(row as any)?.__isNew ? t('editRow.newRow') : t('editRow.editRow', { id: (row as any)?.id })}</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 min-w-0 overflow-y-auto overflow-x-hidden space-y-4">
          {columns.map(col => (
            <div key={col.name} className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {col.name} <span className="text-gray-400 text-xs font-normal">({col.type})</span>
              </label>
              <input
                type="text"
                value={formData[col.name] !== undefined ? formData[col.name] : ''}
                onChange={(e) => setFormData({ ...formData, [col.name]: e.target.value })}
                disabled={col.isPk} // Don't allow editing PKs in this simple demo
                className={`w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 transition-colors ${
                  col.isPk 
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 cursor-not-allowed' 
                    : 'bg-white dark:bg-[#151923] text-gray-900 dark:text-white'
                }`}
              />
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-gray-50 dark:bg-gray-900/50">
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{t('ui.cancel')}</button>
          <button onClick={() => onSave(row.id, formData)} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2">
            <Check className="w-4 h-4" />{t('ui.save')}</button>
        </div>
      </div>
    </div>
  );
}
