'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import {
  cancelTicketAction,
  reassignTicketAction,
  reopenTicketAction,
  returnTicketAction,
} from '@/lib/data/actions';
import { canAdministerTicket } from '@/lib/domain/permissions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { revealControl, useTicketIntent } from './TicketActionBar';

/**
 * Administrator-only lifecycle controls: reassign, return to the queue,
 * reopen with a reason, and cancel with a reason. Prior ownership, notes, time
 * and events are preserved by every one of these operations.
 */
export function AdminActionsPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const [ownerId, setOwnerId] = useState(ticket.ownerId ?? '');
  const [reopenReason, setReopenReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [mode, setMode] = useState<'none' | 'reopen' | 'cancel'>('none');
  const [error, setError] = useState<string | null>(null);
  const reopenRef = useRef<HTMLInputElement>(null);
  // Set by the phone bar's intent and consumed once the reopen field exists,
  // so a desktop click on "Reopen ticket" reveals the form without scrolling.
  const revealReopen = useRef(false);

  const candidates = useMemo(
    () => directory.filter((account) => account.status === 'active'),
    [directory],
  );

  useTicketIntent('reopen', () => {
    if (mode === 'reopen') {
      /*
       * The form is already open, so setMode would be a no-op and the effect
       * below — which is what scrolls — would not run. On a phone that made a
       * second tap on the pinned "Reopen ticket" do nothing at all: the
       * technician had scrolled away from the form, tapped the bar to get back
       * to it, and the page stayed exactly where it was. Reveal it here
       * instead.
       */
      revealControl(reopenRef.current);
      return;
    }
    revealReopen.current = true;
    setMode('reopen');
  });
  useEffect(() => {
    if (mode === 'reopen' && revealReopen.current) {
      revealReopen.current = false;
      revealControl(reopenRef.current);
    }
  }, [mode]);

  // Every hook must run before this guard, so it stays below the hooks above.
  if (!canAdministerTicket(actor)) return null;

  const closed = ticket.status === 'resolved' || ticket.status === 'cancelled';
  const busy = pendingKey !== null;

  async function onReassign(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    // The selector's blank option means "back to the queue", which is a
    // different database operation from handing the ticket to another owner.
    const result = await run(`reassign:${ticket.id}`, () =>
      ownerId === ''
        ? returnTicketAction(ticket.id)
        : reassignTicketAction(ticket.id, ownerId),
    );
    if (!result.ok) setError(result.error ?? 'That change could not be saved.');
  }

  async function onReopen(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(`reopen:${ticket.id}`, () =>
      reopenTicketAction(ticket.id, reopenReason),
    );
    if (result.ok) {
      setReopenReason('');
      setMode('none');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  async function onCancel(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(`cancel:${ticket.id}`, () =>
      cancelTicketAction(ticket.id, cancelReason),
    );
    if (result.ok) {
      setCancelReason('');
      setMode('none');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  return (
    <section className="panel" aria-labelledby={`admin-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`admin-heading-${ticket.id}`}>
          Administration
        </h2>
        <span className="badge badge-chip badge-role">Admin only</span>
      </div>
      <div className="panel-body stack">
        {closed ? (
          mode === 'reopen' ? (
            <form onSubmit={onReopen} className="form">
              <Field label="Reason for reopening" htmlFor={`reopen-${ticket.id}`} error={error}>
                <input
                  id={`reopen-${ticket.id}`}
                  ref={reopenRef}
                  type="text"
                  value={reopenReason}
                  aria-invalid={error ? 'true' : undefined}
                  onChange={(event) => {
                    setReopenReason(event.target.value);
                    setError(null);
                  }}
                  placeholder="Fault returned the next morning"
                />
              </Field>
              <div className="form-actions">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  loading={pendingKey === `reopen:${ticket.id}`}
                >
                  Reopen ticket
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMode('none')}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="stack-xs">
              <div className="form-actions">
                <Button size="sm" onClick={() => setMode('reopen')}>
                  Reopen ticket
                </Button>
              </div>
              <p className="panel-note">
                Reopening keeps the previous owner, the recorded solution, and every note and
                event in the history.
              </p>
            </div>
          )
        ) : (
          <>
            <form onSubmit={onReassign} className="form">
              <Field
                label="Owner"
                htmlFor={`reassign-${ticket.id}`}
                error={error}
                hint="Choosing the queue returns the ticket for anyone to claim."
              >
                <select
                  id={`reassign-${ticket.id}`}
                  value={ownerId}
                  onChange={(event) => {
                    setOwnerId(event.target.value);
                    setError(null);
                  }}
                >
                  <option value="">Queue, unassigned</option>
                  {candidates.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-actions">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || ownerId === (ticket.ownerId ?? '')}
                  loading={pendingKey === `reassign:${ticket.id}`}
                >
                  Change owner
                </Button>
              </div>
            </form>

            {mode === 'cancel' ? (
              <form onSubmit={onCancel} className="form">
                <Field label="Reason for cancelling" htmlFor={`cancel-${ticket.id}`} error={error}>
                  <input
                    id={`cancel-${ticket.id}`}
                    type="text"
                    value={cancelReason}
                    aria-invalid={error ? 'true' : undefined}
                    onChange={(event) => {
                      setCancelReason(event.target.value);
                      setError(null);
                    }}
                    placeholder="Duplicate of EDT-1001"
                  />
                </Field>
                <div className="form-actions">
                  <Button
                    type="submit"
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    loading={pendingKey === `cancel:${ticket.id}`}
                  >
                    Confirm cancellation
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setMode('none')}>
                    Keep ticket
                  </Button>
                </div>
              </form>
            ) : (
              <div className="stack-xs">
                <div className="form-actions">
                  <Button variant="danger" size="sm" onClick={() => setMode('cancel')}>
                    Cancel ticket
                  </Button>
                </div>
                <p className="panel-note">
                  A cancellation needs a reason and never counts as a resolution.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
