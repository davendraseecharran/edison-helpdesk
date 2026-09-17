import { loadGroupEvent } from '@/lib/data/group-events';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { EventRoll } from '@/components/groups/EventRoll';

export const metadata = { title: 'Event — Edison Helpdesk' };

export default async function GroupEventPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id, eventId } = await params;
  const detail = await loadGroupEvent(id, eventId);

  if (!detail) {
    // The same answer for an event that was deleted, an id that never existed
    // and an event that belongs to a different group: a URL cannot be edited
    // into somebody else's register.
    return (
      <div className="panel">
        <EmptyState
          title="Event not available"
          action={<ButtonLink href={`/groups/${id}`}>Back to the group</ButtonLink>}
        >
          There is no event at this address. It may have been deleted, or the
          link may be wrong.
        </EmptyState>
      </div>
    );
  }

  return <EventRoll detail={detail} />;
}
