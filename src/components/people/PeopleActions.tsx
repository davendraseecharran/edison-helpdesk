'use client';

/**
 * Getting people out of the directory: into Gmail, onto the clipboard, into a
 * spreadsheet.
 *
 * One component for all three places it appears — the list header acting on the
 * whole filter, the bar for a ticked selection, and one person's own page —
 * because they are the same two controls with a different list behind them, and
 * two of them would drift apart by the second change.
 *
 * Two decisions are worth knowing about:
 *
 *   * THE LIST IS FETCHED LATE. The header's list is the whole filter, which is
 *     a second read of up to five hundred rows, and most visits to the
 *     directory are somebody looking somebody up. So `load` is called when a
 *     menu is first opened, never on render, and until it comes back the menu
 *     says how many people it is preparing.
 *   * THE GMAIL TAB IS OPENED IN THE PRESS. A tab opened after an await is a
 *     pop-up as far as the browser is concerned. So when the addresses are not
 *     in yet the tab is opened blank inside the click and pointed at Gmail a
 *     moment later, which is the one way to do this that works everywhere.
 *
 * Everything about formatting — which addresses are one address, what a blank
 * means, how many a link can carry — is in `@/lib/people/clipboard`, which is
 * pure and tested. This file is the controls and the state.
 */

import { useId, useRef, useState } from 'react';
import { ChevronDown, Copy, Download, Mail } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { updatePreferencesAction } from '@/lib/data/preferences-actions';
import {
  GMAIL_MODE_LABELS,
  GMAIL_MODES,
  isGmailMode,
  type GmailMode,
} from '@/lib/domain/preferences';
import {
  ADDRESSEE_CAP,
  clipboardFor,
  gmailLink,
  gmailTitle,
  hasStudents,
  identifierMenuLabel,
  type CopyKind,
  type PersonAddressee,
} from '@/lib/people/clipboard';

/**
 * Re-exported from the pure module that defines it, so that the component and
 * the shape it takes are imported from one place:
 * `import { PeopleActions, type PersonAddressee } from '.../PeopleActions'`.
 */
export type { PersonAddressee };

export interface PeopleActionsProps {
  /** Who this acts on. Empty and `load` given means "not fetched yet". */
  people: PersonAddressee[];
  /** What this set of people is, for the group's accessible name. */
  label?: string;
  /** How this account addresses a Gmail link. Their setting, not this screen's. */
  gmailMode?: GmailMode;
  /**
   * Fetch the people, the first time a menu is opened. For a list that is
   * filtered and paged by the database, where the rows on screen are not the
   * set somebody means.
   */
  load?: () => Promise<PersonAddressee[]>;
  /** How many `load` will bring back, for the line shown while it is working. */
  expected?: number;
  /** Which list this is, so the menu can name an identifier before it has one. */
  kind?: 'student' | 'staff';
  /** One person: an Email button and a Copy email button rather than menus. */
  single?: boolean;
  /** Where "Export CSV" goes, or null for somebody who may not export. */
  exportHref?: string | null;
  size?: 'sm' | 'md';
}

export function PeopleActions({
  people,
  label,
  gmailMode = 'cc',
  load,
  expected,
  kind,
  single = false,
  exportHref = null,
  size = 'md',
}: PeopleActionsProps) {
  const { notify } = useRuntime();
  const hintId = useId();
  const [mode, setMode] = useState<GmailMode>(gmailMode);
  const [fetched, setFetched] = useState<PersonAddressee[] | null>(null);
  const [loading, setLoading] = useState(false);
  // One fetch, however many menus are opened while it is in flight.
  const inflight = useRef<Promise<PersonAddressee[]> | null>(null);

  const lazy = load !== undefined;
  const addressees = lazy ? (fetched ?? []) : people;
  const ready = !lazy || fetched !== null;
  const waiting = lazy && !ready;

  // What is really coming, not what the filter holds: a read stops at the cap,
  // and a line promising 3,448 people would be corrected by the result.
  const coming = Math.min(expected ?? 0, ADDRESSEE_CAP);
  const preparing =
    coming > 0 ? `Preparing ${coming} ${coming === 1 ? 'person' : 'people'}…` : 'Preparing the list…';

  function ensure(): Promise<PersonAddressee[]> {
    if (!load) return Promise.resolve(people);
    if (fetched) return Promise.resolve(fetched);
    if (inflight.current) return inflight.current;

    setLoading(true);
    const call = load()
      .then((result) => {
        setFetched(result);
        return result;
      })
      .catch(() => {
        notify('error', 'That list could not be read. Try again.');
        return [] as PersonAddressee[];
      })
      .finally(() => {
        setLoading(false);
        inflight.current = null;
      });
    inflight.current = call;
    return call;
  }

  function onMenuOpen(open: boolean) {
    if (open) void ensure();
  }

  const link = gmailLink(addressees, mode);
  // Before the list is in, the button is offered: it is what starts the fetch.
  // Once it is in, a list with nobody to write to says so rather than opening
  // an empty compose window.
  const gmailBlocked = ready && link.url === null;
  const gmailLabel = single ? 'Email' : 'Open in Gmail';
  const gmailHint = waiting ? preparing : gmailTitle(link, mode);

  function go(list: PersonAddressee[], tab: Window | null): void {
    const target = gmailLink(list, mode);
    if (!target.url) {
      tab?.close();
      notify('error', target.reason ?? 'There is nobody here to write to.');
      return;
    }
    if (tab) tab.location.replace(target.url);
    else window.open(target.url, '_blank', 'noopener,noreferrer');
  }

  function openGmail() {
    if (ready) {
      go(addressees, null);
      return;
    }
    // Opened inside the press, before anything is awaited, or the browser
    // counts it as a pop-up and blocks it.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    void ensure().then((list) => go(list, tab));
  }

  async function copy(what: CopyKind) {
    const list = await ensure();
    const clip = clipboardFor(what, list);
    if (clip.count === 0) {
      notify('error', clip.message);
      return;
    }
    try {
      await navigator.clipboard.writeText(clip.text);
      notify('success', clip.message);
    } catch {
      notify('error', 'That could not be copied. Select the text and copy it instead.');
    }
  }

  function chooseMode(next: string) {
    if (!isGmailMode(next) || next === mode) return;
    const previous = mode;
    setMode(next);
    void updatePreferencesAction({ gmailMode: next }).then((result) => {
      // A setting the account does not actually have would have the next
      // reload take it away again, so a refusal puts the old one back.
      if (!result.ok) {
        setMode(previous);
        notify('error', result.error ?? 'That setting did not save. Nothing changed.');
      }
    });
  }

  const copyItems: { key: CopyKind; label: string }[] = [
    { key: 'addresses', label: 'Addresses' },
    { key: 'names', label: 'Names' },
    { key: 'names-and-addresses', label: 'Names and addresses' },
    { key: 'identifiers', label: identifierMenuLabel(addressees, kind) },
  ];
  if (hasStudents(addressees, kind)) {
    copyItems.push({ key: 'guardian-phones', label: 'Guardian phones' });
  }

  return (
    <div className="btn-row" role="group" aria-label={label ?? 'People'}>
      <div className="btn-split">
        <Button
          size={size}
          className="btn-split-main"
          icon={Mail}
          disabled={gmailBlocked}
          aria-busy={loading || undefined}
          aria-describedby={hintId}
          title={gmailHint}
          onClick={openGmail}
        >
          {gmailLabel}
        </Button>
        <DropdownMenu onOpenChange={onMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size={size}
              className="btn-split-more"
              icon={ChevronDown}
              aria-label="Gmail options"
              title="Gmail options"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Address the message</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={chooseMode}>
              {GMAIL_MODES.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {GMAIL_MODE_LABELS[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* The same sentence the tooltip carries, for a reader with no pointer to
          rest anywhere: how many will be written to, in which field, and how
          many of the list have no address. Outside the split button, so that
          the two halves are still each other's only siblings. */}
      <span id={hintId} className="visually-hidden">
        {gmailHint}
      </span>

      {single ? (
        <Button size={size} icon={Copy} onClick={() => void copy('addresses')}>
          Copy email
        </Button>
      ) : (
        <DropdownMenu onOpenChange={onMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size={size} icon={Copy} aria-busy={loading || undefined}>
              Copy
              <Icon icon={ChevronDown} size={16} weight="medium" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {waiting ? <DropdownMenuLabel>{preparing}</DropdownMenuLabel> : null}
            {copyItems.map((item) => (
              <DropdownMenuItem key={item.key} onSelect={() => void copy(item.key)}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {exportHref ? (
              <>
                <DropdownMenuSeparator />
                {/* A new tab rather than a fetch: the route answers with a file,
                    and the browser's own save is the shortest path from a menu
                    to something on somebody's disk. */}
                <DropdownMenuItem
                  onSelect={() => {
                    window.open(exportHref, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <Icon icon={Download} size={16} weight="medium" />
                  Export CSV
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
