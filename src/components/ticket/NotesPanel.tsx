'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { addNoteAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';

export function NotesPanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayAdd = canContribute(ticket, actor);
  const key = `note:${ticket.id}`;
  const saving = pendingKey === key;

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
    <div className="card">
      <div className="card-header">
        <h2>Work notes</h2>
        <span className="small subtle">
          {detail.notes.length} {detail.notes.length === 1 ? 'note' : 'notes'}
        </span>
      </div>
      <div className="card-body stack">
        {detail.notes.length === 0 ? (
          <p className="small muted">No work notes yet.</p>
        ) : (
          detail.notes.map((note) => (
            <article className="note" key={note.id}>
              <div className="note-head">
                {/* Authorship stays attributed even if the author later loses access. */}
                <span className="note-author">{nameOf(directory, note.authorId)}</span>
                <span className="timeline-time">
                  <TimeAgo iso={note.createdAt} />
                </span>
              </div>
              <p className="note-body">{note.body}</p>
            </article>
          ))
        )}

        {mayAdd ? (
          <form onSubmit={onSubmit} className="stack-sm">
            <Field label="Add a work note" htmlFor={`note-body-${ticket.id}`} error={error}>
              <textarea
                id={`note-body-${ticket.id}`}
                value={body}
                rows={3}
                aria-invalid={error ? 'true' : undefined}
                onChange={(event) => {
                  setBody(event.target.value);
                  setError(null);
                }}
                placeholder="What you checked, what changed, what is next…"
              />
            </Field>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Saving…' : 'Add note'}
              </button>
            </div>
          </form>
        ) : (
          <p className="notice">
            {ticket.status === 'resolved' || ticket.status === 'cancelled'
              ? 'This ticket is closed. An administrator can reopen it to continue the work.'
              : 'Only the primary owner, collaborators, or an administrator can add notes.'}
          </p>
        )}
      </div>
    </div>
  );
}
