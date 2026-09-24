import { loadWorkflowRuns, loadWorkflowShortcuts } from '@/lib/data/workflows';
import { PageHeader } from '@/components/Primitives';
import { WorkflowHub } from '@/components/workflows/WorkflowHub';

export const metadata = { title: 'Workflows — Edison Helpdesk' };

/**
 * `/workflows` — the repetitive device jobs, one tap each.
 *
 * Five tiles, the desk's saved runs, and the last few runs anybody finished.
 */
export default async function WorkflowsPage() {
  const [shortcuts, runs] = await Promise.all([loadWorkflowShortcuts(), loadWorkflowRuns(8)]);
  return (
    <>
      <PageHeader
        title="Workflows"
        description="The jobs you do with a cart and a scanner. Pick one, say where, then scan."
      />
      <WorkflowHub shortcuts={shortcuts} runs={runs} />
    </>
  );
}
