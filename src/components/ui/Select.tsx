'use client';

/**
 * One choice from a short list.
 *
 * It replaced `<select>`, which is the one control a browser refuses to let a
 * product design: its popup is drawn by the operating system, so on three
 * machines it was three different widgets sitting in the middle of a screen
 * that had been measured to the pixel. Underneath is Radix's Select through
 * shadcn, which brings back everything the native control was worth keeping —
 * typeahead, Home and End, the roving focus, placement that avoids the edge of
 * the window, the pointer-versus-keyboard rule for what counts as a selection
 * — and lets the list be ours.
 *
 * The API is the native one's shape on purpose: an `id` the `Field` label
 * points at, a `value`, and a change handler that is handed the value rather
 * than an event, because no caller ever wanted the event.
 */

import type { ReactNode } from 'react';

import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './shadcn/select';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  /** Matches the `htmlFor` of the `Field` around it. */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Shown when `value` matches no option. A select always has a value here. */
  placeholder?: string;
  disabled?: boolean;
  /** For a select with no visible label. */
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  className?: string;
  /** Rendered after the options, for a "nothing here" note. */
  children?: ReactNode;
}

export function Select({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  children,
  ...aria
}: SelectProps) {
  return (
    <SelectRoot value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={className} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
        {children}
      </SelectContent>
    </SelectRoot>
  );
}
