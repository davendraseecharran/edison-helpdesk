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
import { AiPanel } from '@/components/ai/AiPanel';
import { ScanPairingDialog } from '@/components/scan/ScanPairingDialog';
import type { QueueCounts } from '@/lib/data/tickets';
import { BottomTabs } from './BottomTabs';
import {
  LookupBar,
  OPEN_LOOKUP_EVENT,
  OPEN_SCANNER_EVENT,
  openLookup,
  readScanTarget,
} from './LookupBar';
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
  notifyInApp = true,
  children,
}: {
  counts: QueueCounts;
  unreadNotifications?: number;
  /** The account's `notify_in_app` setting. False hides the bell's count. */
  notifyInApp?: boolean;
  children: ReactNode;
}) {
  const { actor } = useRuntime();
  const items = useMemo(() => navItems(actor.role, counts), [actor.role, counts]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const showLookup = useCallback(() => setLookupOpen(true), []);
  const closeLookup = useCallback(() => setLookupOpen(false), []);
  // The pairing dialog for the palette's "Scan with your phone". A field's
  // own scan button mounts its own, because only the field knows where the
  // code goes; this one exists because the palette has no field to ask.
  const [scanOpen, setScanOpen] = useState(false);
  const closeScan = useCallback(() => setScanOpen(false), []);
  const onScanned = useCallback((code: string) => openLookup(code), []);

  useEffect(() => {
    function onScanner(event: Event) {
      // Only the lookup is answered here. A scanner event naming a field
      // would have nowhere to put the code, so it is left to the button
      // beside that field, which has the setter.
      if (readScanTarget(event) !== 'lookup') return;
      setScanOpen(true);
    }
    function onOpenLookup() {
      setLookupOpen(true);
    }
    window.addEventListener(OPEN_SCANNER_EVENT, onScanner);
    window.addEventListener(OPEN_LOOKUP_EVENT, onOpenLookup);
    return () => {
      window.removeEventListener(OPEN_SCANNER_EVENT, onScanner);
      window.removeEventListener(OPEN_LOOKUP_EVENT, onOpenLookup);
    };
  }, []);

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
      <TopBar
        unreadNotifications={unreadNotifications}
        notifyInApp={notifyInApp}
        onOpenLookup={showLookup}
      />
      <RailNav items={items} />
      <main className="main" id="main-content" tabIndex={-1}>
        <Flash />
        {children}
      </main>
      <BottomTabs items={items} onOpenLookup={showLookup} />
      <LookupBar open={lookupOpen} onClose={closeLookup} />
      {/* The phone as a barcode scanner, for the palette. The first code
          closes it and searches: the code IS the search, and two modal
          surfaces must not be open over each other. */}
      <ScanPairingDialog
        open={scanOpen}
        target="lookup"
        label="Search"
        onScan={onScanned}
        onClose={closeScan}
      />
      {/* The assistant. Owns its own opening: the toggle, Ctrl/Cmd+J and the
          `edison:open-assistant` event all land inside it. */}
      <AiPanel />
    </div>
  );
}
