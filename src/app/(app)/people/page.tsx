import { loadPeople, loadPeopleFacets } from '@/lib/data/people';
import { PageHeader } from '@/components/Primitives';
import { PeopleHeaderActions } from '@/components/people/PeopleHeaderActions';
import { PeopleList } from '@/components/people/PeopleList';
import { firstParam, toPeopleFilters, type PeopleSearchParams } from './search-params';

export const metadata = { title: 'People — Edison Helpdesk' };

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<PeopleSearchParams>;
}) {
  const params = await searchParams;
  const filters = toPeopleFilters(params);
  const [page, facets] = await Promise.all([loadPeople(filters), loadPeopleFacets()]);
  // A skills officer who followed a ticket link lands here. One line, so the
  // move reads as a rule rather than as something that went wrong.
  const movedFromTickets = firstParam(params.moved) === 'tickets';

  return (
    <>
      <PageHeader
        title="People"
        description="Students and staff on the roster: who is holding which device, and who has asked for help."
        actions={<PeopleHeaderActions />}
      />
      {movedFromTickets ? (
        <p className="callout">
          Tickets are NetRider work. Your account works the student and staff directory, so we
          brought you here instead.
        </p>
      ) : null}
      <PeopleList page={page} facets={facets} />
    </>
  );
}
