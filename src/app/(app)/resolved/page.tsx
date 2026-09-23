import { loadQueue } from '@/lib/data/tickets';
import { loadActor, requireTicketWorker } from '@/lib/auth/session';
import { requestTime } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { ImportSheetButton } from '@/components/ticket/ImportSheetButton';
import { ResolvedAnalyticsLink } from '@/components/ticket/ResolvedAnalyticsLink';
import { TicketListView } from '@/components/TicketListView';
import type { QueueSearchParams } from '../search-params';
import { toFilters } from '../search-params';

export const metadata = { title: 'Resolved — Edison Helpdesk' };

export default async function ResolvedPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams & { import?: string | string[] }>;
}) {
  await requireTicketWorker();
  const params = await searchParams;
  const [page, actor] = await Promise.all([loadQueue('closed', toFilters(params)), loadActor()]);
  const admin = actor.kind === 'active' && actor.account.role === 'admin';

  return (
    <>
      <PageHeader
        title="Resolved"
        description={
          admin
            ? 'Every resolved and cancelled ticket, with the solution, the resolver and the original owner kept apart. Cancellations never count as resolutions.'
            : 'Resolved and cancelled tickets you owned or helped with. Work belonging to other NetRiders is not listed here.'
        }
        /*
          The counting, one press from the list it counts, and the desk's old
          sheet, in. Both are every ticket worker's: the import takes the same
          role the assistant's import does, and the database holds it.
        */
        actions={
          <>
            <ImportSheetButton openOnLoad={params.import === '1'} />
            <ResolvedAnalyticsLink />
          </>
        }
      />
      <TicketListView
        page={page}
        now={requestTime()}
        history
        showOwner={admin}
        emptyTitle="No closed tickets yet"
        emptyBody="Resolved and cancelled tickets stay here as history, with their notes and authorship intact."
      />
    </>
  );
}
