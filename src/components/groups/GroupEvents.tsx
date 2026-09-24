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

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CalendarPlus, QrCode as QrIcon } from 'lucide-react';
import { createGroupEventAction } from '@/lib/data/group-event-actions';
import { eventCheckinAction } from '@/lib/data/checkin-actions';
import type { CheckinSettings, CheckinState } from '@/lib/domain/checkin';
import type { GroupEventSummary } from '@/lib/data/group-events';
import { GROUP_EVENT_NAME_MAX } from '@/lib/domain/groups';
import { formatDateKey } from '@/lib/format';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePhone } from '@/components/ui/media';
import { SelfCheckinBody } from '@/components/checkin/SelfCheckinPanel';
import '@/styles/checkin.css';

/** "Self check-in open", beside an event that takes it. */
function CheckinTag({ state }: { state: CheckinState | undefined }) {
  if (state === undefined) return null;
  return (
    <span className="event-checkin-tag" data-state={state}>
      <Icon icon={QrIcon} size={12} />
      {state === 'open' ? 'Self check-in open' : 'Self check-in'}
    </span>
  );
}

export function GroupEvents({
  groupId,
  groupName = 'this group',
  events,
  checkins = {},
}: {
  groupId: string;
  groupName?: string;
  events: GroupEventSummary[];
  checkins?: Record<string, CheckinState>;
}) {
  const { pendingKey, run, today } = useRuntime();
  const phone = usePhone();
  // The event whose self check-in is open in the sheet, and what it holds.
  const [checkinFor, setCheckinFor] = useState<GroupEventSummary | null>(null);
  const [checkin, setCheckin] = useState<CheckinSettings | null | 'loading'>('loading');

  // Only the newest open may fill the sheet: opening one event and then
  // another must not be settled by whichever read lands last.
  const asked = useRef(0);

  function openCheckin(item: GroupEventSummary) {
    const ticket = asked.current + 1;
    asked.current = ticket;
    setCheckinFor(item);
    setCheckin('loading');
    void eventCheckinAction(item.id)
      .then((settings) => {
        if (asked.current === ticket) setCheckin(settings);
      })
      .catch(() => {
        if (asked.current === ticket) setCheckin(null);
      });
  }
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
            <CheckinTag state={checkins[item.id]} />
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
    {
      key: 'checkin',
      header: <span className="visually-hidden">Self check-in</span>,
      align: 'right',
      width: 64,
      hideOnPhone: true,
      cell: (item) => (
        <Button
          size="sm"
          variant="ghost"
          icon={QrIcon}
          aria-label={`Self check-in for ${item.name}`}
          onClick={() => openCheckin(item)}
        />
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
            <span className="fr-card-title">
              <Link href={`/groups/${groupId}/events/${item.id}`} className="row-link">
                {item.name}
              </Link>
              <Button
                size="sm"
                variant="ghost"
                icon={QrIcon}
                aria-label={`Self check-in for ${item.name}`}
                onClick={() => openCheckin(item)}
              />
            </span>
          )}
          cardMeta={(item) =>
            checkins[item.id] === 'open'
              ? `${formatDateKey(item.heldOn)}, self check-in open`
              : formatDateKey(item.heldOn)
          }
        />
      )}

      <Sheet
        open={checkinFor !== null}
        onClose={() => setCheckinFor(null)}
        side={phone ? 'bottom' : 'right'}
        title={checkinFor ? `Self check-in: ${checkinFor.name}` : 'Self check-in'}
        description={checkinFor ? formatDateKey(checkinFor.heldOn) : undefined}
        className="sci-sheet"
      >
        {checkinFor === null ? null : checkin === 'loading' ? (
          <Skeleton className="sci-qr-skeleton" />
        ) : (
          <SelfCheckinBody
            eventId={checkinFor.id}
            eventName={checkinFor.name}
            groupName={groupName}
            settings={checkin}
            onSettings={setCheckin}
          />
        )}
      </Sheet>
    </section>
  );
}
