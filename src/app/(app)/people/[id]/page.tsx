import { loadPeopleFacets, loadPerson } from '@/lib/data/people';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { PersonDetail } from '@/components/people/PersonDetail';

export const metadata = { title: 'Person — Edison Helpdesk' };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, facets] = await Promise.all([loadPerson(id), loadPeopleFacets()]);

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

  return <PersonDetail detail={detail} departments={facets.departments} />;
}
