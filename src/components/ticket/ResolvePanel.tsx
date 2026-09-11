'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canResolveTicket } from '@/lib/domain/permissions';
import { resolveTicketAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';

/**
 * Resolution. A non-blank solution is required; a time entry is not. The primary
 * owner is preserved and the resolver is recorded separately, so a collaborator
 * finishing the work does not take over ownership.
 */
export function ResolvePanel({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [solution, setSolution] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayResolve = canResolveTicket(ticket, actor);
  const key = `resolve:${ticket.id}`;
  const saving = pendingKey === key;
  const resolved = ticket.status === 'resolved';

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(key, () => resolveTicketAction(ticket.id, solution));
    if (result.ok) {
      setSolution('');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>{resolved ? 'Solution' : 'Resolve'}</h2>
        {resolved && detail.resolver ? (
          <span className="small subtle">
            Resolved by {detail.resolver.displayName}
            {ticket.resolvedAt ? (
              <>
                {' · '}
                <TimeAgo iso={ticket.resolvedAt} />
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="card-body stack">
        {ticket.solution ? (
          <div className={resolved ? 'solution-box' : 'solution-box solution-box-previous'}>
            {!resolved ? (
              <p className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                Previous solution — kept after the ticket was reopened
              </p>
            ) : null}
            {ticket.solution}
          </div>
        ) : null}

        {ticket.status === 'cancelled' ? (
          <p className="notice notice-warning">
            Cancelled: {ticket.cancelReason}. A cancellation is not a resolution.
          </p>
        ) : null}

        {resolved ? (
          <p className="small muted">
            {detail.owner
              ? `Primary owner ${detail.owner.displayName} stays recorded on this ticket.`
              : 'This ticket was resolved without a primary owner.'}
            {detail.time.recorded
              ? ''
              : ' No time was recorded, which is not the same as zero minutes.'}
          </p>
        ) : mayResolve ? (
          <form onSubmit={onSubmit} className="stack-sm">
            <Field
              label="Solution"
              htmlFor={`solution-${ticket.id}`}
              error={error}
              hint="Required. Recording time is optional and never blocks resolution."
            >
              <textarea
                id={`solution-${ticket.id}`}
                value={solution}
                rows={3}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => {
                  setSolution(event.target.value);
                  setError(null);
                }}
                placeholder="What fixed it, and anything the next technician should know."
              />
            </Field>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Resolving…' : 'Resolve ticket'}
              </button>
            </div>
          </form>
        ) : (
          <p className="notice">
            Only the primary owner, a collaborator, or an administrator can resolve this ticket.
          </p>
        )}
      </div>
    </div>
  );
}
