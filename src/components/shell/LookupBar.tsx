'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import { useApplePlatform } from '@/components/ui/media';

export interface LookupBarProps {
  /** Admins search across every ticket; technicians search the queue. */
  admin: boolean;
  /** `bar` sits in the top bar; `sheet` fills the phone lookup sheet. */
  variant?: 'bar' | 'sheet';
  /** Focus the field as soon as it appears (inside a sheet). */
  autoFocus?: boolean;
  /** Runs after a search is submitted, so a sheet can close itself. */
  onNavigate?: () => void;
}

/**
 * The lookup field, ticket-only for now.
 *
 * Submitting navigates to the ticket list with `?q=`; the command palette
 * that searches tickets, people and devices at once replaces this component
 * later. The shortcut hint reads the platform as an external store, so the
 * server render and the first client render always agree.
 */
export function LookupBar({ admin, variant = 'bar', autoFocus, onNavigate }: LookupBarProps) {
  const router = useRouter();
  const inputId = useId();
  const [text, setText] = useState('');
  const mac = useApplePlatform();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = text.trim();
    if (!q) return;
    router.push(`${admin ? '/all-tickets' : '/queue'}?q=${encodeURIComponent(q)}`);
    onNavigate?.();
  }

  return (
    <form
      role="search"
      className={variant === 'sheet' ? 'lookup lookup-sheet' : 'lookup'}
      onSubmit={onSubmit}
    >
      <label htmlFor={inputId} className="visually-hidden">
        Search tickets
      </label>
      <Icon icon={Search} size={18} className="lookup-icon" />
      <input
        id={inputId}
        type="search"
        className="lookup-input"
        placeholder="Search tickets"
        autoComplete="off"
        enterKeyHint="search"
        value={text}
        data-lookup-input={variant}
        data-autofocus={autoFocus ? '' : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      {variant === 'bar' ? (
        <kbd className="lookup-kbd" aria-hidden="true">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      ) : null}
    </form>
  );
}
