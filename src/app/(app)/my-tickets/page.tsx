import { loadQueue } from '@/lib/data/tickets';
import { requestTime } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';
import { requireTicketWorker } from '@/lib/auth/session';

export const metadata = { title: 'My tickets — Edison Helpdesk' };

export default async function MyTicketsPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  await requireTicketWorker();
  const page = await loadQueue('mine', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="My tickets"
        description="Active tickets you own. You stay recorded as the owner even when a collaborator resolves the work."
      />
      <TicketListView
        page={page}
        now={requestTime()}
        emptyTitle="You do not own any active tickets"
        emptyBody="Claim something from the queue, or record a walk-in that is assigned to you."
        emptyAction={<ButtonLink href="/queue">Open the queue</ButtonLink>}
      />
    </>
  );
}
