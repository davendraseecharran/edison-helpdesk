'use client';

/**
 * The days this group did something, and the register for each.
 *
 * A meeting, a practice, a competition. The line somebody reads is "18 of 24
 * present", so that is the whole of the second column; the date is under the
 * name because an event is remembered by what it was before it is remembered
 * by when.
 *
 * Adding one is a name and a day and nothing else — it is a row that exists so
 * a register can be taken against it, and asking for anything more would put a
 * form between somebody and the twenty-four people waiting to be ticked.
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CalendarPlus } from 'lucide-react';
import { createGroupEventAction } from '@/lib/data/group-event-actions';
import type { GroupEventSummary } from '@/lib/data/group-events';
import { GROUP_EVENT_NAME_MAX } from '@/lib/domain/groups';
import { formatDateKey } from '@/lib/format';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';

export function GroupEvents({
  groupId,
  events,
}: {
  groupId: string;
  events: GroupEventSummary[];
}) {
  const { pendingKey, run, today } = useRuntime();
  const [name, setName] = useState('');
  const [heldOn, setHeldOn] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const busy = pendingKey !== null;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Give the event a name.');
      return;
    }
    setError(null);
    const result = await run(
      'group:event:create',
      () => createGroupEventAction(groupId, name.trim(), heldOn),
      { inlineError: true },
    );
    if (result.ok) {
      setName('');
      setHeldOn(today);
    } else {
      setError(result.error ?? 'That did not go through. Nothing changed.');
    }
  }

  const columns: Column<GroupEventSummary>[] = [
    {
      key: 'event',
      header: 'Event',
      hideOnPhone: true,
      cell: (item) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/groups/${groupId}/events/${item.id}`} className="dir-name row-link">
              {item.name}
            </Link>
          </span>
          <span className="dir-sub">{formatDateKey(item.heldOn)}</span>
        </div>
      ),
    },
    {
      key: 'present',
      header: 'Present',
      align: 'right',
      width: 140,
      cell: (item) =>
        item.memberCount === 0 ? (
          <span className="dir-quiet">No members</span>
        ) : (
          <span className="event-count">
            {item.presentCount} of {item.memberCount}
          </span>
        ),
    },
  ];

  return (
    <section className="panel directory" aria-labelledby="group-events-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="group-events-heading">
          Events
        </h2>
        <span className="panel-aside">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      <div className="panel-body">
        <form className="event-new" onSubmit={add} noValidate>
          <Field label="New event" htmlFor="event-name" className="event-new-name">
            <input
              id="event-name"
              value={name}
              maxLength={GROUP_EVENT_NAME_MAX}
              autoComplete="off"
              placeholder="Weekly meeting"
              onChange={(field) => setName(field.target.value)}
            />
          </Field>
          <Field label="Held on" htmlFor="event-date" className="event-new-date">
            <input
              id="event-date"
              type="date"
              value={heldOn}
              onChange={(field) => setHeldOn(field.target.value)}
            />
          </Field>
          <Button
            type="submit"
            icon={CalendarPlus}
            loading={pendingKey === 'group:event:create'}
            disabled={busy}
          >
            Add event
          </Button>
        </form>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {events.length === 0 ? (
        <p className="panel-empty">
          Nothing has been taken yet. Add an event, then take the register from
          a phone at the door.
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={events}
          rowKey={(item) => item.id}
          caption="Events this group has held"
          cardTitle={(item) => (
            <Link href={`/groups/${groupId}/events/${item.id}`} className="row-link">
              {item.name}
            </Link>
          )}
          cardMeta={(item) => formatDateKey(item.heldOn)}
        />
      )}
    </section>
  );
}
