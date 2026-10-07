import React, { useRef } from 'react';

/**
 * Поле поиска, защищённое от восстановления логина браузером.
 *
 * Зачем: при перезагрузке страницы Chrome подставляет сохранённый логин в
 * первое текстовое поле формы. На странице приложения это поле фильтра по
 * таблицам, и в нём появлялось «admin»: список выглядел пустым, хотя база
 * отдавала четыре таблицы.
 *
 * Ни `type="search"`, ни `autoComplete="off"`/`"new-password"`, ни `name`, ни
 * `readOnly` не помогают: браузер восстанавливает значение по позиции поля и
 * сообщает о нём обычным событием `input`. Различить подстановку от ввода
 * можно только по фокусу — в нефокусированное поле человек не печатает.
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type="search"
      value={value}
      onChange={(e) => {
        const el = e.currentTarget;
        if (document.activeElement !== el) {
          // Значение подставил браузер, а не пользователь: возвращаем своё.
          el.value = value;
          onChange(value);
          return;
        }
        onChange(el.value);
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      className={className}
    />
  );
}