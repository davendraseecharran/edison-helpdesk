'use client';

/**
 * The Workflows hub: five jobs, the desk's saved runs, and what was done lately.
 *
 * The tiles are the jobs. The saved runs are the same jobs with the target
 * already chosen — "Load Cart 3" — so a NetRider at the cart taps once and is
 * scanning. Recent runs say who did what, and offer to do it again.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { showToast } from '@/components/ui/shadcn/sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { deleteWorkflowShortcutAction } from '@/lib/data/workflow-actions';
import { WORKFLOW_ICONS } from './icons';
import {
  rerunHref,
  runCounts,
  runTitle,
  shortcutHref,
  workflowFor,
  WORKFLOWS,
  type WorkflowRun,
  type WorkflowShortcut,
} from '@/lib/domain/workflows';

function shortcutDetail(shortcut: WorkflowShortcut): string {
  const title = workflowFor(shortcut.kind).title;
  switch (shortcut.kind) {
    case 'move':
    case 'audit':
      return `${title}, ${shortcut.location}`;
    case 'status':
      return `${title}, ${shortcut.status}`;
    case 'collect':
      return [title, shortcut.status || 'Available', shortcut.location].filter(Boolean).join(', ');
  }
}

export function WorkflowHub({ shortcuts, runs }: { shortcuts: WorkflowShortcut[]; runs: WorkflowRun[] }) {
  const router = useRouter();
  const [removing, setRemoving] = useState<WorkflowShortcut | null>(null);
  const [pending, setPending] = useState(false);

  async function remove() {
    if (!removing) return;
    setPending(true);
    const result = await deleteWorkflowShortcutAction(removing.id);
    setPending(false);
    if (!result.ok) {
      showToast('error', result.error ?? 'The shortcut could not be deleted.');
      return;
    }
    setRemoving(null);
    showToast('success', result.message ?? 'Shortcut deleted.');
    router.refresh();
  }

  return (
    <div className="wf-hub">
      <ul className="wf-tiles" aria-label="Workflows">
        {WORKFLOWS.map((workflow) => (
          <li key={workflow.kind}>
            <Link href={`/workflows/${workflow.slug}`} className="wf-tile pressable">
              <span className="wf-tile-icon" aria-hidden="true">
                <Icon icon={WORKFLOW_ICONS[workflow.kind]} size={20} weight="medium" />
              </span>
              <span className="wf-tile-text">
                <span className="wf-tile-title">{workflow.title}</span>
                <span className="wf-tile-description">{workflow.description}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="wf-section" aria-labelledby="wf-shortcuts-title">
        <h2 id="wf-shortcuts-title" className="wf-section-title">
          Saved runs
        </h2>
        {shortcuts.length === 0 ? (
          <p className="wf-section-empty">
            Finish a run and save it, and it shows here for the whole desk, one tap to start.
          </p>
        ) : (
          <ul className="wf-shortcuts">
            {shortcuts.map((shortcut) => (
              <li key={shortcut.id} className="wf-shortcut">
                <Link href={shortcutHref(shortcut)} className="wf-shortcut-link pressable">
                  <Icon icon={WORKFLOW_ICONS[shortcut.kind]} size={16} weight="medium" />
                  <span className="wf-shortcut-text">
                    <span className="wf-shortcut-name">{shortcut.name}</span>
                    <span className="wf-shortcut-detail">{shortcutDetail(shortcut)}</span>
                  </span>
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={MoreHorizontal}
                      className="wf-shortcut-more"
                      aria-label={`More for ${shortcut.name}`}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(shortcut)}>
                      Delete shortcut
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wf-section" aria-labelledby="wf-recent-title">
        <h2 id="wf-recent-title" className="wf-section-title">
          Recent runs
        </h2>
        {runs.length === 0 ? (
          <EmptyState title="No runs yet">
            When somebody finishes a workflow it is listed here, with what it did.
          </EmptyState>
        ) : (
          <ul className="wf-runs">
            {runs.map((run) => {
              const again = rerunHref(run);
              return (
                <li key={run.id} className="wf-run-row">
                  <span className="wf-run-row-icon" aria-hidden="true">
                    <Icon icon={WORKFLOW_ICONS[run.kind]} size={16} />
                  </span>
                  <span className="wf-run-row-text">
                    <span className="wf-run-row-title">{runTitle(run)}</span>
                    <span className="wf-run-row-meta">
                      {runCounts(run)}. {run.runBy}
                      {run.performedVia === 'ai' ? '’s assistant' : ''}, <TimeAgo iso={run.finishedAt} />
                    </span>
                  </span>
                  {again ? (
                    <Link href={again} className="btn btn-ghost btn-sm wf-run-again">
                      Run again
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Delete ${removing?.name ?? 'this shortcut'}?`}
        description="It goes for everybody on the desk. Runs already done are kept."
        footer={
          <>
            <Button onClick={() => setRemoving(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => void remove()}>
              Delete shortcut
            </Button>
          </>
        }
      >
        <p className="wf-dialog-note">{removing ? shortcutDetail(removing) : ''}</p>
      </Dialog>
    </div>
  );
}
