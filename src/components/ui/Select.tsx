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
 * points at, a `value`, a `name` for a form that is read as `FormData`, and a
 * change handler that is handed the value rather than an event, because no
 * caller ever wanted the event.
 *
 * There is no `placeholder`. Every list here has an option that means "any" or
 * "none", so a select always has a value, and the empty string is mapped to a
 * real item rather than left as Radix's "nothing is chosen" — which is the
 * only state a placeholder is ever shown in.
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

/*
 * Radix refuses an empty string as an item's value: it reserves it for
 * "nothing is chosen". Several lists here genuinely have an empty option that
 * means something -- "Queue, unassigned", "Any status" -- so the empty string
 * is mapped to a private token on the way in and back on the way out. Callers
 * keep passing and receiving `''`, which is what they mean and what a form
 * expects.
 */
const EMPTY = '\u0000empty';

function toItem(value: string): string {
  return value === '' ? EMPTY : value;
}

function fromItem(value: string): string {
  return value === EMPTY ? '' : value;
}

export interface SelectProps {
  /** Matches the `htmlFor` of the `Field` around it. */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /**
   * The field name this select submits under, for a form that is read as
   * `FormData` rather than from state.
   *
   * It is our own hidden input rather than Radix's, because Radix would submit
   * the private token the empty option is mapped to; this submits what the
   * caller passed and what the option means.
   */
  name?: string;
  disabled?: boolean;
  /** For a select with no visible label. */
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  /** Marks this as the control the surface around it should focus on opening. */
  'data-autofocus'?: string;
  className?: string;
  /** Rendered after the options, for a "nothing here" note. */
  children?: ReactNode;
}

export function Select({
  id,
  value,
  onChange,
  options,
  name,
  disabled,
  className,
  children,
  ...aria
}: SelectProps) {
  return (
    <SelectRoot
      value={toItem(value)}
      onValueChange={(next) => onChange(fromItem(next))}
      disabled={disabled}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <SelectTrigger id={id} className={className} {...aria}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={toItem(option.value)} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
        {children}
      </SelectContent>
    </SelectRoot>
  );
}
