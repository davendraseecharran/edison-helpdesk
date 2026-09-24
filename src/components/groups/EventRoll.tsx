'use client';

/**
 * The register, which is a phone held at a door.
 *
 * Everything on this screen is arranged around that: the scanner is the first
 * control and the biggest one, the typed box beside it does the same job for a
 * card that will not read, and the roll underneath is a list of tick boxes
 * rather than a table somebody reads. Each of the three paths ends in the same
 * place — a row in `group_attendance` — and each says one line back.
 *
 * The line matters more than it looks. Somebody scanning forty cards is not
 * looking at the screen between scans; they are looking at the next card. So
 * the answer has to be a sentence they can catch in a glance and act on:
 * "Alex Moreau, present." is a green light, "Not in Officers." is a person to
 * deal with afterwards, and "No match for 2109…" is a card to read out by
 * hand. `markLine` owns the wording and is tested without a camera.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardCopy, Download, MonitorSmartphone, Trash2 } from 'lucide-react';
import {
  deleteGroupEventAction,
  markAttendanceAction,
  markByKeyAction,
} from '@/lib/data/group-event-actions';
import type { EventDetail, RollEntry } from '@/lib/data/group-events';
import { markLine } from '@/lib/domain/groups';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { copyText, linesOf } from '@/lib/groups/clipboard';
import { formatDateKey } from '@/lib/format';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { ScanButton } from '@/components/shell/ScanButton';
import { usePaintSelect } from '@/components/ui/useSelection';
import '@/styles/groups.css';

export function EventRoll({ detail }: { detail: EventDetail }) {
  const { pendingKey, run, notify } = useRuntime();
  const router = useRouter();
  const { event, groupId, groupName, roll } = detail;
  const [typed, setTyped] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = pendingKey !== null;

  /*
   * Ticks shown before the database answers, so the column can be painted —
   * press a box and drag down the roll, or shift-click a range — without each
   * box waiting on the one before. Dropped when the server's roll arrives,
   * after the last save of a stroke and a short pause; one refused springs
   * back with a message.
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [rollSeen, setRollSeen] = useState(roll);
  if (rollSeen !== roll) {
    setRollSeen(roll);
    setOverrides(new Map());
  }
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const isPresent = (id: string) =>
    overrides.get(id) ?? roll.find((entry) => entry.id === id)?.present ?? false;

  function applyPresence(ids: readonly string[], on: boolean) {
    const changing = ids.filter((id) => isPresent(id) !== on);
    if (changing.length === 0) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const id of changing) next.set(id, on);
      return next;
    });
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    void Promise.all(
      changing.map(async (id) => {
        const result = await markAttendanceAction(event.id, id, on).catch(() => null);
        return result?.ok ? null : { id, error: result?.error };
      }),
    ).then((outcomes) => {
      const failed = outcomes.filter((outcome) => outcome !== null);
      if (failed.length > 0) {
        setOverrides((prev) => {
          const next = new Map(prev);
          for (const { id } of failed) next.set(id, !on);
          return next;
        });
        notify('error', failed[0].error ?? `${failed.length} marks were not saved. Try again.`);
      }
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 600);
    });
  }

  const paint = usePaintSelect({
    order: roll.map((entry) => entry.id),
    isOn: isPresent,
    apply: applyPresence,
  });

  const present = roll.filter((entry) => isPresent(entry.id)).length;
  const absentees = roll.filter((entry) => !isPresent(entry.id));

  /**
   * One key, scanned or typed, and the sentence it produces.
   *
   * Stable across renders because `ScanButton` keys its camera effect on the
   * callback: a new function every render would restart the camera mid-scan.
   */
  const mark = useCallback(
    async (key: string) => {
      const value = key.trim();
      if (value === '') return;
      const result = await run(`event:key:${value}`, async () => {
        const answer = await markByKeyAction(event.id, value);
        const line = markLine(answer, groupName, value);
        // 'present' and 'already' are the register working; the other three are
        // a person standing there who is not getting ticked, and an error toast
        // is the one that stays on screen until it is read.
        return answer.outcome === 'present' || answer.outcome === 'already'
          ? { ok: true, message: line }
          : { ok: false, error: line };
      });
      return result;
    },
    [event.id, groupName, run],
  );

  async function submitTyped(form: FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const value = typed.trim();
    if (value === '') return;
    await mark(value);
    // Cleared whatever the answer was: the box is for the next person, and the
    // answer is in the line above it.
    setTyped('');
  }

  const onDetect = useCallback(
    (code: string) => {
      void mark(code);
    },
    [mark],
  );

  async function copyAbsentees() {
    const copied = await copyText(linesOf(absentees.map((entry) => entry.displayName)));
    notify(
      copied ? 'success' : 'error',
      copied
        ? `${absentees.length} ${absentees.length === 1 ? 'name' : 'names'} copied.`
        : 'That did not copy. Select the names and copy them by hand.',
    );
  }

  const columns: Column<RollEntry>[] = [
    {
      key: 'present',
      header: 'Present',
      width: 88,
      cell: (entry) => (
        <label className="row-check roll-check" {...paint.boxProps(entry.id)}>
          <input
            type="checkbox"
            checked={isPresent(entry.id)}
            aria-label={`${entry.displayName} present`}
            onChange={(change) => paint.change(entry.id, change.target.checked)}
          />
        </label>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      hideOnPhone: true,
      cell: (entry) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/people/${entry.id}`} className="dir-name row-link">
              {entry.displayName}
            </Link>
          </span>
          <span className="dir-sub">
            {[PERSON_KIND_LABELS[entry.kind], entry.groupLabel].filter(Boolean).join(', ')}
          </span>
        </div>
      ),
    },
    {
      key: 'id',
      header: 'OSIS or staff ID',
      mono: true,
      hideOnPhone: true,
      width: 160,
      cell: (entry) => entry.externalId || <span className="dir-quiet">None</span>,
    },
  ];

  return (
    <div className="ticket record group-page">
      <header className="ticket-head record-head">
        <div className="record-head-main">
          <div className="ticket-head-text">
            <div className="record-title-row">
              <h1 className="record-title">{event.name}</h1>
            </div>
            <div className="ticket-meta record-idents">
              <Link href={`/groups/${groupId}`} className="ticket-meta-item">
                {groupName}
              </Link>
              <span className="ticket-meta-item">{formatDateKey(event.heldOn)}</span>
              <span className="ticket-meta-item">
                {present} of {roll.length} present
              </span>
            </div>
          </div>
        </div>
        <div className="btn-row record-actions">
          {/* Check-in at the door, full screen, for a scanner or a queue. */}
          <ButtonLink href={`/kiosk/events/${event.id}`} icon={MonitorSmartphone} prefetch={false}>
            Kiosk
          </ButtonLink>
          <ButtonLink
            href={`/groups/${groupId}/events/${event.id}/export`}
            icon={Download}
            prefetch={false}
          >
            Export CSV
          </ButtonLink>
          <Button
            icon={Trash2}
            variant="danger"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
          >
            Delete event
          </Button>
        </div>
      </header>

      <div className="stack group-stack">
        <section className="panel" aria-labelledby="event-take-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="event-take-heading">
              Take the register
            </h2>
          </div>
          <div className="panel-body">
            <div className="roll-take">
              {/* The scanner's own button, made the size of the thing somebody
                  reaches for on a phone. It renders nothing where there is no
                  camera, which is why the typed box is not a fallback but the
                  other half of the control. */}
              <div className="roll-scan">
                <ScanButton onDetect={onDetect} />
              </div>
              <form className="roll-typed" onSubmit={submitTyped} noValidate>
                <Field label="OSIS, staff ID or name" htmlFor="roll-key">
                  <input
                    id="roll-key"
                    value={typed}
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    placeholder="230020049"
                    disabled={busy}
                    onChange={(field) => setTyped(field.target.value)}
                  />
                </Field>
                <Button type="submit" variant="primary" disabled={busy || typed.trim() === ''}>
                  Mark present
                </Button>
              </form>
            </div>
          </div>
        </section>

        <section
          className="panel directory"
          aria-labelledby="event-roll-heading"
          data-painting={paint.painting || undefined}
        >
          <div className="panel-head">
            <h2 className="panel-title" id="event-roll-heading">
              Roll
            </h2>
            <div className="panel-head-end">
              <span className="panel-aside">
                {absentees.length} {absentees.length === 1 ? 'absent' : 'absent'}
              </span>
              <Button
                size="sm"
                icon={ClipboardCopy}
                onClick={copyAbsentees}
                disabled={absentees.length === 0}
              >
                Copy names of absentees
              </Button>
            </div>
          </div>
          {roll.length === 0 ? (
            <p className="panel-empty">
              Nobody is in this group yet. Add people to it and the roll fills
              itself.
            </p>
          ) : (
            <DataTable
              columns={columns}
              rows={roll}
              rowKey={(entry) => entry.id}
              caption={`The roll for ${event.name}`}
              cardTitle={(entry) => (
                <Link href={`/people/${entry.id}`} className="row-link">
                  {entry.displayName}
                </Link>
              )}
              cardMeta={(entry) =>
                [PERSON_KIND_LABELS[entry.kind], entry.groupLabel, entry.externalId]
                  .filter(Boolean)
                  .join(', ')
              }
            />
          )}
        </section>
      </div>

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete ${event.name}?`}
        description="The event goes and so does the register taken at it. The people stay in the group."
        footer={
          <>
            <Button onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === 'event:delete'}
              onClick={() =>
                run('event:delete', () => deleteGroupEventAction(event.id)).then((result) => {
                  // The page has no record behind it any more, so the group
                  // replaces it rather than being pushed over it.
                  if (result.ok) router.replace(`/groups/${groupId}`);
                })
              }
            >
              Delete event
            </Button>
          </>
        }
      >
        <p className="muted">
          {present === 0
            ? 'Nobody has been marked present.'
            : `${present} ${present === 1 ? 'person is' : 'people are'} marked present.`}
        </p>
      </Dialog>
    </div>
  );
}
