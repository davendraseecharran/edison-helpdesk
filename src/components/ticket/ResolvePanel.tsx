'use client';

import { useMemo, useRef, useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canResolveTicket } from '@/lib/domain/permissions';
import { draftSolution } from '@/lib/domain/resolution';
import { resolveTicketAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { revealControl, useTicketIntent } from './TicketActionBar';
import '@/styles/lists.css';

/**
 * Resolution. A non-blank solution is required; a time entry is not. The owner
 * is preserved and the resolver is recorded separately, so a collaborator
 * finishing the work does not take over ownership. Rendered only while the
 * ticket is still active; `SolutionPanel` shows the outcome afterwards.
 */
export function ResolvePanel({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [solution, setSolution] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draftUsed, setDraftUsed] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /*
   * The solution, already written.
   *
   * By the time somebody resolves a ticket they have usually typed the answer
   * once already, in a note. This offers it back rather than asking for it
   * again at the end of a long day, which is the moment solutions get written
   * as "fixed". It is offered rather than filled in: a solution nobody read
   * before pressing the button is worse than a short one somebody meant.
   */
  const draft = useMemo(() => draftSolution(detail), [detail]);

  const ticket = detail.ticket;
  const mayResolve = canResolveTicket(ticket, actor);
  const key = `resolve:${ticket.id}`;
  const saving = pendingKey === key;

  useTicketIntent('resolve', () => revealControl(fieldRef.current));

  if (ticket.status === 'resolved' || ticket.status === 'cancelled') return null;

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
    <section className="panel" aria-labelledby={`resolve-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`resolve-heading-${ticket.id}`}>
          Resolve
        </h2>
      </div>
      <div className="panel-body">
        {mayResolve ? (
          <form onSubmit={onSubmit} className="form">
            {draft && !draftUsed && solution.trim() === '' ? (
              <div className="resolve-draft">
                <p className="resolve-draft-label">From the notes and the work log</p>
                <p className="resolve-draft-text">{draft}</p>
                <div className="resolve-draft-actions">
                  <Button
                    size="sm"
                    onClick={() => {
                      setSolution(draft);
                      setDraftUsed(true);
                      revealControl(fieldRef.current);
                    }}
                  >
                    Use this
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraftUsed(true)}>
                    Write my own
                  </Button>
                </div>
              </div>
            ) : null}
            <Field
              label="Solution"
              htmlFor={`solution-${ticket.id}`}
              error={error}
              hint="Required. Logging time is optional and never blocks resolution."
            >
              <textarea
                id={`solution-${ticket.id}`}
                ref={fieldRef}
                value={solution}
                rows={3}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => {
                  setSolution(event.target.value);
                  setError(null);
                }}
                placeholder="What fixed it, and anything the next NetRider should know."
              />
            </Field>
            <div className="form-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={pendingKey !== null}
                loading={saving}
              >
                Resolve ticket
              </Button>
            </div>
          </form>
        ) : (
          <p className="callout">
            Only the owner, a collaborator or an administrator can resolve this ticket.
          </p>
        )}
      </div>
    </section>
  );
}
