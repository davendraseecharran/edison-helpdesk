'use client';

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import Link from 'next/link';
import { Icon, type LucideIcon } from './Icon';
import { useEscape, useOutsidePress } from './focus';

export interface MenuItem {
  key?: string;
  label: string;
  /** A link item navigates; otherwise `onSelect` runs. */
  href?: string;
  onSelect?: () => void;
  icon?: LucideIcon;
  /** Destructive actions sit in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | { separator: true };

export interface MenuProps {
  /** A button. It receives the aria attributes; presses are delegated. */
  trigger: ReactElement<ButtonHTMLAttributes<HTMLElement>>;
  items: MenuEntry[];
  /** Accessible name for the menu, for example "Ticket actions". */
  label: string;
  align?: 'start' | 'end';
}

function isSeparator(entry: MenuEntry): entry is { separator: true } {
  return 'separator' in entry;
}

/**
 * A dropdown menu with the full keyboard contract: Arrow keys move between
 * items, Home and End jump, Enter or Space activates, Escape or Tab leaves
 * and returns focus to the trigger, and a press outside closes it.
 */
export function Menu({ trigger, items, label, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // The anchor holds both the trigger and the menu, so one ref serves the
  // outside-press check and finds the trigger when focus must return to it.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const refs = useMemo(() => [anchorRef], []);

  const enabled = useMemo(
    () =>
      items
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !isSeparator(entry) && !entry.disabled)
        .map(({ index }) => index),
    [items],
  );

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) {
      anchorRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
    }
  }, []);

  useEscape(open, close);
  useOutsidePress(
    open,
    refs,
    useCallback(() => setOpen(false), []),
  );

  // Focus follows the active index while the menu is open.
  useEffect(() => {
    if (!open) return;
    const node = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.focus();
  }, [open, active]);

  function openAt(position: 'first' | 'last') {
    setActive(position === 'first' ? (enabled[0] ?? 0) : (enabled[enabled.length - 1] ?? 0));
    setOpen(true);
  }

  function move(direction: 1 | -1) {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = enabled[(at + direction + enabled.length) % enabled.length];
    setActive(next);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(enabled[0] ?? 0);
        break;
      case 'End':
        event.preventDefault();
        setActive(enabled[enabled.length - 1] ?? 0);
        break;
      case 'Tab':
        // Let focus continue past the trigger in document order.
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLSpanElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt('last');
    }
  }

  // Only attributes are cloned onto the trigger; its events are delegated
  // from the wrapper, so the caller's own handlers run untouched.
  const button = cloneElement(trigger, {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  });

  return (
    <span className="menu-anchor" ref={anchorRef}>
      <span
        className="menu-trigger"
        onClick={() => (open ? close() : openAt('first'))}
        onKeyDown={onTriggerKeyDown}
      >
        {button}
      </span>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`menu menu-${align}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((entry, index) => {
            if (isSeparator(entry)) {
              return <div key={`sep-${index}`} role="separator" className="menu-separator" />;
            }
            const className = ['menu-item', entry.danger ? 'menu-item-danger' : '']
              .join(' ')
              .trim();
            const content = (
              <>
                {entry.icon ? <Icon icon={entry.icon} size={16} /> : null}
                <span>{entry.label}</span>
              </>
            );
            const shared = {
              role: 'menuitem' as const,
              className,
              'data-index': index,
              tabIndex: index === active ? 0 : -1,
              'aria-disabled': entry.disabled || undefined,
              onMouseEnter: () => {
                if (!entry.disabled) setActive(index);
              },
            };
            if (entry.href && !entry.disabled) {
              return (
                <Link
                  key={entry.key ?? entry.href}
                  href={entry.href}
                  {...shared}
                  onClick={() => close(false)}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={entry.key ?? entry.label}
                type="button"
                {...shared}
                disabled={entry.disabled}
                onClick={() => {
                  close();
                  entry.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
