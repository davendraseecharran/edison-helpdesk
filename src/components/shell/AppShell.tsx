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
import type { QueueCounts } from '@/lib/data/tickets';
import { BottomTabs } from './BottomTabs';
import { LookupBar } from './LookupBar';
import { navItems, RailNav } from './RailNav';
import { TopBar } from './TopBar';

/** Whether a keystroke would type into `target`: a field, or anything editable. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

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
  const items = useMemo(() => navItems(actor.role, counts), [actor.role, counts]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const openLookup = useCallback(() => setLookupOpen(true), []);
  const closeLookup = useCallback(() => setLookupOpen(false), []);

  // Cmd/Ctrl+K toggles the palette from anywhere; `/` opens it when nothing
  // editable has focus, so the slash never lands in a field. Neither opens it
  // over another modal surface: that one owns the keyboard.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.isComposing) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (lookupOpen) {
          event.preventDefault();
          setLookupOpen(false);
          return;
        }
        if (modalOpen()) return;
        event.preventDefault();
        setLookupOpen(true);
        return;
      }
      if (event.key === '/' && !modifier) {
        if (lookupOpen || modalOpen() || isEditable(event.target)) return;
        event.preventDefault();
        setLookupOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lookupOpen]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <TopBar unreadNotifications={unreadNotifications} onOpenLookup={openLookup} />
      <RailNav items={items} />
      <main className="main" id="main-content" tabIndex={-1}>
        <Flash />
        {children}
      </main>
      <BottomTabs items={items} onOpenLookup={openLookup} />
      <LookupBar open={lookupOpen} onClose={closeLookup} />
    </div>
  );
}
