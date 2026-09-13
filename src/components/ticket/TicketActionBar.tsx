'use client';

/**
 * The phone action bar and the intent channel behind it.
 *
 * On phones the detail page stacks, so the primary action for the ticket's
 * state (claim, resolve, return, reopen) is pinned above the bottom tabs. The
 * bar never has its own forms: claim and return call the same server actions
 * the panels call, and resolve and reopen hand off to the panel that owns the
 * form by dispatching an intent, which that panel answers by revealing and
 * focusing its field. Above 720px the stylesheet hides the bar entirely.
 */

import { useEffect, useRef } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { claimTicketAction, returnTicketAction } from '@/lib/data/actions';
import {
  canAdministerTicket,
  canClaimTicket,
  canResolveTicket,
  canReturnToQueue,
} from '@/lib/domain/permissions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';

export type TicketIntent = 'resolve' | 'reopen';

const TICKET_INTENT_EVENT = 'edison:ticket-intent';

export function requestTicketIntent(intent: TicketIntent): void {
  window.dispatchEvent(new CustomEvent<TicketIntent>(TICKET_INTENT_EVENT, { detail: intent }));
}

/** Runs `handler` whenever `intent` is requested. The handler may change freely. */
export function useTicketIntent(intent: TicketIntent, handler: () => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    function onIntent(event: Event) {
      if ((event as CustomEvent<TicketIntent>).detail === intent) latest.current();
    }
    window.addEventListener(TICKET_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(TICKET_INTENT_EVENT, onIntent);
  }, [intent]);
}

/** Scrolls a control to the middle of the viewport, clear of the pinned bars, then focuses it. */
export function revealControl(element: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView({ block: 'center' });
  element.focus({ preventScroll: true });
}

export function TicketActionBar({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const closed = ticket.status === 'resolved' || ticket.status === 'cancelled';
  const busy = pendingKey !== null;

  if (canClaimTicket(ticket, actor)) {
    return (
      <div className="ticket-bar" role="group" aria-label="Ticket actions">
        <Button
          variant="primary"
          disabled={busy}
          loading={pendingKey === `claim:${ticket.id}`}
          onClick={() => void run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id))}
        >
          Claim ticket
        </Button>
      </div>
    );
  }

  if (!closed) {
    const mayResolve = canResolveTicket(ticket, actor);
    const mayReturn = canReturnToQueue(ticket, actor);
    if (!mayResolve && !mayReturn) return null;
    return (
      <div className="ticket-bar" role="group" aria-label="Ticket actions">
        {mayReturn ? (
          <Button
            disabled={busy}
            loading={pendingKey === `return:${ticket.id}`}
            onClick={() => void run(`return:${ticket.id}`, () => returnTicketAction(ticket.id))}
          >
            Return to queue
          </Button>
        ) : null}
        {mayResolve ? (
          <Button variant="primary" disabled={busy} onClick={() => requestTicketIntent('resolve')}>
            Resolve ticket
          </Button>
        ) : null}
      </div>
    );
  }

  if (canAdministerTicket(actor)) {
    return (
      <div className="ticket-bar" role="group" aria-label="Ticket actions">
        <Button disabled={busy} onClick={() => requestTicketIntent('reopen')}>
          Reopen ticket
        </Button>
      </div>
    );
  }

  return null;
}
