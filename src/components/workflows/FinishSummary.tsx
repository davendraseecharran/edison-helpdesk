'use client';

/**
 * The end of a run: what happened, and the three things somebody does next.
 *
 * Copy it (into a ticket, a message to the teacher), put it all back, or keep
 * it as a one-tap shortcut for the next time this cart comes round. Putting it
 * all back asks first and says how many.
 */

import { useState, type FormEvent } from 'react';
import { BookmarkPlus, Copy, RotateCcw } from 'lucide-react';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { showToast } from '@/components/ui/shadcn/sonner';
import { saveWorkflowShortcutAction } from '@/lib/data/workflow-actions';
import {
  defaultShortcutName,
  SHORTCUT_NAME_MAX,
  type WorkflowKind,
  type WorkflowTarget,
} from '@/lib/domain/workflows';
import { formatElapsed, type SessionCounts } from '@/lib/workflows/session';

export interface FinishSummaryProps {
  kind: WorkflowKind;
  target: WorkflowTarget;
  headline: string;
  counts: SessionCounts;
  /** Said instead of done, skipped and errors, where those are not the story. */
  countsLine?: string;
  elapsedMs: number;
  undoable: number;
  undoingAll: boolean;
  summary: () => string;
  onUndoAll: () => Promise<void>;
  onKeepScanning: () => void;
  onNewRun: () => void;
}

export function FinishSummary({
  kind,
  target,
  headline,
  counts,
  countsLine,
  elapsedMs,
  undoable,
  undoingAll,
  summary,
  onUndoAll,
  onKeepScanning,
  onNewRun,
}: FinishSummaryProps) {
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(() => (kind === 'handout' ? '' : defaultShortcutName(kind, target)));
  const [error, setError] = useState<string | null>(null);

  const parts = [`${counts.done} done`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.errors > 0) parts.push(`${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'}`);

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary());
      showToast('success', 'Summary copied.');
    } catch {
      showToast('error', 'The clipboard is not available here. Select the list and copy it instead.');
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (kind === 'handout') return;
    setSaving(true);
    const result = await saveWorkflowShortcutAction({
      name,
      kind,
      location: target.location,
      status: target.status,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? 'The shortcut could not be saved.');
      return;
    }
    setSaved(true);
    setSaveOpen(false);
    showToast('success', result.message ?? 'Shortcut saved.');
  }

  return (
    <section className="wf-finish panel" aria-labelledby="wf-finish-title">
      <div className="wf-finish-text">
        <h2 id="wf-finish-title" className="wf-finish-title">
          {headline}
        </h2>
        <p className="wf-finish-counts">
          {countsLine ?? parts.join(', ')} in <span className="num">{formatElapsed(elapsedMs)}</span>.
        </p>
      </div>
      <div className="wf-finish-actions">
        <Button icon={Copy} onClick={() => void copy()}>
          Copy summary
        </Button>
        {undoable > 0 ? (
          <Button icon={RotateCcw} loading={undoingAll} onClick={() => setConfirmUndo(true)}>
            Undo all
          </Button>
        ) : null}
        {kind !== 'handout' ? (
          <Button icon={BookmarkPlus} disabled={saved} onClick={() => setSaveOpen(true)}>
            {saved ? 'Saved as a shortcut' : 'Save as shortcut'}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onKeepScanning}>
          Keep scanning
        </Button>
        <Button variant="primary" onClick={onNewRun}>
          New run
        </Button>
      </div>

      <Dialog
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        title={`Put ${undoable === 1 ? '1 machine' : `${undoable} machines`} back?`}
        description="Each goes back to where it was before this run, unless somebody changed it since."
        footer={
          <>
            <Button onClick={() => setConfirmUndo(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus=""
              onClick={() => {
                setConfirmUndo(false);
                void onUndoAll();
              }}
            >
              Undo all
            </Button>
          </>
        }
      >
        <p className="wf-dialog-note">A machine that has moved since is left alone and marked in the list.</p>
      </Dialog>

      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save as a shortcut"
        description="It appears on Workflows for everybody on the desk, one tap to start."
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="wf-save-shortcut" variant="primary" loading={saving}>
              Save shortcut
            </Button>
          </>
        }
      >
        <form id="wf-save-shortcut" className="form" onSubmit={save} noValidate>
          <Field label="Name" htmlFor="wf-shortcut-name" error={error}>
            <input
              id="wf-shortcut-name"
              type="text"
              value={name}
              maxLength={SHORTCUT_NAME_MAX}
              data-autofocus=""
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </form>
      </Dialog>
    </section>
  );
}
