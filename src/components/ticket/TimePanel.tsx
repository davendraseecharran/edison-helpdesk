'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canLogWork } from '@/lib/domain/permissions';
import { logWorkAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { formatDateKey, formatMinutes } from '@/lib/format';
import { Field } from '@/components/Primitives';

/**
 * Optional manual time entries. Totals are person-time, and "not recorded" is
 * displayed distinctly from a recorded zero.
 */
export function TimePanel({ detail }: { detail: TicketDetail }) {
  const { directory, today, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const [open, setOpen] = useState(false);
  const [workDate, setWorkDate] = useState(today);
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mayLog = canLogWork(ticket, actor);
  const key = `time:${ticket.id}`;
  const saving = pendingKey === key;

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(key, () =>
      logWorkAction(ticket.id, Number.parseInt(minutes, 10), workDate, description),
    );
    if (result.ok) {
      setMinutes('');
      setDescription('');
      setOpen(false);
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>Time</h2>
        {mayLog ? (
          <button type="button" className="btn btn-sm" onClick={() => setOpen((value) => !value)}>
            {open ? 'Cancel' : 'Log time'}
          </button>
        ) : null}
      </div>
      <div className="card-body stack-sm">
        {detail.time.recorded ? (
          <>
            <p>
              <strong>{formatMinutes(detail.time.totalMinutes)}</strong>{' '}
              <span className="muted small">person-time across {detail.time.byContributor.length}{' '}
                {detail.time.byContributor.length === 1 ? 'contributor' : 'contributors'}
              </span>
            </p>
            <ul className="stack-sm small" style={{ margin: 0, paddingLeft: 16 }}>
              {detail.time.byContributor.map((entry) => (
                <li key={entry.accountId}>
                  {entry.displayName} — {formatMinutes(entry.minutes)}
                </li>
              ))}
            </ul>
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                {detail.workLogs.length} {detail.workLogs.length === 1 ? 'entry' : 'entries'}
              </summary>
              <ul className="stack-sm small" style={{ marginTop: 8, paddingLeft: 16 }}>
                {detail.workLogs.map((log) => (
                  <li key={log.id}>
                    {formatDateKey(log.workDate)} · {formatMinutes(log.minutes)} ·{' '}
                    {nameOf(directory, log.contributorId)}
                    {log.description ? ` — ${log.description}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p className="small muted">
            <strong>No time recorded.</strong> That is different from zero minutes — time entries
            are optional and never required to resolve a ticket.
          </p>
        )}

        {open && mayLog ? (
          <form onSubmit={onSubmit} className="stack-sm">
            <Field label="Work date" htmlFor={`time-date-${ticket.id}`}>
              <input
                id={`time-date-${ticket.id}`}
                type="date"
                value={workDate}
                max={today}
                onChange={(event) => setWorkDate(event.target.value)}
              />
            </Field>
            <Field label="Minutes" htmlFor={`time-minutes-${ticket.id}`} error={error}>
              <input
                id={`time-minutes-${ticket.id}`}
                type="number"
                min={1}
                max={1440}
                step={1}
                value={minutes}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => {
                  setMinutes(event.target.value);
                  setError(null);
                }}
              />
            </Field>
            <Field label="Description" htmlFor={`time-description-${ticket.id}`} optional>
              <input
                id={`time-description-${ticket.id}`}
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Saving…' : 'Save entry'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
