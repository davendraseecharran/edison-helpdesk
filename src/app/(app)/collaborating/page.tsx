import { loadQueue } from '@/lib/data/tickets';
import { requestTime } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'Collaborating — Edison Helpdesk' };

export default async function CollaboratingPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const page = await loadQueue('collaborating', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="Collaborating"
        description="Active tickets someone else owns where you were added to help. You can add notes and devices, log time, and resolve them."
      />
      <TicketListView
        page={page}
        now={requestTime()}
        showOwner
        emptyTitle="You are not collaborating on any active tickets"
        emptyBody="An owner or an administrator can add you to a ticket when they need help with it."
      />
    </>
  );
}
