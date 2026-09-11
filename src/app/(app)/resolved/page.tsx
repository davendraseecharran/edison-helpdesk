import { loadQueue } from '@/lib/data/tickets';
import { loadActor } from '@/lib/auth/session';
import { PageHeader } from '@/components/Primitives';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'Resolved — Edison Helpdesk' };

export default async function ResolvedPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const [page, actor] = await Promise.all([
    loadQueue('closed', toFilters(await searchParams)),
    loadActor(),
  ]);
  const admin = actor.kind === 'active' && actor.account.role === 'admin';

  return (
    <>
      <PageHeader
        title="Resolved"
        description={
          admin
            ? 'Every resolved and cancelled ticket, with the solution, the resolver, and the original owner preserved.'
            : 'Resolved and cancelled tickets you owned or helped with. Work belonging to other technicians is not listed here.'
        }
      />
      <TicketListView
        page={page}
        history
        showOwner={admin}
        emptyTitle="No closed tickets yet"
        emptyBody="Resolved and cancelled tickets stay here as history, with their notes and authorship intact."
        notice={
          <p className="notice">
            History keeps the primary owner and the resolver separately, so a ticket finished by a
            collaborator still shows who owned it. Cancelled tickets are never counted as
            resolutions.
          </p>
        }
      />
    </>
  );
}
