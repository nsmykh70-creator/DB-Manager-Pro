import React from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { ToastMessage } from '../types';

interface ToastContainerProps {
  toasts: ToastMessage[];
  removeToast: (id: number) => void;
}

export function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div 
          key={toast.id} 
          className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border animate-in slide-in-from-right-8 fade-in duration-300 ${
            toast.type === 'success' ? 'bg-green-50 dark:bg-green-900/40 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300' :
            toast.type === 'error' ? 'bg-red-50 dark:bg-red-900/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300' :
            'bg-blue-50 dark:bg-blue-900/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5" />}
          {toast.type === 'info' && <Info className="w-5 h-5" />}
          
          <span className="text-sm font-medium">{toast.message}</span>
          
          <button 
            onClick={() => removeToast(toast.id)}
            className="ml-4 p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded-md transition-colors"
          >
            <X className="w-4 h-4 opacity-70 hover:opacity-100" />
          </button>
        </div>
      ))}
    </div>
  );
}
