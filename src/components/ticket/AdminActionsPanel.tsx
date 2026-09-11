'use client';

import { useMemo, useState } from 'react';
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

/**
 * Administrator-only lifecycle controls: reassign, return to the Open Queue,
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

  const candidates = useMemo(
    () => directory.filter((account) => account.status === 'active'),
    [directory],
  );

  // Every hook must run before this guard, so it stays below the useMemo above.
  if (!canAdministerTicket(actor)) return null;

  const closed = ticket.status === 'resolved' || ticket.status === 'cancelled';

  async function onReassign(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    // The selector's blank option means "back to the Open Queue", which is a
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
    <div className="card">
      <div className="card-header">
        <h2>Administration</h2>
        <span className="badge badge-role">Admin only</span>
      </div>
      <div className="card-body stack-sm">
        {closed ? (
          mode === 'reopen' ? (
            <form onSubmit={onReopen} className="stack-sm">
              <Field label="Reason for reopening" htmlFor={`reopen-${ticket.id}`} error={error}>
                <input
                  id={`reopen-${ticket.id}`}
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
              <div className="btn-row">
                <button type="submit" className="btn btn-sm btn-primary" disabled={pendingKey !== null}>
                  {pendingKey === `reopen:${ticket.id}` ? 'Reopening…' : 'Reopen ticket'}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('none')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="small muted">
                Reopening keeps the previous owner, the recorded solution, and every note and
                event in the history.
              </p>
              <div>
                <button type="button" className="btn btn-sm" onClick={() => setMode('reopen')}>
                  Reopen ticket
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <form onSubmit={onReassign} className="stack-sm">
              <Field
                label="Primary owner"
                htmlFor={`reassign-${ticket.id}`}
                error={error}
                hint="Choosing Open Queue returns the ticket for anyone to claim."
              >
                <select
                  id={`reassign-${ticket.id}`}
                  value={ownerId}
                  onChange={(event) => {
                    setOwnerId(event.target.value);
                    setError(null);
                  }}
                >
                  <option value="">Open Queue — unassigned</option>
                  {candidates.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <div>
                <button
                  type="submit"
                  className="btn btn-sm"
                  disabled={pendingKey !== null || ownerId === (ticket.ownerId ?? '')}
                >
                  {pendingKey === `reassign:${ticket.id}` ? 'Saving…' : 'Apply ownership change'}
                </button>
              </div>
            </form>

            {mode === 'cancel' ? (
              <form onSubmit={onCancel} className="stack-sm">
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
                <div className="btn-row">
                  <button type="submit" className="btn btn-sm btn-danger" disabled={pendingKey !== null}>
                    {pendingKey === `cancel:${ticket.id}` ? 'Cancelling…' : 'Confirm cancellation'}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('none')}>
                    Keep ticket
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setMode('cancel')}>
                  Cancel ticket
                </button>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  A cancellation needs a reason and never counts as a resolution.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
