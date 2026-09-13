import { loadQueue } from '@/lib/data/tickets';
import { requestTime } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'Queue — Edison Helpdesk' };

export default async function OpenQueuePage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const page = await loadQueue('open_queue', toFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="Queue"
        description="Unassigned requests anyone can claim. Claiming one makes you its owner and moves it to My tickets."
      />
      <TicketListView
        page={page}
        now={requestTime()}
        allowClaim
        emptyTitle="The queue is clear"
        emptyBody="Nothing is waiting to be claimed. New requests recorded without an owner appear here."
        emptyAction={<ButtonLink href="/tickets/new">New ticket</ButtonLink>}
      />
    </>
  );
}
