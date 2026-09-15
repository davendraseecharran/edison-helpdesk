'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { type Priority, PRIORITY_LABELS, WAITING_REASONS } from '@/lib/domain/types';
import { canContribute, canSetPriority } from '@/lib/domain/permissions';
import { resumeWorkAction, setPriorityAction, setWaitingAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';

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
  const busy = pendingKey !== null;

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
    <section className="panel" aria-labelledby={`progress-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`progress-heading-${ticket.id}`}>
          Progress
        </h2>
      </div>
      <div className="panel-body stack-sm">
        <Field
          label="Priority"
          htmlFor={`priority-${ticket.id}`}
          hint={mayChangePriority ? 'Changes are recorded in the history.' : undefined}
        >
          <Select
            id={`priority-${ticket.id}`}
            value={ticket.priority}
            disabled={!mayChangePriority || busy}
            onChange={(value) => void onPriorityChange(value as Priority)}
            options={(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => ({
              value,
              label: PRIORITY_LABELS[value],
            }))}
          />
        </Field>

        {ticket.status === 'waiting' ? (
          <>
            <p className="callout callout-warn">
              <strong>Waiting.</strong> {ticket.waitingReason}
            </p>
            {mayContribute ? (
              <div className="form-actions">
                <Button
                  size="sm"
                  onClick={() => void onResume()}
                  disabled={busy}
                  loading={pendingKey === `resume:${ticket.id}`}
                >
                  Resume work
                </Button>
              </div>
            ) : null}
          </>
        ) : mayContribute && ticket.ownerId ? (
          showWaiting ? (
            <form onSubmit={onWaiting} className="form">
              <Field label="Waiting for" htmlFor={`waiting-reason-${ticket.id}`} error={error}>
                <Select
                  id={`waiting-reason-${ticket.id}`}
                  value={reason}
                  onChange={setReason}
                  options={[
                    ...WAITING_REASONS.map((value) => ({ value, label: value })),
                    { value: 'Other', label: 'Other' },
                  ]}
                />
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
              <div className="form-actions">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy}
                  loading={pendingKey === `waiting:${ticket.id}`}
                >
                  Put on hold
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowWaiting(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="form-actions">
              <Button size="sm" onClick={() => setShowWaiting(true)}>
                Put on hold
              </Button>
            </div>
          )
        ) : null}

        {error && !showWaiting ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
