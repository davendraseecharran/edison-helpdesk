'use client';

/**
 * One group: who is in it, what each of them still owes, and what it has done.
 *
 * The table is the roster as somebody would read it off a clipboard — name,
 * where in the school, the identifier that tells two people of one name apart,
 * the short note that says what they are to THIS group ("Treasurer",
 * "regionals only"), and one tick box per checklist column. The note and the
 * boxes are edited in the cells they live in, because opening a dialog to type
 * one word is how a roster stops being kept.
 *
 * The boxes paint: press on one and drag down the column and every box crossed
 * takes the first one's new state — the whole table ticked for "Paid dues" in
 * one stroke — and shift-click fills a range. Each tick shows at once and is
 * saved behind it; one the database refuses springs back with a message.
 *
 * The one filter is "missing" — everybody who has NOT been ticked for a column
 * — because that is the only question a checklist is ever asked. It is applied
 * here rather than in the database: the whole roster is already on the page,
 * and a round trip to hide rows would be slower than the eye.
 *
 * Deleting is an administrator's, and it asks first: the group goes and its
 * members go with it. Everything else here — renaming, adding, removing,
 * ticking, taking a register — is open to every active account.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ListChecks, Pencil, Trash2, X } from 'lucide-react';
import {
  deleteGroupAction,
  removeGroupMemberAction,
  setGroupMemberNoteAction,
  setGroupMarkAction,
  updateGroupAction,
} from '@/lib/data/group-actions';
import type { GroupDetail as GroupDetailData, GroupMember } from '@/lib/data/groups';
import type { GroupEventSummary } from '@/lib/data/group-events';
import { isAdmin } from '@/lib/auth/roles';
import { GROUP_NOTE_MAX } from '@/lib/domain/groups';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { PeopleActions } from '@/components/people/PeopleActions';
import type { GmailMode } from '@/lib/domain/preferences';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { usePaintSelect } from '@/components/ui/useSelection';
import { AddPeoplePanel } from './AddPeoplePanel';
import { FieldsManager } from './FieldsManager';
import { GroupDialog, type GroupValues } from './GroupDialog';
import { GroupEvents } from './GroupEvents';
import type { CheckinState } from '@/lib/domain/checkin';
import '@/styles/groups.css';

export function GroupDetail({
  detail,
  events,
  checkins = {},
  gmailMode = 'cc',
}: {
  detail: GroupDetailData;
  events: GroupEventSummary[];
  /** Which events take self check-in, and whether each is open today. */
  checkins?: Record<string, CheckinState>;
  /** How this account addresses a Gmail link. Their setting, not this screen's. */
  gmailMode?: GmailMode;
}) {
  const { actor, pendingKey, run, notify } = useRuntime();
  const router = useRouter();
  const { group, members, fields, marks } = detail;
  const admin = isAdmin(actor.roles);
  const busy = pendingKey !== null;

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [managingFields, setManagingFields] = useState(false);
  /** A field id, or '' for everybody. The only question a checklist is asked. */
  const [missing, setMissing] = useState('');

  const ticked = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [requesterId, fieldIds] of Object.entries(marks)) {
      map.set(requesterId, new Set(fieldIds));
    }
    return map;
  }, [marks]);

  const shown = useMemo(
    () =>
      missing === ''
        ? members
        : members.filter((member) => !(ticked.get(member.id)?.has(missing) ?? false)),
    [members, missing, ticked],
  );

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

  /*
   * Ticks shown before the database has answered, keyed `member|field`. They
   * are dropped when the server's marks arrive, which is after the last save
   * of a stroke and a short pause, so rows under the "missing" filter do not
   * vanish from under a paint that is still moving.
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [marksSeen, setMarksSeen] = useState(marks);
  if (marksSeen !== marks) {
    setMarksSeen(marks);
    setOverrides(new Map());
  }
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  function isMarked(cell: string): boolean {
    const override = overrides.get(cell);
    if (override !== undefined) return override;
    const [memberId, fieldId] = cell.split('|');
    return ticked.get(memberId)?.has(fieldId) ?? false;
  }

  function applyMarks(cells: readonly string[], checked: boolean) {
    const changing = cells.filter((cell) => isMarked(cell) !== checked);
    if (changing.length === 0) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const cell of changing) next.set(cell, checked);
      return next;
    });
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    void Promise.all(
      changing.map(async (cell) => {
        const [memberId, fieldId] = cell.split('|');
        const result = await setGroupMarkAction(fieldId, memberId, checked).catch(() => null);
        return result?.ok ? null : { cell, error: result?.error };
      }),
    ).then((outcomes) => {
      const failed = outcomes.filter((outcome) => outcome !== null);
      if (failed.length > 0) {
        setOverrides((prev) => {
          const next = new Map(prev);
          for (const { cell } of failed) next.set(cell, !checked);
          return next;
        });
        notify(
          'error',
          failed[0].error ??
            `${failed.length} ${failed.length === 1 ? 'tick was' : 'ticks were'} not saved. Try again.`,
        );
      }
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 600);
    });
  }

  // Column by column, so a shift-click range runs down one column.
  const cellOrder = useMemo(
    () => fields.flatMap((field) => shown.map((member) => `${member.id}|${field.id}`)),
    [fields, shown],
  );
  const paint = usePaintSelect({ order: cellOrder, isOn: isMarked, apply: applyMarks });

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
    // One column per checklist field, in the order the manager put them. They
    // stay on the phone card: a tick box is the whole reason the column exists,
    // and hiding it on the device the roster is kept on would be the wrong half
    // to drop.
    ...fields.map((field) => ({
      key: `field:${field.id}`,
      header: field.name,
      width: 120,
      cell: (member: GroupMember) => {
        const cell = `${member.id}|${field.id}`;
        return (
          <label className="row-check field-check" {...paint.boxProps(cell)}>
            <input
              type="checkbox"
              checked={isMarked(cell)}
              aria-label={`${field.name} for ${member.displayName}`}
              onChange={(event) => paint.change(cell, event.target.checked)}
            />
          </label>
        );
      },
    })),
    {
      key: 'remove',
      header: 'Remove',
      align: 'right' as const,
      width: 96,
      cell: (member: GroupMember) => (
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
          {/* Everyone in the group, to Gmail, to the clipboard, or out as a file. */}
          <PeopleActions
            people={members.map((member) => ({
              id: member.id,
              displayName: member.displayName,
              email: member.email,
              externalId: member.externalId,
              kind: member.kind,
            }))}
            label={group.name}
            gmailMode={gmailMode}
            exportHref={`/groups/${group.id}/export`}
          />
          <Button icon={ListChecks} onClick={() => setManagingFields(true)} disabled={busy}>
            Columns
          </Button>
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
        <section
          className="panel directory"
          aria-labelledby="group-members-heading"
          data-painting={paint.painting || undefined}
        >
          <div className="panel-head">
            <h2 className="panel-title" id="group-members-heading">
              Members
            </h2>
            <div className="panel-head-end">
              {fields.length > 0 ? (
                <Select
                  id="group-missing"
                  aria-label="Show only people missing a column"
                  className="group-missing"
                  value={missing}
                  onChange={setMissing}
                  options={[
                    { value: '', label: 'Everybody' },
                    ...fields.map((field) => ({
                      value: field.id,
                      label: `Missing: ${field.name}`,
                    })),
                  ]}
                />
              ) : null}
              <span className="panel-aside">
                {missing === ''
                  ? `${members.length} ${members.length === 1 ? 'person' : 'people'}`
                  : `${shown.length} of ${members.length}`}
              </span>
            </div>
          </div>
          {members.length === 0 ? (
            <p className="panel-empty">
              Nobody is in this group yet. Find somebody below, or paste the list
              you already have.
            </p>
          ) : shown.length === 0 ? (
            <p className="panel-empty">
              Everybody has been ticked for that one.
            </p>
          ) : (
            <DataTable
              columns={columns}
              rows={shown}
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

        <GroupEvents groupId={group.id} groupName={group.name} events={events} checkins={checkins} />
      </div>

      <FieldsManager
        open={managingFields}
        onClose={() => setManagingFields(false)}
        groupId={group.id}
        fields={fields}
      />

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
      maxLength={GROUP_NOTE_MAX}
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
