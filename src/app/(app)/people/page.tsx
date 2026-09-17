import { loadActor } from '@/lib/auth/session';
import { canExportDirectory } from '@/lib/auth/roles';
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
  // The actor and the settings are both memoised for the render pass, so this
  // costs nothing beyond what the layout above already asked for.
  const [page, preferences, actor] = await Promise.all([
    loadPeople(filters),
    loadPreferences(),
    loadActor(),
  ]);
  const canExport = actor.kind === 'active' && canExportDirectory(actor.account.roles);

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
      <PeopleList page={page} gmailMode={preferences.gmailMode} canExport={canExport} />
    </>
  );
}
