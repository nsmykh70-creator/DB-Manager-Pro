import React from 'react';
import EditorDefault from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-sql';
// @ts-ignore
import 'prismjs/themes/prism-tomorrow.css'; // Dark theme for Prism

// Handle Vite's CommonJS / ESM interop for default exports
const Editor = (EditorDefault as any).default || EditorDefault;

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  minHeight?: string;
}

export function SqlEditor({ value, onChange, className = '', minHeight = '200px' }: SqlEditorProps) {
  // Defensive check for Prism language
  const highlightCode = (code: string) => {
    try {
      if (!Prism.languages || !Prism.languages.sql) {
        return code; // Fallback to raw text if grammar isn't loaded
      }
      return Prism.highlight(code, Prism.languages.sql, 'sql');
    } catch (e) {
      console.error('Prism highlighting error:', e);
      return code;
    }
  };

  return (
    <div className={`relative overflow-auto custom-scrollbar bg-[#1d1f21] text-gray-200 rounded-md ${className}`} style={{ minHeight }}>
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlightCode}
        padding={16}
        style={{
          fontFamily: '"Fira Code", "JetBrains Mono", monospace',
          fontSize: 14,
          minHeight: '100%',
        }}
        textareaClassName="focus:outline-none"
      />
    </div>
  );
}

