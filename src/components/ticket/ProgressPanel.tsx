'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { type Priority, PRIORITY_LABELS, WAITING_REASONS } from '@/lib/domain/types';
import { canContribute, canSetPriority } from '@/lib/domain/permissions';
import { resumeWorkAction, setPriorityAction, setWaitingAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';

/** Priority and the Waiting hold, both of which write an activity event. */
export function ProgressPanel({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const [reason, setReason] = useState<string>(WAITING_REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [showWaiting, setShowWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mayChangePriority = canSetPriority(ticket, actor);
  const mayContribute = canContribute(ticket, actor);

  async function onPriorityChange(value: Priority) {
    setError(null);
    const result = await run(`priority:${ticket.id}`, () => setPriorityAction(ticket.id, value));
    if (!result.ok) setError(result.error ?? 'That change could not be saved.');
  }

  async function onWaiting(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const text = reason === 'Other' ? customReason : `${reason}${customReason ? ` — ${customReason}` : ''}`;
    const result = await run(`waiting:${ticket.id}`, () => setWaitingAction(ticket.id, text));
    if (result.ok) {
      setShowWaiting(false);
      setCustomReason('');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  async function onResume() {
    setError(null);
    const result = await run(`resume:${ticket.id}`, () => resumeWorkAction(ticket.id));
    if (!result.ok) setError(result.error ?? 'That change could not be saved.');
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>Progress</h2>
      </div>
      <div className="card-body stack-sm">
        <Field
          label="Priority"
          htmlFor={`priority-${ticket.id}`}
          hint={mayChangePriority ? 'Changes are recorded in the history.' : undefined}
        >
          <select
            id={`priority-${ticket.id}`}
            value={ticket.priority}
            disabled={!mayChangePriority || pendingKey !== null}
            onChange={(event) => void onPriorityChange(event.target.value as Priority)}
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        {ticket.status === 'waiting' ? (
          <>
            <p className="notice notice-warning">
              <strong>Waiting.</strong> {ticket.waitingReason}
            </p>
            {mayContribute ? (
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onResume()}
                  disabled={pendingKey !== null}
                >
                  {pendingKey === `resume:${ticket.id}` ? 'Resuming…' : 'Resume work'}
                </button>
              </div>
            ) : null}
          </>
        ) : mayContribute && ticket.ownerId ? (
          showWaiting ? (
            <form onSubmit={onWaiting} className="stack-sm">
              <Field label="Waiting reason" htmlFor={`waiting-reason-${ticket.id}`} error={error}>
                <select
                  id={`waiting-reason-${ticket.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                >
                  {WAITING_REASONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  <option value="Other">Other</option>
                </select>
              </Field>
              <Field
                label="Detail"
                htmlFor={`waiting-detail-${ticket.id}`}
                optional={reason !== 'Other'}
              >
                <input
                  id={`waiting-detail-${ticket.id}`}
                  type="text"
                  value={customReason}
                  onChange={(event) => setCustomReason(event.target.value)}
                  placeholder="Replacement pen ordered"
                />
              </Field>
              <div className="btn-row">
                <button
                  type="submit"
                  className="btn btn-sm"
                  disabled={pendingKey !== null}
                >
                  {pendingKey === `waiting:${ticket.id}` ? 'Saving…' : 'Set to Waiting'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setShowWaiting(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => setShowWaiting(true)}>
                Put on hold
              </button>
            </div>
          )
        ) : null}

        {error && !showWaiting ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
