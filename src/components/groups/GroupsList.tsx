'use client';

/**
 * Every roster the school keeps.
 *
 * There are tens of these rather than thousands, so there is no filter bar and
 * no paging: the whole list is the screen, ordered by name, and the thing
 * somebody is scanning for — how many people are in it, and whether it has been
 * touched since they last looked — is in the two columns beside the name.
 */

import Link from 'next/link';
import type { GroupSummary } from '@/lib/data/groups';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { NewGroupButton } from './NewGroupButton';
import '@/styles/groups.css';

export function GroupsList({ groups }: { groups: GroupSummary[] }) {
  const columns: Column<GroupSummary>[] = [
    {
      key: 'name',
      header: 'Group',
      hideOnPhone: true,
      cell: (group) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/groups/${group.id}`} className="dir-name row-link">
              {group.name}
            </Link>
          </span>
          {group.description ? <span className="dir-sub">{group.description}</span> : null}
        </div>
      ),
    },
    {
      key: 'members',
      header: 'People',
      align: 'right',
      width: 96,
      cell: (group) =>
        group.memberCount > 0 ? group.memberCount : <span className="dir-quiet">0</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      width: 160,
      cell: (group) => (
        <span className="dir-age">
          <TimeAgo iso={group.updatedAt} />
        </span>
      ),
    },
  ];

  return (
    <section className="panel directory">
      {groups.length === 0 ? (
        <EmptyState title="No groups yet" action={<NewGroupButton />}>
          A group is a list of people you keep coming back to: the chapter, the
          officers, a competition team, a cart. Start one, then add people by
          name or by pasting a column of OSIS numbers.
        </EmptyState>
      ) : (
        <DataTable
          columns={columns}
          rows={groups}
          rowKey={(group) => group.id}
          caption="Groups"
          settle
          cardTitle={(group) => (
            <Link href={`/groups/${group.id}`} className="row-link">
              {group.name}
            </Link>
          )}
          cardMeta={(group) => group.description || null}
        />
      )}
    </section>
  );
}
