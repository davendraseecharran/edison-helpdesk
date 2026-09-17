import { loadActor } from '@/lib/auth/session';
import { canExportDirectory, canWorkTickets } from '@/lib/auth/roles';
import { loadPeople } from '@/lib/data/people';
import { loadPreferences } from '@/lib/data/preferences';
import { PageHeader } from '@/components/Primitives';
import { PeopleHeaderActions } from '@/components/people/PeopleHeaderActions';
import { PeopleList } from '@/components/people/PeopleList';
import { toPeopleFilters, type PeopleSearchParams } from './search-params';

export const metadata = { title: 'People — Edison Helpdesk' };

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<PeopleSearchParams>;
}) {
  const filters = toPeopleFilters(await searchParams);
  // The actor is memoised for the render pass and the layout above has already
  // asked for it, so awaiting it first costs nothing and decides what the list
  // has to read: a technician's last two columns need the ticket counts, a
  // skills officer's need the rosters, and neither pays for the other.
  const actor = await loadActor();
  const roles = actor.kind === 'active' ? actor.account.roles : [];
  const ticketWorker = canWorkTickets(roles);
  const [page, preferences] = await Promise.all([
    loadPeople(filters, { worksTickets: ticketWorker }),
    loadPreferences(),
  ]);
  const canExport = actor.kind === 'active' && canExportDirectory(roles);

  return (
    <>
      <PageHeader
        title="People"
        description="Students and staff on the roster: who is holding which device, and who has asked for help."
        actions={
          <PeopleHeaderActions
            kind={filters.kind}
            total={page.total}
            gmailMode={preferences.gmailMode}
            canExport={canExport}
          />
        }
      />
      <PeopleList
        page={page}
        gmailMode={preferences.gmailMode}
        canExport={canExport}
        ticketWorker={ticketWorker}
      />
    </>
  );
}
