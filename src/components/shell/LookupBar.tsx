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
 * Desktop: a dialog hung at 15vh, 640px wide. Phone: a full-height sheet from
 * the bottom. Neither animates, and neither carries the opening beam any more.
 * This is the surface somebody reaches for dozens of times a day, and the one
 * rule about motion that does not bend is that a high-frequency interaction
 * gets instant feedback: after the tenth time, a scale and a rotating stroke
 * are not delight, they are the delay between asking for the palette and being
 * able to type into it. The beam still belongs to the assistant panel and to
 * an approval card, which are opened rarely and are worth announcing.
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
import {
  FileUp,
  Hand,
  Laptop,
  MessageCircle,
  Plus,
  Printer,
  QrCode,
  Search,
  Settings,
  SunMoon,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { OpenBeam } from '@/components/ui/OpenBeam';
import { useBodyScrollLock, useEscape, useFocusTrap } from '@/components/ui/focus';
import { useApplePlatform, usePhone } from '@/components/ui/media';
import { AnimatePresence, SpringSurface } from '@/components/ui/Motion';
import { claimTicketAction, joinTicketAction } from '@/lib/data/actions';
import { lookupDeviceCodeAction } from '@/lib/data/device-actions';
import { matchesQuery, type RecentItem, type SearchHit } from '@/lib/data/search';
import { presetActionLabel, presetHref, presetKeywords } from '@/lib/domain/ticket-presets';
import { useTicketPresets } from '@/lib/presets/store';
import { shortcutHref, shortcutKeywords, workflowHref, WORKFLOWS } from '@/lib/domain/workflows';
import { useWorkflowShortcuts } from '@/lib/workflows/store';
import { CHECK_ICON, WORKFLOW_ICONS } from '@/components/workflows/icons';
import { CHECK_WORKFLOW, SCANNED_CODE_EVENT } from '@/lib/domain/device-check';
import { targetKind } from '@/lib/lookup/recognise';
import { asksFirst, readAsk } from '@/lib/lookup/ask';
import { routeScannedCode } from '@/lib/scan/route';
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
import { canWorkTickets } from '@/lib/auth/roles';
import { navItems } from './RailNav';
import { ScanButton } from './ScanButton';
import { useTheme, useThemeChoice } from './ThemeProvider';
import { openAssistant } from './TopBar';
import { useLookup } from './useLookup';

/** Dispatched on `window` to open the phone-scanner pairing dialog. `detail.target` names who wants the code. */
export const OPEN_SCANNER_EVENT = 'edison:open-scanner';

/**
 * Open the phone-scanner pairing dialog the shell owns.
 *
 * The one in the shell is the one with nowhere in particular to put the code:
 * whatever is scanned is looked up and becomes a machine's page, or the
 * palette with the code already typed. A field that wants a code for itself
 * mounts its own dialog, because only that field knows where the code goes.
 */
export function openScanner(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SCANNER_EVENT, { detail: { target: 'lookup' } }));
}

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
 * It exists for one caller: a scanned barcode the inventory did not recognise,
 * which is a search the technician has already made with their hands (a code
 * it DID recognise never reaches here — it opens that machine instead). Two
 * listeners answer it and they do different halves of the job — `AppShell` opens the
 * palette, because it owns whether the palette is open, and `LookupBar` holds
 * the text, because the palette's state is discarded on every close. Both fire
 * in the same dispatch, so the palette mounts with the code already in it.
 */
export const OPEN_LOOKUP_EVENT = 'edison:open-lookup';

/** The text an `edison:open-lookup` event carries, or null if it carried none. */
function readLookupQuery(event: Event): string | null {
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
/** The heading every navigation row sits under, instead of in every label. */
const GO_TO = 'Go to';

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

  // A seed is a one-time request: once the palette has read it into the
  // query, it must not survive to the next open. `Palette` unmounts on every
  // close (that is what discards its query and selection), so without this
  // the next open would remount it, its effect would see the same `seed`
  // object it never got to clear, and a scan from an hour ago would search
  // again.
  const clearSeed = useCallback(() => setSeed(null), []);
  const handleClose = useCallback(() => {
    setSeed(null);
    onClose();
  }, [onClose]);

  if (!client) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <Palette
          key="lookup"
          phone={phone}
          seed={seed}
          onSeedUsed={clearSeed}
          onClose={handleClose}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function Palette({
  phone,
  seed,
  onSeedUsed,
  onClose,
}: {
  phone: boolean;
  /** Text a scan asked for. A new `at` is a new request, even for the same code. */
  seed: LookupSeed | null;
  /** Tells the seed's owner it has been read into the query, so it is not re-applied next open. */
  onSeedUsed: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { actor, run, notify } = useRuntime();
  const { resolved } = useTheme();
  // Saves the choice through the runtime, so the toast and the one-change-at-a-time guard apply.
  const { theme, choose } = useThemeChoice();
  const lookup = useLookup();
  /*
   * The desk's quick tickets, from the cache the top bar's menu fills. The
   * palette is mounted only while it is open, so asking for them here is
   * asking once when it opens rather than once per keystroke: the filtering
   * below is over a list that is already in memory.
   */
  const presets = useTicketPresets(canWorkTickets(actor.roles));
  const workflowShortcuts = useWorkflowShortcuts(canWorkTickets(actor.roles));
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
    if (seedAt !== undefined && seedQuery !== undefined) {
      setQuery(seedQuery);
      onSeedUsed();
    }
  }, [seedAt, seedQuery, setQuery, onSeedUsed]);

  const openHit = useCallback(
    (hit: SearchHit) => {
      remember(hit);
      onClose();
      router.push(hit.href);
    },
    [remember, onClose, router],
  );

  /*
   * The camera button, one step shorter.
   *
   * A code read off a machine is asked of the inventory before it is asked of
   * the search: an exact match on the inventory id, the asset tag or the
   * serial closes the palette and opens that machine, because the operator is
   * holding it and there is nothing left to choose. Anything else — a code no
   * machine answers to, or one two machines answer to, which the lookup
   * reports as none on purpose — goes into the field, which is where it used
   * to go every time.
   */
  const onScan = useCallback(
    (code: string) => {
      // Check a device reads codes itself; a camera scan from the palette
      // over it lands on its card rather than on another page.
      if (!window.dispatchEvent(new CustomEvent(SCANNED_CODE_EVENT, { detail: code, cancelable: true }))) {
        onClose();
        return;
      }
      void (async () => {
        const route = routeScannedCode(code, await lookupDeviceCodeAction(code));
        if (route.kind === 'device') {
          onClose();
          router.push(route.href);
        } else {
          setQuery(route.query);
        }
      })();
    },
    [onClose, router, setQuery],
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
      const result = await run(`claim:${hit.id}`, () => claimTicketAction(hit.id, number));
      if (result.ok) router.push(hit.href);
    },
    [onClose, findTicket, notify, run, router],
  );

  /*
   * Joining needs no lookup first: the ticket a colleague asked for help with
   * is usually one this account cannot see yet, which is the whole reason the
   * action exists. The number goes to the database, and the id comes back.
   */
  const join = useCallback(
    async (number: string) => {
      onClose();
      const result = await run(`join:${number}`, () => joinTicketAction(number));
      if (result.ok && result.id) router.push(`/tickets/${result.id}`);
    },
    [onClose, run, router],
  );

  const { term, searchable, ticketNumber } = lookup;

  /*
   * Whether what was typed is a question rather than a lookup.
   *
   * `found` is held true while a search is still in flight, so the ask row does
   * not jump to the top of a list that is about to arrive and then jump back
   * down again — the palette's first row is the row Enter opens, and it must
   * not move under a finger already on the way to the key.
   */
  const ask = useMemo(
    () => readAsk(lookup.query, !searchable || lookup.loading || lookup.hits.length > 0),
    [lookup.query, searchable, lookup.loading, lookup.hits.length],
  );

  const actions = useMemo<LookupAction[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };
    const list: LookupAction[] = [];

    if (ticketNumber && canWorkTickets(actor.roles)) {
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

    // Claiming and intake are ticket work. A skills officer has no queue, so
    // offering either would be an action that ends in a refusal.
    if (canWorkTickets(actor.roles)) {
      if (ticketNumber) {
        list.push({
          id: 'join',
          label: `Join ${ticketNumber}`,
          icon: UserPlus,
          keywords: [],
          subtitle: "Help on a colleague's ticket. They will know you joined.",
          always: true,
          run: () => join(ticketNumber),
        });
      }
      list.push({
        id: 'new-ticket',
        label: 'New ticket',
        icon: Plus,
        keywords: ['create', 'intake', 'log'],
        run: go('/tickets/new'),
      });
      // The desk's old sheet, into the Resolved list. Typed, not resting: it is
      // a few-times-a-year job, and "import" or "sheet" is what it is asked as.
      list.push({
        id: 'import-sheet',
        label: 'Import from a spreadsheet',
        icon: FileUp,
        keywords: ['import', 'sheet', 'spreadsheet', 'csv', 'google sheets', 'paste', 'resolved', 'backfill'],
        subtitle: 'Finished work, one resolved ticket a row',
        matchOnly: true,
        run: go('/resolved?import=1'),
      });

      // The calls that repeat all day, each one row. They sit under the empty
      // form rather than above it: the form is what somebody who typed "new"
      // meant, and a preset is what they meant when they typed its name.
      for (const preset of presets) {
        list.push({
          id: `preset:${preset.id}`,
          label: presetActionLabel(preset),
          icon: Zap,
          keywords: presetKeywords(preset),
          subtitle: preset.title,
          matchOnly: true,
          run: go(presetHref(preset.id)),
        });
      }
    }

    // The scan jobs, by the name somebody at a cart would type, and the
    // desk's saved runs of them. Typed, not resting: the rail says Workflows.
    if (canWorkTickets(actor.roles)) {
      // "Who has this?" is asked as often as any job, and changes nothing.
      list.push({
        id: 'workflow:check',
        label: CHECK_WORKFLOW.title,
        icon: CHECK_ICON,
        keywords: ['check', 'who has', 'holder', 'whose', 'scan', 'barcode', 'device', 'laptop', 'lookup'],
        subtitle: CHECK_WORKFLOW.description,
        matchOnly: true,
        run: go(CHECK_WORKFLOW.href),
      });
      list.push({
        id: 'labels',
        label: 'Print labels',
        icon: Printer,
        keywords: ['label', 'labels', 'print', 'sticker', 'asset tag', 'barcode', 'qr', 'avery', 'dymo', 'brother'],
        subtitle: 'Asset labels on Avery sheets, Dymo, Brother or a desk thermal',
        matchOnly: true,
        run: go('/devices/labels'),
      });
      for (const workflow of WORKFLOWS) {
        list.push({
          id: `workflow:${workflow.kind}`,
          label: workflow.title,
          icon: WORKFLOW_ICONS[workflow.kind],
          keywords: ['workflow', 'scan', 'barcode', 'cart', 'devices', 'laptops', workflow.slug.replace('-', ' ')],
          subtitle: workflow.description,
          matchOnly: true,
          run: go(workflowHref(workflow.kind)),
        });
      }
      for (const shortcut of workflowShortcuts) {
        list.push({
          id: `workflow-shortcut:${shortcut.id}`,
          label: shortcut.name,
          icon: WORKFLOW_ICONS[shortcut.kind],
          keywords: shortcutKeywords(shortcut),
          subtitle: 'Saved workflow run',
          matchOnly: true,
          run: go(shortcutHref(shortcut)),
        });
      }
    }

    // The screen's own name, under a "Go to" heading. Written out, every one
    // of these began with the same two words, and a dozen rows that share a
    // prefix are a dozen rows the eye has to read past.
    for (const item of navItems(actor.roles, NO_COUNTS)) {
      list.push({
        id: `go:${item.href}`,
        label: item.label,
        icon: item.icon,
        group: GO_TO,
        keywords: ['page', 'open', 'go to', item.label],
        run: go(item.href),
      });
    }
    // The list Today only shows the head of. Typed, not resting: the rail
    // already says Devices, and this is one view of that page.
    if (canWorkTickets(actor.roles)) {
      list.push({
        id: 'go:/devices/due-back',
        label: 'Devices due back',
        icon: Laptop,
        group: GO_TO,
        keywords: ['due', 'due back', 'overdue', 'return', 'returns', 'graduated', 'repair'],
        subtitle: 'Holders who left, repairs untouched for a fortnight',
        matchOnly: true,
        run: go('/devices/due-back'),
      });
    }

    list.push({
      id: 'go:/settings',
      label: 'Settings',
      icon: Settings,
      group: GO_TO,
      keywords: ['page', 'open', 'go to', 'preferences', 'account'],
      run: go('/settings'),
    });

    /*
     * The sections of the settings page, each reachable by what it is about.
     * Somebody who types "dark" or "chatgpt" is looking for the control, not
     * for the page it sits on, and the plain Settings row above would leave
     * them to scroll for it. `matchOnly`, so the resting palette does not grow
     * by six rows nobody asked for; the subtitle says where the row goes.
     */
    const sections: Array<{ id: string; label: string; keywords: string[]; offered?: boolean }> = [
      {
        id: 'profile',
        label: 'Profile',
        keywords: ['name', 'display name', 'account', 'email'],
      },
      {
        id: 'sign-in',
        label: 'Sign-in methods',
        keywords: ['google', 'password', 'login', 'link', 'sign in'],
      },
      {
        id: 'quick-tickets',
        label: 'Quick tickets',
        keywords: ['preset', 'presets', 'quick', 'manage'],
        // Presets are ticket work; the section is not on the page for a
        // skills officer, and a row that opens a page without it would be a
        // wrong turn.
        offered: canWorkTickets(actor.roles),
      },
      {
        id: 'appearance',
        label: 'Appearance',
        keywords: ['theme', 'dark', 'light', 'gmail', 'links'],
      },
      {
        id: 'assistant',
        label: 'Assistant',
        keywords: ['chatgpt', 'ai', 'connect', 'reasoning', 'notes', 'voice', 'speak'],
      },
      {
        id: 'notifications',
        label: 'Notifications',
        keywords: ['notify', 'alerts'],
      },
    ];
    for (const section of sections) {
      if (section.offered === false) continue;
      list.push({
        id: `go:/settings#${section.id}`,
        label: section.label,
        icon: Settings,
        group: GO_TO,
        // "settings" on its own lists every section, which is the page's
        // table of contents without opening the page.
        keywords: [...section.keywords, 'settings'],
        subtitle: 'Settings',
        matchOnly: true,
        run: go(`/settings#${section.id}`),
      });
    }

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

    /*
     * The assistant, reachable from the surface everybody already opens.
     *
     * The label carries the text rather than describing the action, because
     * what this row does is send THAT sentence — "Ask the assistant: who has
     * cart 3" is one read; "Ask the assistant" with the question underneath is
     * two. A forced `>` or `?` prefix is stripped before it is sent, so the
     * character that summoned the row never reaches the assistant.
     */
    const asked = ask.prompt;
    list.push({
      id: 'ask',
      label: asked === '' ? 'Ask the assistant' : `Ask the assistant: ${asked}`,
      icon: MessageCircle,
      keywords: ['ai', 'help', 'question', 'assistant'],
      subtitle:
        ask.rank === 'forced'
          ? undefined
          : ask.rank === 'likely'
            ? 'This reads like a question'
            : undefined,
      always: true,
      run: () => {
        onClose();
        openAssistant(asked || undefined);
      },
    });

    // Pairing a phone is a desktop's action: on a phone, the camera button in
    // this same field is the scanner.
    if (!phone) {
      list.push({
        id: 'scan-phone',
        label: 'Scan with your phone',
        // The same glyph the top bar uses. One action drawn two ways is two
        // actions as far as anybody looking is concerned.
        icon: QrCode,
        keywords: ['barcode', 'camera', 'qr', 'pair', 'scanner'],
        run: () => {
          onClose();
          openScanner();
        },
      });
    }

    return list;
  }, [ticketNumber, actor.roles, presets, workflowShortcuts, theme, ask, onClose, router, claim, join, choose, phone]);

  const visibleActions = useMemo(
    () =>
      actions.filter(
        (action) =>
          (action.always || matchesQuery(action.label, action.keywords, term)) &&
          !(action.matchOnly && term.trim() === ''),
      ),
    [actions, term],
  );

  // Two groups, in the order they are rendered: what you can do here, then
  // where you can go. `first` below walks the same order.
  const commands = useMemo(
    () =>
      visibleActions.filter(
        (action) => action.group !== GO_TO && !(asksFirst(ask) && action.id === 'ask'),
      ),
    [visibleActions, ask],
  );
  const destinations = useMemo(
    () => visibleActions.filter((action) => action.group === GO_TO),
    [visibleActions],
  );

  const showRecent = !searchable && lookup.recent.length > 0;

  /*
   * The ask, and where it sits.
   *
   * When the text reads as a question it is lifted out of the actions and
   * rendered above the records under its own heading, so it is the first row
   * and the one Enter opens. Otherwise it stays in Actions, at the bottom,
   * where it has always been. It is never in both places.
   */
  const askAction = useMemo(
    () => visibleActions.find((action) => action.id === 'ask') ?? null,
    [visibleActions],
  );
  const askLeads = asksFirst(ask) && askAction !== null;

  // The list in the order it is rendered, so the first item is always the
  // one Enter opens: a record when there are records, otherwise an action.
  // cmdk keeps whatever was selected when items arrive, so the selection is
  // moved here each time the head of the list changes.
  const first = useMemo(() => {
    // A question outranks every record: somebody who typed a sentence did not
    // type it hoping to find a ticket whose title contains it.
    if (askLeads && askAction) return actionValue(askAction);
    if (showRecent) return `recent:${hitValue(lookup.recent[0])}`;
    const { tickets, people, devices, groups, events, forms } = lookup.groups;
    /*
     * The row Enter opens.
     *
     * Normally the first record in rail order. But when the text was read as
     * an identifier, the record it names outranks everything: paste an asset
     * tag while a person of the same name happens to match and Enter still
     * goes to the machine. That is the whole point of recognising the paste —
     * one keystroke to the thing in your hand, with no arrow keys in between.
     */
    const named = targetKind(lookup.recognition.kind);
    const preferred =
      named === 'device' ? devices[0] : named === 'person' ? people[0] : named === 'ticket' ? tickets[0] : undefined;
    const hit =
      preferred ?? tickets[0] ?? people[0] ?? devices[0] ?? groups[0] ?? events[0] ?? forms[0];
    if (searchable && hit) return hitValue(hit);
    const head = commands[0] ?? destinations[0];
    return head ? actionValue(head) : '';
  }, [
    askLeads,
    askAction,
    showRecent,
    lookup.recent,
    lookup.groups,
    lookup.recognition,
    searchable,
    commands,
    destinations,
  ]);

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
      kind={phone ? 'sheet' : 'drop'}
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
      <OpenBeam className="palette-beam" once="palette">
      <div className="palette-frame">
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
              <ScanButton onDetect={onScan} onOpenChange={setScanOpen} />
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
            {askLeads && askAction ? (
              <Command.Group heading="Assistant">
                <ActionItem action={askAction} />
              </Command.Group>
            ) : null}

            {showRecent ? (
              <Command.Group heading="Recent">
                {lookup.recent.map((item) => (
                  <RecentRow key={`${item.kind}:${item.id}`} item={item} onSelect={openRecent} />
                ))}
              </Command.Group>
            ) : null}

            {searchable ? (
              <HitGroups groups={lookup.groups} recognition={lookup.recognition} onSelect={openHit} />
            ) : null}

            {nothingMatches ? (
              <p className="palette-empty" role="status">
                Nothing matches. Try an asset tag, OSIS or ticket number.
              </p>
            ) : null}

            {commands.length > 0 ? (
              <Command.Group heading="Actions">
                {commands.map((action) => (
                  <ActionItem key={action.id} action={action} />
                ))}
              </Command.Group>
            ) : null}

            {destinations.length > 0 ? (
              <Command.Group heading={GO_TO}>
                {destinations.map((action) => (
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
      </div>
      </OpenBeam>
    </SpringSurface>
  );
}
