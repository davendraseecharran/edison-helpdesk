'use client';

/**
 * A forwarded email, turned into the form.
 *
 * Half the walk-ins at this desk arrive as mail: a subject line, a sender,
 * three paragraphs and a signature block. Retyping that into four fields is the
 * most mechanical thing anybody does here, and the thing most often done badly
 * — the title becomes "email from Marcus" and the issue becomes the whole
 * thread including the disclaimer.
 *
 * Paste it here instead. The reading is `draftFromText`, which is pure and
 * works with no account and no network; the same function the assistant's
 * `draft_ticket_from_text` tool calls, so a draft is a draft whichever way it
 * was asked for.
 *
 * It shows what it read before it fills anything in. A form that rewrote itself
 * out of a paste would be a form nobody trusted with the second paste.
 */

import { useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { draftFromText, type TicketDraft } from '@/lib/intake/draft';
import '@/styles/lists.css';

export interface PasteToDraftProps {
  /** Applies what was read. The form decides which of the fields it will take. */
  onApply: (draft: TicketDraft) => void;
}

export function PasteToDraft({ onApply }: PasteToDraftProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const draft = text.trim() === '' ? null : draftFromText(text);
  const usable = draft !== null && (draft.title !== '' || draft.issue !== '');

  if (!open) {
    return (
      <button type="button" className="paste-draft-open" onClick={() => setOpen(true)}>
        <Icon icon={ClipboardPaste} size={14} />
        Draft from a pasted email
      </button>
    );
  }

  return (
    <div className="paste-draft">
      <label className="paste-draft-label" htmlFor="paste-draft-text">
        Paste the message. Nothing is filled in until you press Use this.
      </label>
      <textarea
        id="paste-draft-text"
        className="paste-draft-field"
        rows={5}
        value={text}
        autoFocus
        placeholder={'From: …\nSubject: …\n\nThe projector in 118 shows no signal.'}
        onChange={(event) => setText(event.target.value)}
      />
      {usable && draft ? (
        <dl className="paste-draft-read">
          {draft.title ? (
            <div>
              <dt>Title</dt>
              <dd>{draft.title}</dd>
            </div>
          ) : null}
          {draft.requesterQuery ? (
            <div>
              <dt>Requester</dt>
              <dd>{draft.requesterQuery}</dd>
            </div>
          ) : null}
          {draft.category ? (
            <div>
              <dt>Category</dt>
              <dd>{draft.category.replace(/_/g, ' ')}</dd>
            </div>
          ) : null}
          {draft.priority ? (
            <div>
              <dt>Priority</dt>
              <dd>{draft.priority}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <div className="paste-draft-actions">
        <Button
          size="sm"
          disabled={!usable}
          onClick={() => {
            if (!draft) return;
            onApply(draft);
            setText('');
            setOpen(false);
          }}
        >
          Use this
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setText('');
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
