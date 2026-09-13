'use client';

import type { KeyboardEvent } from 'react';
import { Icon, type LucideIcon } from './Icon';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<Value extends string> {
  /** Accessible name for the group. */
  label: string;
  value: Value;
  options: SegmentedOption<Value>[];
  onChange: (value: Value) => void;
  size?: 'sm' | 'md';
}

/**
 * A row of exclusive choices, for two to four options that all fit on a line.
 *
 * Behaves as a radio group: one tab stop, Arrow keys move and select, and the
 * chosen option is marked with `aria-checked`, so it is never colour alone.
 */
export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
}: SegmentedControlProps<Value>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = options.findIndex((option) => option.value === value);
    let next = at;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (at - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[next];
    onChange(option.value);
    const target = event.currentTarget.querySelector<HTMLElement>(
      `[data-value="${option.value}"]`,
    );
    target?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={size === 'sm' ? 'segmented segmented-sm' : 'segmented'}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-value={option.value}
            className="segmented-option"
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <Icon icon={option.icon} size={size === 'sm' ? 14 : 16} /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
