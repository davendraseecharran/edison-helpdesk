'use client';

import Link from 'next/link';
import { Plus, QrCode } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
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
 * The one primary action in the bar.
 *
 * The `n` shortcut AppShell binds is named in the tooltip rather than drawn as
 * a keycap inside the button: a primary control should read as one thing to
 * do, not as a thing to do and a key to remember. When the shortcut is not
 * bound -- on the intake form itself -- the tooltip drops to the plain name,
 * because a tooltip that promises a key that does nothing is worse than none.
 */
function NewTicketButton({ shortcut }: { shortcut: boolean }) {
  return (
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
      <ButtonLink href="/tickets/new" variant="primary" icon={Plus} collapseOnPhone>
        New ticket
      </ButtonLink>
    </Tooltip>
  );
}
