import { loadGroups } from '@/lib/data/groups';
import { PageHeader } from '@/components/Primitives';
import { GroupsList } from '@/components/groups/GroupsList';
import { NewGroupButton } from '@/components/groups/NewGroupButton';

export const metadata = { title: 'Groups — Edison Helpdesk' };

export default async function GroupsPage() {
  const groups = await loadGroups();

  return (
    <>
      <PageHeader
        title="Groups"
        description="The rosters the chapter and the desk keep: members, officers, a competition team, a cart."
        actions={<NewGroupButton />}
      />
      <GroupsList groups={groups} />
    </>
  );
}
