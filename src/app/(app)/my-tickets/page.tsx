import Link from 'next/link';
import { loadQueue } from '@/lib/data/tickets';
import { PageHeader } from '@/components/Primitives';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'My Tickets — Edison Helpdesk' };

export default async function MyTicketsPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const page = await loadQueue('mine', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="My Tickets"
        description="Active tickets where you are the primary owner. You stay recorded as the owner even when a collaborator resolves the work."
        actions={
          <Link href="/tickets/new" className="btn btn-primary">
            New walk-in
          </Link>
        }
      />
      <TicketListView
        page={page}
        emptyTitle="You do not own any active tickets"
        emptyBody="Claim something from the Open Queue, or record a walk-in that is assigned to you."
      />
    </>
  );
}
