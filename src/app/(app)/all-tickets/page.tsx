import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadQueue } from '@/lib/data/tickets';
import { loadActor } from '@/lib/auth/session';
import { PageHeader } from '@/components/Primitives';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'All Tickets — Edison Helpdesk' };

export default async function AllTicketsPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const actor = await loadActor();
  // Administrator-only route. The database would return nothing for a
  // technician anyway, but sending them away is the honest response.
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    redirect('/queue');
  }

  const page = await loadQueue('all', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="All Tickets"
        description="Every ticket regardless of owner or status. Filter by owner to see one technician's workload, or by status to audit the day."
        actions={
          <Link href="/tickets/new" className="btn btn-primary">
            New ticket
          </Link>
        }
      />
      <TicketListView
        page={page}
        showOwner
        allowClaim
        emptyTitle="No tickets recorded"
        emptyBody="Record the first request from the intake form."
      />
    </>
  );
}
