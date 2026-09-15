'use client';

import type { ButtonHTMLAttributes, ReactElement } from 'react';
import Link from 'next/link';

import { Icon, type LucideIcon } from './Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu';

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
 * A dropdown menu.
 *
 * Radix underneath, through shadcn. The keyboard contract this used to
 * hand-roll is the part nobody should be hand-rolling: arrows, Home and End,
 * Enter and Space, Escape and Tab back to the trigger, an outside press. What
 * it did not have, and now does, is typeahead — start typing and the menu
 * jumps to the item, which is how every menu on the machine already behaves —
 * placement that flips or shifts rather than being clipped by the window, and
 * a `transform-origin` that follows the placement, so the surface grows out of
 * the corner nearest its trigger even when it had to open upwards.
 *
 * The props are unchanged, because the product's opinion is what a menu
 * contains and how it looks, and neither of those came from the library.
 */
export function Menu({ trigger, items, label, align = 'end' }: MenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={label}>
        {items.map((entry, index) => {
          if (isSeparator(entry)) return <DropdownMenuSeparator key={`sep-${index}`} />;
          const content = (
            <>
              {entry.icon ? <Icon icon={entry.icon} size={16} weight="medium" /> : null}
              <span>{entry.label}</span>
            </>
          );
          if (entry.href && !entry.disabled) {
            return (
              <DropdownMenuItem key={entry.key ?? entry.href} asChild>
                <Link href={entry.href}>{content}</Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem
              key={entry.key ?? entry.label}
              disabled={entry.disabled}
              variant={entry.danger ? 'destructive' : 'default'}
              onSelect={entry.onSelect}
            >
              {content}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
