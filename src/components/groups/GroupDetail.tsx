'use client';

/**
 * One group: who is in it, and the two ways to change that.
 *
 * The table is the roster as somebody would read it off a clipboard — name,
 * where in the school, the identifier that tells two people of one name apart,
 * and the short note that says what they are to THIS group ("Treasurer",
 * "regionals only"). The note is edited in the cell it lives in, because
 * opening a dialog to type one word is how a roster stops being kept.
 *
 * Deleting is an administrator's, and it asks first: the group goes and its
 * members go with it. Everything else here — renaming, adding, removing — is
 * open to every active account and can be put back by whoever undid it.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, X } from 'lucide-react';
import {
  deleteGroupAction,
  removeGroupMemberAction,
  setGroupMemberNoteAction,
  updateGroupAction,
} from '@/lib/data/group-actions';
import type { GroupDetail as GroupDetailData, GroupMember } from '@/lib/data/groups';
import { isAdmin } from '@/lib/auth/roles';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { AddPeoplePanel } from './AddPeoplePanel';
import { GroupDialog, type GroupValues } from './GroupDialog';
import '@/styles/groups.css';

/** The database cuts a note here, so the box does too. */
const NOTE_MAX = 80;

export function GroupDetail({ detail }: { detail: GroupDetailData }) {
  const { actor, pendingKey, run } = useRuntime();
  const router = useRouter();
  const { group, members } = detail;
  const admin = isAdmin(actor.roles);
  const busy = pendingKey !== null;

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function save(values: GroupValues) {
    const result = await run(
      'group:save',
      () => updateGroupAction(group.id, values.name, values.description),
      { inlineError: true },
    );
    return result;
  }

  async function remove(member: GroupMember) {
    await run(`group:remove:${member.id}`, () => removeGroupMemberAction(group.id, member.id));
  }

  const columns: Column<GroupMember>[] = [
    {
      key: 'name',
      header: 'Name',
      hideOnPhone: true,
      cell: (member) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/people/${member.id}`} className="dir-name row-link">
              {member.displayName}
            </Link>
          </span>
          <span className="dir-sub">{PERSON_KIND_LABELS[member.kind]}</span>
        </div>
      ),
    },
    {
      key: 'placement',
      header: 'Class or department',
      // Already the phone card's meta line, under the name.
      hideOnPhone: true,
      width: 200,
      cell: (member) =>
        member.groupLabel ?? <span className="dir-quiet">Not recorded</span>,
    },
    {
      key: 'id',
      header: 'OSIS or staff ID',
      mono: true,
      width: 160,
      cell: (member) => member.externalId || <span className="dir-quiet">None</span>,
    },
    {
      key: 'note',
      header: 'Note',
      width: 220,
      cell: (member) => (
        <MemberNote
          member={member}
          disabled={busy}
          onSave={(note) =>
            run(`group:note:${member.id}`, () =>
              setGroupMemberNoteAction(group.id, member.id, note),
            ).then(() => undefined)
          }
        />
      ),
    },
    {
      key: 'remove',
      header: 'Remove',
      align: 'right',
      width: 96,
      cell: (member) => (
        <Button
          size="sm"
          icon={X}
          aria-label={`Remove ${member.displayName} from ${group.name}`}
          title="Remove from the group"
          disabled={busy}
          loading={pendingKey === `group:remove:${member.id}`}
          onClick={() => remove(member)}
        />
      ),
    },
  ];

  return (
    <div className="ticket record group-page">
      <header className="ticket-head record-head">
        <div className="record-head-main">
          <div className="ticket-head-text">
            <div className="record-title-row">
              <h1 className="record-title">{group.name}</h1>
            </div>
            {group.description ? <p className="record-subtitle">{group.description}</p> : null}
            <div className="ticket-meta record-idents">
              <span className="ticket-meta-item">
                {group.memberCount} {group.memberCount === 1 ? 'person' : 'people'}
              </span>
              <span className="ticket-meta-item">
                Updated <TimeAgo iso={group.updatedAt} />
              </span>
            </div>
          </div>
        </div>
        <div className="btn-row record-actions">
          {/* PeopleActions slot */}
          <Button icon={Pencil} onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </Button>
          {admin ? (
            <Button
              icon={Trash2}
              variant="danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </header>

      <div className="stack group-stack">
        <section className="panel directory" aria-labelledby="group-members-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="group-members-heading">
              Members
            </h2>
            <span className="panel-aside">
              {members.length} {members.length === 1 ? 'person' : 'people'}
            </span>
          </div>
          {members.length === 0 ? (
            <p className="panel-empty">
              Nobody is in this group yet. Find somebody below, or paste the list
              you already have.
            </p>
          ) : (
            <DataTable
              columns={columns}
              rows={members}
              rowKey={(member) => member.id}
              caption={`People in ${group.name}`}
              cardTitle={(member) => (
                <Link href={`/people/${member.id}`} className="row-link">
                  {member.displayName}
                </Link>
              )}
              cardMeta={(member) =>
                [PERSON_KIND_LABELS[member.kind], member.groupLabel].filter(Boolean).join(', ')
              }
            />
          )}
        </section>

        <AddPeoplePanel groupId={group.id} memberIds={members.map((member) => member.id)} />
      </div>

      <GroupDialog
        key={`${group.name}:${group.description}`}
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit group"
        submitLabel="Save group"
        initial={{ name: group.name, description: group.description }}
        pending={pendingKey === 'group:save'}
        onSubmit={save}
      />

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete ${group.name}?`}
        description="The group goes, and so does its list of people. The people themselves stay in the directory."
        footer={
          <>
            <Button onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === 'group:delete'}
              onClick={() =>
                run('group:delete', () => deleteGroupAction(group.id)).then((result) => {
                  // The page this is on no longer has a record behind it, so
                  // the list replaces it rather than being pushed over it.
                  if (result.ok) router.replace('/groups');
                })
              }
            >
              Delete group
            </Button>
          </>
        }
      >
        <p className="muted">
          {group.memberCount === 0
            ? 'There is nobody in it.'
            : `${group.memberCount} ${group.memberCount === 1 ? 'person is' : 'people are'} in it.`}
        </p>
      </Dialog>
    </div>
  );
}

/**
 * The note beside one member, edited where it is read.
 *
 * It saves when the cell is left and when Enter is pressed, and not on every
 * keystroke: a roster is typed into with a class list in the other hand, and a
 * round trip per character would be the desk arguing with the typist. Escape
 * puts back what was there, which is the only undo a one-line field needs.
 */
function MemberNote({
  member,
  disabled,
  onSave,
}: {
  member: GroupMember;
  disabled: boolean;
  onSave: (note: string) => Promise<void>;
}) {
  const [value, setValue] = useState(member.note);
  // The server row wins whenever it changes under the field: somebody else's
  // edit, or this one landing.
  const [seen, setSeen] = useState(member.note);
  if (seen !== member.note) {
    setSeen(member.note);
    setValue(member.note);
  }

  function commit() {
    const next = value.trim();
    if (next === member.note) return;
    void onSave(next);
  }

  return (
    <input
      className="group-note-input"
      aria-label={`Note for ${member.displayName}`}
      value={value}
      maxLength={NOTE_MAX}
      disabled={disabled}
      placeholder="Add a note"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setValue(member.note);
        }
      }}
    />
  );
}
