import { loadPeopleFacets } from '@/lib/data/people';
import { PageHeader } from '@/components/Primitives';
import { NewPersonForm } from '@/components/people/NewPersonForm';

export const metadata = { title: 'Add person — Edison Helpdesk' };

export default async function NewPersonPage() {
  const facets = await loadPeopleFacets();
  return (
    <div className="record-form-page">
      <PageHeader
        title="Add person"
        description="A student or member of staff who is not on the roster yet. Imported records are corrected the same way, from their own page."
      />
      <div className="panel">
        <div className="panel-body">
          <NewPersonForm departments={facets.departments} />
        </div>
      </div>
    </div>
  );
}
