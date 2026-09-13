'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canLogWork } from '@/lib/domain/permissions';
import { logWorkAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { formatDateKey, formatMinutes } from '@/lib/format';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';

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
  const contributors = detail.time.byContributor.length;
  const entries = detail.workLogs.length;

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
    <section className="panel" aria-labelledby={`time-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`time-heading-${ticket.id}`}>
          Time
        </h2>
        {mayLog ? (
          <Button
            size="sm"
            icon={open ? undefined : Plus}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Cancel' : 'Log time'}
          </Button>
        ) : null}
      </div>
      <div className="panel-body stack-sm">
        {detail.time.recorded ? (
          <>
            <p>
              <span className="time-total">{formatMinutes(detail.time.totalMinutes)}</span>
              <span className="time-total-note">
                across {contributors} {contributors === 1 ? 'person' : 'people'}
              </span>
            </p>
            <ul className="time-by">
              {detail.time.byContributor.map((entry) => (
                <li key={entry.accountId}>
                  <span>{entry.displayName}</span>
                  <span className="time-by-minutes">{formatMinutes(entry.minutes)}</span>
                </li>
              ))}
            </ul>
            <details className="time-entries">
              <summary>
                {entries} {entries === 1 ? 'entry' : 'entries'}
              </summary>
              <ul className="time-entry-list">
                {detail.workLogs.map((log) => (
                  <li key={log.id} className="time-entry">
                    <span className="time-entry-date">{formatDateKey(log.workDate)}</span>
                    <span className="time-entry-minutes">{formatMinutes(log.minutes)}</span>
                    <span>{nameOf(directory, log.contributorId)}</span>
                    {log.description ? (
                      <span className="time-entry-note">{log.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p className="panel-note">
            <strong>No time recorded.</strong> That is different from zero minutes. Time entries
            are optional and never required to resolve a ticket.
          </p>
        )}

        {open && mayLog ? (
          <form onSubmit={onSubmit} className="form">
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
            <div className="form-actions">
              <Button type="submit" size="sm" disabled={pendingKey !== null} loading={saving}>
                Save entry
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
