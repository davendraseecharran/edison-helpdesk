import { loadPerson, loadStaffDirectoryOptions } from '@/lib/data/people';
import { loadDeviceStatuses } from '@/lib/data/devices';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { PersonDetail } from '@/components/people/PersonDetail';

export const metadata = { title: 'Person — Edison Helpdesk' };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, options, statuses] = await Promise.all([
    loadPerson(id),
    loadStaffDirectoryOptions(),
    loadDeviceStatuses(),
  ]);

  if (!detail) {
    // Identical whether the record is missing or not visible to this account.
    return (
      <div className="panel">
        <EmptyState
          title="Person not available"
          action={<ButtonLink href="/people">Back to people</ButtonLink>}
        >
          There is no directory record at this address. It may have been removed, or the link
          may be wrong.
        </EmptyState>
      </div>
    );
  }

  return (
    <PersonDetail
      detail={detail}
      departments={options.departments}
      roles={options.roles}
      statuses={statuses}
    />
  );
}
