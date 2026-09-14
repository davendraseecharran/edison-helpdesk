'use client';

/**
 * The command palette: the one bold element of the interface.
 *
 * `Ctrl/Cmd+K` anywhere, `/` outside a field, the top-bar field or the phone
 * cluster's Search item opens it. Typing an OSIS, a serial, a name, a ticket
 * number or a command shows tickets, people, devices and actions in one list,
 * keyboard first. Built on `cmdk`, which owns the combobox and listbox
 * semantics, arrow keys and Enter; this file owns what is in the list, the
 * surface it sits on, and what selecting something does.
 *
 * Desktop: a dialog hung at 15vh, 640px wide, scaling in. Phone: a
 * full-height sheet from the bottom. Both carry the opening beam for two
 * rotations, then it is gone. Reduced motion removes the beam and the reveal.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { ThinkingOrb } from 'thinking-orbs';
import { Hand, Plus, Search, Settings, Smartphone, Sparkles, SunMoon, X } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { OpenBeam } from '@/components/ui/OpenBeam';
import { useBodyScrollLock, useEscape, useFocusTrap } from '@/components/ui/focus';
import { useApplePlatform, usePhone } from '@/components/ui/media';
import { AnimatePresence, SpringSurface } from '@/components/ui/Motion';
import { claimTicketAction } from '@/lib/data/actions';
import { matchesQuery, type RecentItem, type SearchHit } from '@/lib/data/search';
import type { QueueCounts } from '@/lib/data/tickets';
import type { ThemePreference } from './theme-script';
import {
  ActionItem,
  actionValue,
  HitGroups,
  hitValue,
  RecentRow,
  type LookupAction,
} from './LookupResults';
import { navItems } from './RailNav';
import { ScanButton } from './ScanButton';
import { useTheme, useThemeChoice } from './ThemeProvider';
import { openAssistant } from './TopBar';
import { useLookup } from './useLookup';

/** Dispatched on `window` to open the phone-scanner pairing dialog. `detail.target` names who wants the code. */
export const OPEN_SCANNER_EVENT = 'edison:open-scanner';

/** Who the scanner event says wants the code, or null when it did not say. */
export function readScanTarget(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== 'object') return null;
  const target = (detail as Record<string, unknown>).target;
  return typeof target === 'string' ? target : null;
}

/**
 * Dispatched on `window` to open the palette with something already typed in
 * it. `detail.query` is the text.
 *
 * It exists for one caller: a barcode arriving from a paired phone, which is
 * a search the technician has already made with their hands. Two listeners
 * answer it and they do different halves of the job — `AppShell` opens the
 * palette, because it owns whether the palette is open, and `LookupBar` holds
 * the text, because the palette's state is discarded on every close. Both fire
 * in the same dispatch, so the palette mounts with the code already in it.
 */
export const OPEN_LOOKUP_EVENT = 'edison:open-lookup';

/** The text an `edison:open-lookup` event carries, or null if it carried none. */
export function readLookupQuery(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== 'object') return null;
  const query = (detail as Record<string, unknown>).query;
  return typeof query === 'string' && query.trim() !== '' ? query : null;
}

/** Open the palette with `query` already in the field. */
export function openLookup(query: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_LOOKUP_EVENT, { detail: { query } }));
}

/** One request to seed the palette. The counter makes a repeat a new request. */
interface LookupSeed {
  query: string;
  at: number;
}

/** The palette's actions do not show counts, so the navigation needs none. */
const NO_COUNTS: QueueCounts = {
  openQueue: 0,
  myTickets: 0,
  collaborating: 0,
  closed: 0,
  all: 0,
};

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};

const THEME_LABEL: Record<ThemePreference, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * The top-bar field. A real button dressed as an input: pressing it opens
 * the palette, where the typing happens, and focus comes back here on close.
 */
export function LookupTrigger({ onOpen }: { onOpen: () => void }) {
  const mac = useApplePlatform();
  return (
    <button
      type="button"
      className="lookup-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={onOpen}
    >
      <Icon icon={Search} size={18} />
      <span className="lookup-trigger-text">Search tickets, people, devices</span>
      <kbd className="kbd" aria-hidden="true">
        {mac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}

export interface LookupBarProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The portal and the presence boundary. The palette body is mounted only
 * while open, so every close discards its query, results and selection and
 * the next open starts clean; `AnimatePresence` keeps it mounted just long
 * enough to play the exit.
 */
export function LookupBar({ open, onClose }: LookupBarProps) {
  const phone = usePhone();
  // Held here rather than in `Palette`, which is mounted only while the
  // palette is open: a scan asks for the palette and its text in one event,
  // and the text has to survive until the palette exists to receive it.
  const [seed, setSeed] = useState<LookupSeed | null>(null);

  useEffect(() => {
    function onSeed(event: Event) {
      const query = readLookupQuery(event);
      if (query !== null) setSeed({ query, at: Date.now() });
    }
    window.addEventListener(OPEN_LOOKUP_EVENT, onSeed);
    return () => window.removeEventListener(OPEN_LOOKUP_EVENT, onSeed);
  }, []);

  // The portal exists only on the client, and only after hydration, so the
  // server and the hydrating render agree on rendering nothing here.
  const client = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  if (!client) return null;

  return createPortal(
    <AnimatePresence>
      {open ? <Palette key="lookup" phone={phone} seed={seed} onClose={onClose} /> : null}
    </AnimatePresence>,
    document.body,
  );
}

function Palette({
  phone,
  seed,
  onClose,
}: {
  phone: boolean;
  /** Text a scan asked for. A new `at` is a new request, even for the same code. */
  seed: LookupSeed | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { actor, run, notify } = useRuntime();
  const { resolved } = useTheme();
  // Saves the choice through the runtime, so the toast and the one-change-at-a-time guard apply.
  const { theme, choose } = useThemeChoice();
  const lookup = useLookup();
  const [scanOpen, setScanOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useFocusTrap(panelRef, true);
  useBodyScrollLock(true);
  // While the scan dialog is up, Escape belongs to it.
  useEscape(!scanOpen, onClose);

  const { remember, findTicket, setQuery } = lookup;

  // A scanned code is a search the technician has already made with their
  // hands, so it goes straight into the field. Keyed on the request rather
  // than the text, so scanning the same asset tag twice searches twice.
  const seedAt = seed?.at;
  const seedQuery = seed?.query;
  useEffect(() => {
    if (seedAt !== undefined && seedQuery !== undefined) setQuery(seedQuery);
  }, [seedAt, seedQuery, setQuery]);

  const openHit = useCallback(
    (hit: SearchHit) => {
      remember(hit);
      onClose();
      router.push(hit.href);
    },
    [remember, onClose, router],
  );

  const openRecent = useCallback(
    (item: RecentItem) => openHit({ ...item, subtitle: null, meta: null }),
    [openHit],
  );

  const claim = useCallback(
    async (number: string) => {
      onClose();
      const hit = await findTicket(number);
      if (!hit) {
        notify('error', `Ticket ${number} was not found. Check the number and try again.`);
        return;
      }
      const result = await run(`claim:${hit.id}`, () => claimTicketAction(hit.id));
      if (result.ok) router.push(hit.href);
    },
    [onClose, findTicket, notify, run, router],
  );

  const { term, searchable, ticketNumber } = lookup;

  const actions = useMemo<LookupAction[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };
    const list: LookupAction[] = [];

    if (ticketNumber) {
      list.push({
        id: 'claim',
        label: `Claim ${ticketNumber}`,
        icon: Hand,
        keywords: [],
        subtitle: 'Take ownership and open the ticket',
        always: true,
        run: () => claim(ticketNumber),
      });
    }

    list.push({
      id: 'new-ticket',
      label: 'New ticket',
      icon: Plus,
      keywords: ['create', 'intake', 'log'],
      run: go('/tickets/new'),
    });

    for (const item of navItems(actor.role, NO_COUNTS)) {
      list.push({
        id: `go:${item.href}`,
        label: `Go to ${item.label.toLowerCase()}`,
        icon: item.icon,
        keywords: ['page', 'open', item.label],
        run: go(item.href),
      });
    }
    list.push({
      id: 'go:/settings',
      label: 'Go to settings',
      icon: Settings,
      keywords: ['page', 'open', 'preferences', 'account'],
      run: go('/settings'),
    });

    const next = NEXT_THEME[theme];
    list.push({
      id: 'theme',
      label: 'Toggle theme',
      icon: SunMoon,
      keywords: ['dark', 'light', 'system', 'appearance', 'mode'],
      meta: `${THEME_LABEL[next]} next`,
      run: () => {
        onClose();
        choose(next);
      },
    });

    list.push({
      id: 'ask',
      label: 'Ask the assistant',
      icon: Sparkles,
      keywords: ['ai', 'help', 'question'],
      subtitle: term ? `“${term}”` : undefined,
      always: true,
      run: () => {
        onClose();
        openAssistant(term || undefined);
      },
    });

    list.push({
      id: 'scan-phone',
      label: 'Scan with your phone',
      icon: Smartphone,
      keywords: ['barcode', 'camera', 'qr', 'pair', 'scanner'],
      run: () => {
        onClose();
        window.dispatchEvent(new CustomEvent(OPEN_SCANNER_EVENT, { detail: { target: 'lookup' } }));
      },
    });

    return list;
  }, [ticketNumber, actor.role, theme, term, onClose, router, claim, choose]);

  const visibleActions = useMemo(
    () =>
      actions.filter(
        (action) => action.always || matchesQuery(action.label, action.keywords, term),
      ),
    [actions, term],
  );

  const showRecent = !searchable && lookup.recent.length > 0;

  // The list in the order it is rendered, so the first item is always the
  // one Enter opens: a record when there are records, otherwise an action.
  // cmdk keeps whatever was selected when items arrive, so the selection is
  // moved here each time the head of the list changes.
  const first = useMemo(() => {
    if (showRecent) return `recent:${hitValue(lookup.recent[0])}`;
    const { tickets, people, devices } = lookup.groups;
    const hit = tickets[0] ?? people[0] ?? devices[0];
    if (searchable && hit) return hitValue(hit);
    return visibleActions[0] ? actionValue(visibleActions[0]) : '';
  }, [showRecent, lookup.recent, lookup.groups, searchable, visibleActions]);

  const [selected, setSelected] = useState(first);
  const [selectedFor, setSelectedFor] = useState(first);
  if (selectedFor !== first) {
    setSelectedFor(first);
    setSelected(first);
  }

  // cmdk names the highlighted option on the input (`aria-activedescendant`)
  // only when it moved the selection itself; a selection set through the
  // `value` prop leaves it stale. Mirror the highlighted option after every
  // render so a screen reader always hears the row Enter would open.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const active = panelRef.current?.querySelector('[cmdk-item][data-selected="true"]');
    if (active?.id) input.setAttribute('aria-activedescendant', active.id);
    else input.removeAttribute('aria-activedescendant');
  });

  // "Nothing matches" is about records. It stays quiet while a typed command
  // matched, since that is exactly what the person wanted.
  const nothingMatches = lookup.empty && visibleActions.every((action) => action.always);

  return (
    <SpringSurface
      kind={phone ? 'sheet' : 'dialog'}
      side="bottom"
      panelRef={panelRef}
      panelClassName={
        phone
          ? 'overlay-panel sheet sheet-bottom palette palette-sheet'
          : 'overlay-panel dialog palette'
      }
      panelProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': titleId,
        tabIndex: -1,
      }}
      onBackdropPress={onClose}
    >
      <OpenBeam className="palette-frame">
        <h2 id={titleId} className="visually-hidden">
          Lookup
        </h2>
        <Command
          label="Lookup"
          className="palette-command"
          shouldFilter={false}
          loop
          vimBindings={false}
          value={selected}
          onValueChange={setSelected}
        >
          <div className="palette-input-row">
            <Icon icon={Search} size={18} className="palette-input-icon" />
            <Command.Input
              ref={inputRef}
              className="palette-input"
              value={lookup.query}
              onValueChange={setQuery}
              placeholder="Search tickets, people, devices"
              enterKeyHint="go"
              data-autofocus=""
            />
            <div className="palette-input-end">
              <span className="palette-orb">
                {lookup.loading ? (
                  <ThinkingOrb
                    state="searching"
                    size={20}
                    theme={resolved}
                    aria-label="Searching"
                  />
                ) : null}
              </span>
              <ScanButton onDetect={setQuery} onOpenChange={setScanOpen} />
              <Button
                variant="ghost"
                size="sm"
                icon={X}
                className="palette-close"
                aria-label="Close"
                onClick={onClose}
              />
            </div>
          </div>

          <Command.List className="palette-list" label="Results">
            {showRecent ? (
              <Command.Group heading="Recent">
                {lookup.recent.map((item) => (
                  <RecentRow key={`${item.kind}:${item.id}`} item={item} onSelect={openRecent} />
                ))}
              </Command.Group>
            ) : null}

            {searchable ? <HitGroups groups={lookup.groups} onSelect={openHit} /> : null}

            {nothingMatches ? (
              <p className="palette-empty" role="status">
                Nothing matches. Try an asset tag, OSIS or ticket number.
              </p>
            ) : null}

            {visibleActions.length > 0 ? (
              <Command.Group heading="Actions">
                {visibleActions.map((action) => (
                  <ActionItem key={action.id} action={action} />
                ))}
              </Command.Group>
            ) : null}
          </Command.List>

          <footer className="palette-foot" aria-hidden="true">
            <span className="palette-hint">
              <kbd className="kbd">↑</kbd>
              <kbd className="kbd">↓</kbd>
              move
            </span>
            <span className="palette-hint">
              <kbd className="kbd">↵</kbd>
              open
            </span>
            <span className="palette-hint">
              <kbd className="kbd">esc</kbd>
              close
            </span>
          </footer>
        </Command>
      </OpenBeam>
    </SpringSurface>
  );
}
