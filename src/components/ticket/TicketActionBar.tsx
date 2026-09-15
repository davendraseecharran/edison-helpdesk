'use client';

/**
 * The ticket's action bar, and the intent channel behind it.
 *
 * One list of actions — claim, resume, hold, return, resolve, reopen — for the
 * ticket's current state and this account's rights, rendered in two places and
 * shown in one at a time. On a phone the page stacks, so the bar is pinned
 * above the bottom tabs where the thumb is. Above 720px it sticks under the top
 * bar instead, because on a long ticket Resolve was nine hundred pixels down a
 * page of seven cards: the one thing somebody came to do was the last thing
 * they could reach.
 *
 * Two copies rather than one moved: each breakpoint's version is `display:
 * none` in the other, which takes it out of the accessibility tree as well as
 * off the screen, and the alternative — one element that changes position — is
 * a bar that has to be both at the top of the document for `sticky` and at the
 * end of it for the phone's spacer.
 *
 * The bar never has its own forms: claim, resume and return call the same
 * server actions the panels called, and resolve, reopen and hold hand off to
 * the panel that owns the form by dispatching an intent, which that panel
 * answers by revealing and focusing its field.
 *
 * And the panels no longer offer them twice. Claim, Resume and Return were
 * buttons here AND buttons in Ownership and Progress, decided by the same
 * permission predicates — so a 1440 screen showed two live "Claim ticket"
 * controls, one under the title and one in the rail, and there is no reading of
 * that which is not a question about whether they do the same thing. The bar is
 * where an action on the whole ticket lives; what stays in a panel is the form
 * that action needs (the solution, the waiting reason), reached from the bar.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
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

export type TicketIntent = 'resolve' | 'reopen' | 'note' | 'hold';

const TICKET_INTENT_EVENT = 'edison:ticket-intent';

function requestTicketIntent(intent: TicketIntent): void {
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

const INTENTS: readonly TicketIntent[] = ['resolve', 'reopen', 'note', 'hold'];

/**
 * An intent carried in by the URL.
 *
 * `r` and `e` on a list row open the ticket with `?do=resolve` or `?do=note`,
 * because the field they mean is on the ticket rather than on the row. This
 * turns that back into the intent the panels already answer, once, after the
 * page has painted — so the scroll and the focus land on a control that
 * exists. It renders nothing.
 *
 * Read from the URL rather than passed as a prop so the detail page stays a
 * server component, and dispatched rather than handled here so there is still
 * exactly one channel between "somebody asked for the resolve field" and the
 * panel that owns it.
 */
export function TicketIntentFromQuery() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('do');
  const intent = INTENTS.find((value) => value === raw) ?? null;

  useEffect(() => {
    if (intent === null) return;
    // After paint: the panel that answers this is mounted in the same commit,
    // and a focus call in the same frame would race its own effect.
    const frame = window.requestAnimationFrame(() => requestTicketIntent(intent));
    return () => window.cancelAnimationFrame(frame);
  }, [intent]);

  return null;
}

/** Scrolls a control to the middle of the viewport, clear of the pinned bars, then focuses it. */
export function revealControl(element: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView({ block: 'center' });
  element.focus({ preventScroll: true });
}

/**
 * The bar, in one of its two places.
 *
 * `placement="bottom"` is the phone's: fixed above the tabs, with the in-flow
 * spacer that reserves room for it at the end of the page. `placement="top"`
 * is the desktop's: sticky under the top bar, no spacer, because it is in the
 * flow where it is drawn. Either exists only when there is an action to offer,
 * so a ticket nobody may act on keeps its normal edges.
 */
export function TicketActionBar({
  detail,
  placement = 'bottom',
}: {
  detail: TicketDetail;
  placement?: 'top' | 'bottom';
}) {
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
    const mayContribute = canContribute(ticket, actor);
    if (mayClaim) {
      actions.push(
        <Button
          key="claim"
          variant="primary"
          title="Claim ticket (c)"
          disabled={busy}
          loading={pendingKey === `claim:${ticket.id}`}
          onClick={() =>
            void run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id, ticket.number))
          }
        >
          Claim ticket
        </Button>,
      );
    }
    if (ticket.status === 'waiting' && mayContribute) {
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
    /*
     * A hold is the third thing that happens to a ticket somebody is working,
     * beside finishing it and giving it back, and it was the one action of the
     * three that lived only in the rail. It needs a reason, which is a form, so
     * the bar asks for the form rather than carrying it: the same handoff
     * Resolve makes. Only an owned ticket can wait — an unclaimed one is not
     * waiting for anything, it is waiting for somebody.
     */
    if (ticket.status !== 'waiting' && ticket.ownerId && mayContribute) {
      actions.push(
        <Button key="hold" disabled={busy} onClick={() => requestTicketIntent('hold')}>
          Put on hold
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

  if (placement === 'top') {
    return (
      <div className="ticket-sticky-bar" role="group" aria-label="Ticket actions">
        {actions}
      </div>
    );
  }

  return (
    <>
      <div className="ticket-bar-space" aria-hidden="true" />
      <div className="ticket-bar" role="group" aria-label="Ticket actions">
        {actions}
      </div>
    </>
  );
}
