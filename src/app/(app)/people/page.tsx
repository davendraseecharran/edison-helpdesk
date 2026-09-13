import { loadPeople, loadPeopleFacets } from '@/lib/data/people';
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
  const [page, facets] = await Promise.all([loadPeople(filters), loadPeopleFacets()]);

  return (
    <>
      <PageHeader
        title="People"
        description="Students and staff on the roster: who is holding which device, and who has asked for help."
        actions={<PeopleHeaderActions />}
      />
      <PeopleList page={page} facets={facets} />
    </>
  );
}
