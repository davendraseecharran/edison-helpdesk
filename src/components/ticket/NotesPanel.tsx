'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { addNoteAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';
import { Button } from '@/components/ui/Button';

export function NotesPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayAdd = canContribute(ticket, actor);
  const key = `note:${ticket.id}`;
  const saving = pendingKey === key;
  const count = detail.notes.length;

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(key, () => addNoteAction(ticket.id, body));
    if (result.ok) {
      setBody('');
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  return (
    <section className="panel" aria-labelledby={`notes-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`notes-heading-${ticket.id}`}>
          Notes
        </h2>
        <span className="panel-aside">
          {count} {count === 1 ? 'note' : 'notes'}
        </span>
      </div>
      <div className="panel-body stack">
        {count === 0 ? (
          <p className="panel-empty">No notes yet.</p>
        ) : (
          <ol className="notes">
            {detail.notes.map((note) => (
              <li className="note" key={note.id}>
                <div className="note-head">
                  {/* Authorship stays attributed even if the author later loses access. */}
                  <ActorLabel
                    className="note-author"
                    name={nameOf(directory, note.authorId)}
                    via={note.performedVia}
                    model={note.aiModel}
                  />
                  <span className="note-time">
                    <TimeAgo iso={note.createdAt} />
                  </span>
                </div>
                <p className="note-body">{note.body}</p>
              </li>
            ))}
          </ol>
        )}

        {mayAdd ? (
          <form onSubmit={onSubmit} className="form">
            <Field label="Add a note" htmlFor={`note-body-${ticket.id}`} error={error}>
              <textarea
                id={`note-body-${ticket.id}`}
                value={body}
                rows={3}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => {
                  setBody(event.target.value);
                  setError(null);
                }}
                placeholder="What you checked, what changed, what is next"
              />
            </Field>
            <div className="form-actions">
              <Button type="submit" size="sm" disabled={pendingKey !== null} loading={saving}>
                Add note
              </Button>
            </div>
          </form>
        ) : (
          <p className="callout">
            {ticket.status === 'resolved' || ticket.status === 'cancelled'
              ? 'This ticket is closed. An administrator can reopen it to continue the work.'
              : 'Only the owner, collaborators or an administrator can add notes.'}
          </p>
        )}
      </div>
    </section>
  );
}
