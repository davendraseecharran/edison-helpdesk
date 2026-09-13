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
import { claimTicketAction, resumeWorkAction, returnTicketAction } from '@/lib/data/actions';
import {
  canAdministerTicket,
  canClaimTicket,
  canContribute,
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

/**
 * The bar itself, plus the in-flow spacer that reserves room for it at the
 * end of the page. Both are hidden above 720px; both exist only when there is
 * an action to offer, so a page without a bar keeps its normal bottom edge.
 */
export function TicketActionBar({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const closed = ticket.status === 'resolved' || ticket.status === 'cancelled';
  const busy = pendingKey !== null;

  const actions: React.ReactNode[] = [];

  if (closed) {
    if (canAdministerTicket(actor)) {
      actions.push(
        <Button key="reopen" disabled={busy} onClick={() => requestTicketIntent('reopen')}>
          Reopen ticket
        </Button>,
      );
    }
  } else {
    // Claim is the primary when it is offered; otherwise resolve is. Never two.
    const mayClaim = canClaimTicket(ticket, actor);
    if (mayClaim) {
      actions.push(
        <Button
          key="claim"
          variant="primary"
          disabled={busy}
          loading={pendingKey === `claim:${ticket.id}`}
          onClick={() => void run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id))}
        >
          Claim ticket
        </Button>,
      );
    }
    if (ticket.status === 'waiting' && canContribute(ticket, actor)) {
      actions.push(
        <Button
          key="resume"
          disabled={busy}
          loading={pendingKey === `resume:${ticket.id}`}
          onClick={() => void run(`resume:${ticket.id}`, () => resumeWorkAction(ticket.id))}
        >
          Resume work
        </Button>,
      );
    }
    if (canReturnToQueue(ticket, actor)) {
      actions.push(
        <Button
          key="return"
          disabled={busy}
          loading={pendingKey === `return:${ticket.id}`}
          onClick={() => void run(`return:${ticket.id}`, () => returnTicketAction(ticket.id))}
        >
          Return to queue
        </Button>,
      );
    }
    if (canResolveTicket(ticket, actor)) {
      actions.push(
        <Button
          key="resolve"
          variant={mayClaim ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => requestTicketIntent('resolve')}
        >
          Resolve ticket
        </Button>,
      );
    }
  }

  if (actions.length === 0) return null;

  return (
    <>
      <div className="ticket-bar-space" aria-hidden="true" />
      <div className="ticket-bar" role="group" aria-label="Ticket actions">
        {actions}
      </div>
    </>
  );
}
