import { loadStaffDirectoryOptions } from '@/lib/data/people';
import { PageHeader } from '@/components/Primitives';
import { NewPersonForm } from '@/components/people/NewPersonForm';
import { kindParam, type PeopleSearchParams } from '../search-params';

export const metadata = { title: 'Add person — Edison Helpdesk' };

export default async function NewPersonPage({
  searchParams,
}: {
  searchParams: Promise<PeopleSearchParams>;
}) {
  const [params, options] = await Promise.all([searchParams, loadStaffDirectoryOptions()]);
  const kind = kindParam(params.kind);
  return (
    <div className="record-form-page">
      <PageHeader
        title="Add person"
        description="A student or member of staff who is not on the roster yet. Records already on it are corrected the same way, from their own page."
      />
      <div className="panel">
        <div className="panel-body">
          <NewPersonForm kind={kind} departments={options.departments} roles={options.roles} />
        </div>
      </div>
    </div>
  );
}
