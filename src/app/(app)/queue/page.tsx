import Link from 'next/link';
import { loadQueue } from '@/lib/data/tickets';
import { PageHeader } from '@/components/Primitives';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'Open Queue — Edison Helpdesk' };

export default async function OpenQueuePage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const page = await loadQueue('open_queue', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="Open Queue"
        description="Unassigned requests anyone can claim. Claiming one makes you its primary owner and moves it to My Tickets."
        actions={
          <Link href="/tickets/new" className="btn btn-primary">
            New ticket
          </Link>
        }
      />
      <TicketListView
        page={page}
        allowClaim
        emptyTitle="The open queue is clear"
        emptyBody="Nothing is waiting to be claimed right now. New requests appear here as soon as they are recorded without an owner."
      />
    </>
  );
}
