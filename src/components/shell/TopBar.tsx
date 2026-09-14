'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { AiToggle } from './AiToggle';
import { LookupTrigger } from './LookupBar';
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
        {canCreateTickets ? (
          <ButtonLink href="/tickets/new" variant="primary" icon={Plus} collapseOnPhone>
            New ticket
            {/* The `n` shortcut AppShell binds, shown on the control it presses.
                `collapseOnPhone` wraps these children in `.btn-label`, which is
                visually hidden below 720px, so the keycap goes with the label on
                a phone — where there is no hardware keyboard to press it. Hidden
                on `/tickets/new` itself, where AppShell leaves `n` unbound. */}
            {newTicketShortcut ? (
              <kbd className="kbd kbd-in-button" aria-hidden="true">
                n
              </kbd>
            ) : null}
          </ButtonLink>
        ) : null}
        <NotificationsBell unread={unreadNotifications} showCount={notifyInApp} />
        <AiToggle />
        <UserMenu />
      </div>
    </header>
  );
}
