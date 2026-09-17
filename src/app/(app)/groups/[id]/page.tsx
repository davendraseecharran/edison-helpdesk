import { loadGroupEvents } from '@/lib/data/group-events';
import { loadGroup } from '@/lib/data/groups';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { GroupDetail } from '@/components/groups/GroupDetail';

export const metadata = { title: 'Group — Edison Helpdesk' };

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, events] = await Promise.all([loadGroup(id), loadGroupEvents(id)]);

  if (!detail) {
    // Identical whether the group is gone or was never there: a deleted group
    // and a mistyped link are the same answer to whoever followed it.
    return (
      <div className="panel">
        <EmptyState
          title="Group not available"
          action={<ButtonLink href="/groups">Back to groups</ButtonLink>}
        >
          There is no group at this address. It may have been deleted, or the
          link may be wrong.
        </EmptyState>
      </div>
    );
  }

  return <GroupDetail detail={detail} events={events} />;
}
