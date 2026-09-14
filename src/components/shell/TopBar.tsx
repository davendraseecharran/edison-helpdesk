'use client';

import Link from 'next/link';
import { Bell, Plus, Sparkles } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { LookupTrigger } from './LookupBar';
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
 * Bell with an unread count. The dropdown arrives with notifications; until
 * then the button announces the count and does nothing else.
 */
export function NotificationsBell({ unread }: { unread: number }) {
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <span className="bell">
      <Button variant="ghost" icon={Bell} aria-label={label} title="Notifications" />
      {unread > 0 ? (
        <span className="bell-count" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </span>
  );
}

/** Opens the assistant. The panel itself listens for the event. */
export function AiToggle() {
  return (
    <Button
      variant="ghost"
      icon={Sparkles}
      aria-label="Ask the assistant"
      title="Ask the assistant"
      onClick={() => openAssistant()}
    />
  );
}

/**
 * The top bar: brand, the lookup field in the centre, then the actions that
 * are always one press away. The lookup is the one bold element of the
 * interface, so the bar around it stays plain.
 */
export function TopBar({
  unreadNotifications,
  onOpenLookup,
}: {
  unreadNotifications: number;
  onOpenLookup: () => void;
}) {
  return (
    <header className="topbar">
      <Link href="/queue" className="brand" aria-label="Edison Helpdesk, go to the queue">
        <span className="brand-mark" aria-hidden="true">
          E
        </span>
        <span className="brand-name">Edison Helpdesk</span>
      </Link>

      <div className="topbar-lookup">
        <LookupTrigger onOpen={onOpenLookup} />
      </div>

      <div className="topbar-actions">
        <ButtonLink href="/tickets/new" variant="primary" icon={Plus} collapseOnPhone>
          New ticket
        </ButtonLink>
        <NotificationsBell unread={unreadNotifications} />
        <AiToggle />
        <UserMenu />
      </div>
    </header>
  );
}
