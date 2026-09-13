'use client';

/**
 * Application chrome for authenticated users.
 *
 * Top bar with the lookup, a left rail from 720px up, bottom tabs below that,
 * and the main region in between. Only ever rendered for a verified, active
 * account; the only identity control is a real sign-out.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { Flash } from '@/components/Primitives';
import { Sheet } from '@/components/ui/Sheet';
import type { QueueCounts } from '@/lib/data/tickets';
import { BottomTabs } from './BottomTabs';
import { LookupBar } from './LookupBar';
import { navItems, RailNav } from './RailNav';
import { TopBar } from './TopBar';

export function AppShell({
  counts,
  unreadNotifications = 0,
  children,
}: {
  counts: QueueCounts;
  unreadNotifications?: number;
  children: ReactNode;
}) {
  const { actor } = useRuntime();
  const admin = actor.role === 'admin';
  const items = useMemo(() => navItems(actor.role, counts), [actor.role, counts]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const openLookup = useCallback(() => setLookupOpen(true), []);
  const closeLookup = useCallback(() => setLookupOpen(false), []);

  // Cmd/Ctrl+K: focus the top-bar field where it is visible, otherwise open
  // the lookup sheet. The command palette will take this shortcut over.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      const input = document.querySelector<HTMLInputElement>('[data-lookup-input="bar"]');
      if (input && input.offsetParent !== null) {
        input.focus();
        input.select();
      } else {
        setLookupOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <TopBar unreadNotifications={unreadNotifications} />
      <RailNav items={items} />
      <main className="main" id="main-content" tabIndex={-1}>
        <Flash />
        {children}
      </main>
      <BottomTabs items={items} onOpenLookup={openLookup} />
      <Sheet side="bottom" title="Lookup" open={lookupOpen} onClose={closeLookup}>
        <LookupBar admin={admin} variant="sheet" autoFocus onNavigate={closeLookup} />
      </Sheet>
    </div>
  );
}
