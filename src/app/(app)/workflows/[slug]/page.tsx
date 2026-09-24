import { notFound } from 'next/navigation';
import { loadDeviceFacets, loadDeviceStatuses } from '@/lib/data/devices';
import { targetFromParams, workflowBySlug } from '@/lib/domain/workflows';
import { WorkflowRunner } from '@/components/workflows/WorkflowRunner';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const workflow = workflowBySlug((await params).slug);
  return { title: `${workflow?.title ?? 'Workflow'} — Edison Helpdesk` };
}

/**
 * `/workflows/<slug>` — one run. `?location=` and `?status=` say what it is
 * aimed at, which is how a shortcut and "run again" skip the first step.
 */
export default async function WorkflowRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const workflow = workflowBySlug((await params).slug);
  if (!workflow) notFound();

  const target = targetFromParams(await searchParams);
  const [facets, statuses] = await Promise.all([loadDeviceFacets(), loadDeviceStatuses()]);

  return (
    <WorkflowRunner
      kind={workflow.kind}
      initialTarget={target}
      locations={facets.locations}
      statuses={statuses}
    />
  );
}
