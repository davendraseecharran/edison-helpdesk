'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Plus, QrCode, SlidersHorizontal, Zap } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { Tooltip } from '@/components/ui/Tooltip';
import { presetHref } from '@/lib/domain/ticket-presets';
import { primeTicketPresets, useTicketPresets } from '@/lib/presets/store';
import { AiToggle } from './AiToggle';
import { LookupTrigger, openScanner } from './LookupBar';
import { NotificationsBell } from './NotificationsBell';
import { UserMenu } from './UserMenu';

/** Dispatched on `window` to open the assistant panel, wherever it lives. */
export const OPEN_ASSISTANT_EVENT = 'edison:open-assistant';

/** Open the assistant; with `prompt`, the panel starts from that text. */
export function openAssistant(prompt?: string): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_ASSISTANT_EVENT, { detail: prompt === undefined ? null : { prompt } }),
  );
}

/**
 * The top bar: brand, the lookup field in the centre, then the actions that
 * are always one press away. The lookup is the one bold element of the
 * interface, so the bar around it stays plain.
 */
export function TopBar({
  unreadNotifications,
  notifyInApp = true,
  onOpenLookup,
  newTicketShortcut = true,
  homeHref = '/queue',
  canCreateTickets = true,
  canScan = true,
}: {
  unreadNotifications: number;
  /** The account's `notify_in_app` setting. False hides the bell's count. */
  notifyInApp?: boolean;
  onOpenLookup: () => void;
  /** Whether AppShell has the `n` shortcut bound right now. False on
   * `/tickets/new` itself, where the keycap would promise a key that does
   * nothing. */
  newTicketShortcut?: boolean;
  /** Where the brand goes: the queue, or the directory for a skills officer. */
  homeHref?: string;
  /** False for an account that does not work tickets, which hides intake. */
  canCreateTickets?: boolean;
  /** False for a skills officer, who has no machines to point a camera at. */
  canScan?: boolean;
}) {
  return (
    <header className="topbar">
      <Link href={homeHref} className="brand" aria-label="Edison Helpdesk, go to the start page">
        <span className="brand-name" aria-hidden="true">
          Edison<span className="brand-name-tail">Helpdesk</span>
        </span>
      </Link>

      <div className="topbar-lookup">
        <LookupTrigger onOpen={onOpenLookup} />
      </div>

      <div className="topbar-actions">
        {/* Intake is ticket work. A skills officer gets no button for a form
            they would be turned away from. */}
        {canCreateTickets ? <NewTicketButton shortcut={newTicketShortcut} /> : null}
        <NotificationsBell unread={unreadNotifications} showCount={notifyInApp} />
        {/* The phone in a NetRider's pocket is a better barcode reader than
            anything on the desk, and this is the two-second way to borrow it:
            a code on screen, a camera pointed at it, and every scan from then
            on lands in this window. The palette keeps the same action for
            somebody whose hands are already on the keyboard. On a phone the
            bar has no room for it and a tooltip is not something a finger can
            ask for, so `shell.css` hides it there and the More sheet carries
            it with its name written out. */}
        {canScan ? (
          <Tooltip label="Scan with your phone">
            <Button
              variant="ghost"
              icon={QrCode}
              className="topbar-scan"
              aria-label="Scan with your phone"
              onClick={openScanner}
            />
          </Tooltip>
        ) : null}
        <AiToggle />
        <UserMenu />
      </div>
    </header>
  );
}

/**
 * The one primary action in the bar, and the day's repeated calls beside it.
 *
 * The `n` shortcut AppShell binds is named in the tooltip rather than drawn as
 * a keycap inside the button: a primary control should read as one thing to
 * do, not as a thing to do and a key to remember. When the shortcut is not
 * bound -- on the intake form itself -- the tooltip drops to the plain name,
 * because a tooltip that promises a key that does nothing is worse than none.
 *
 * The chevron joined to its right is a second control, not a second meaning
 * for the first: pressing the button is still the empty form, every time.
 * On a phone it is not drawn at all -- `shell.css` takes it away, the `+` stays
 * exactly as it was, and the quick tickets are in the palette, which is where
 * everything else the bar has no room for lives.
 */
function NewTicketButton({ shortcut }: { shortcut: boolean }) {
  return (
    <div className="btn-split">
      <Tooltip
        label={
          shortcut ? (
            <>
              New ticket<kbd className="kbd">n</kbd>
            </>
          ) : (
            'New ticket'
          )
        }
      >
        <ButtonLink
          href="/tickets/new"
          variant="primary"
          size="sm"
          icon={Plus}
          className="btn-split-main"
          collapseOnPhone
        >
          New ticket
        </ButtonLink>
      </Tooltip>
      <QuickTicketsMenu />
    </div>
  );
}

/**
 * The calls that repeat all day, one press each.
 *
 * The list is fetched when the menu is first looked at rather than on every
 * page load, and primed on the pointer or on focus so it is usually already
 * there when the menu opens. Each row is a real link, so the middle button and
 * "open in a new tab" do what they do everywhere else.
 */
function QuickTicketsMenu() {
  const [open, setOpen] = useState(false);
  const presets = useTicketPresets(open);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="primary"
          size="sm"
          icon={ChevronDown}
          className="btn-split-more topbar-quick"
          aria-label="Quick tickets"
          onPointerEnter={primeTicketPresets}
          onFocus={primeTicketPresets}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Quick tickets">
        {presets.map((preset) => (
          <DropdownMenuItem key={preset.id} asChild>
            <Link href={presetHref(preset.id)}>
              <Icon icon={Zap} size={16} />
              <span>{preset.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {/* No rule above the first row of an empty menu. */}
        {presets.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem asChild>
          <Link href="/settings#quick-tickets">
            <Icon icon={SlidersHorizontal} size={16} />
            <span>Manage quick tickets</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
