'use client';

/**
 * One person: who they are, what they are holding, what they have asked for,
 * and what has happened to the record.
 *
 * The page is a 2fr / 1fr grid from 1024px (the same one a ticket uses, so
 * the skeleton fits): devices, tickets and history on the left; the contact
 * details and notes on the right. Editing opens the form in a sheet over the
 * page rather than a separate route, so the record stays in view. Archiving
 * is an administrator's decision and sits behind a menu and a confirmation;
 * restoring is one press, because it only puts back what was there.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Ellipsis, Mail, Pencil } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import { returnDeviceAction } from '@/lib/data/device-actions';
import { setPersonActiveAction } from '@/lib/data/people-actions';
import { formatDateTime } from '@/lib/format';
import {
  deviceLabel,
  type PersonDetail as PersonDetailData,
  type PersonDeviceLoan,
} from '@/lib/domain/types';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { ArchivedBadge, DeviceStatusBadge, PersonKindBadge } from '@/components/Badges';
import { Avatar, TimeAgo } from '@/components/Primitives';
import { Identifier } from '@/components/directory/CopyButton';
import { RecordHistory } from '@/components/directory/RecordHistory';
import { RecordTicketList } from '@/components/directory/RecordTicketList';
import { ReturnDeviceDialog, type ReturnDeviceValues } from '@/components/devices/ReturnDeviceDialog';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { Sheet } from '@/components/ui/Sheet';
import { PersonForm, PersonFormSubmit } from './PersonForm';

function Fact({ label, value, href }: { label: string; value: string | null; href?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ? (
          href ? (
            <a href={href}>{value}</a>
          ) : (
            value
          )
        ) : (
          <span className="dir-quiet">Not recorded</span>
        )}
      </dd>
    </>
  );
}

export function PersonDetail({
  detail,
  departments,
}: {
  detail: PersonDetailData;
  departments: string[];
}) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const { person } = detail;
  const isAdmin = actor.role === 'admin';
  const busy = pendingKey !== null;

  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [returning, setReturning] = useState<PersonDeviceLoan | null>(null);

  const current = detail.devices.filter((loan) => loan.returnedAt === null);
  const past = detail.devices.filter((loan) => loan.returnedAt !== null);
  const ticketsAside =
    isAdmin ? 'open first, then recent' : 'open tickets you can see, then recent';

  async function setActive(active: boolean): Promise<ActionResult> {
    return run(`person-active:${person.id}`, () => setPersonActiveAction(person.id, active));
  }

  async function onReturn(values: ReturnDeviceValues): Promise<ActionResult> {
    if (!returning) return { ok: false, error: 'Choose a device to return.' };
    const deviceId = returning.device.id;
    return run(`return:${deviceId}`, () =>
      returnDeviceAction(deviceId, values.status, values.note),
    );
  }

  const historyColumns: Column<PersonDeviceLoan>[] = [
    {
      key: 'device',
      header: 'Device',
      mono: true,
      hideOnPhone: true,
      cell: (loan) => (
        <Link href={`/devices/${loan.device.id}`} className="dir-tag">
          {deviceLabel(loan.device)}
        </Link>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      hideOnPhone: true,
      cell: (loan) => loan.device.model ?? loan.device.type,
    },
    {
      key: 'assigned',
      header: 'Assigned',
      cell: (loan) => <TimeAgo iso={loan.assignedAt} />,
    },
    {
      key: 'returned',
      header: 'Returned',
      cell: (loan) => (loan.returnedAt ? <TimeAgo iso={loan.returnedAt} /> : null),
    },
  ];

  const student = person.kind === 'student';

  return (
    <div className="ticket record">
      <header className="ticket-head record-head">
        <div className="record-head-main">
          <Avatar name={person.displayName} size="md" />
          <div className="ticket-head-text">
            <div className="record-title-row">
              <h1 className="record-title">{person.displayName}</h1>
              <PersonKindBadge kind={person.kind} />
              {person.active ? null : <ArchivedBadge />}
            </div>
            <div className="ticket-meta record-idents">
              {person.osis ? <Identifier label="OSIS" value={person.osis} /> : null}
              {person.staffId ? <Identifier label="Staff ID" value={person.staffId} /> : null}
              {person.email ? (
                <a href={`mailto:${person.email}`} className="ticket-meta-item record-email">
                  <Mail size={14} className="icon" aria-hidden="true" />
                  <span>{person.email}</span>
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <div className="btn-row record-actions">
          <Button icon={Pencil} onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </Button>
          {isAdmin ? (
            <Menu
              label="More actions"
              trigger={<Button icon={Ellipsis} aria-label="More actions" disabled={busy} />}
              items={
                person.active
                  ? [{ label: 'Archive person', icon: Archive, danger: true, onSelect: () => setArchiving(true) }]
                  : [{ label: 'Restore person', icon: ArchiveRestore, onSelect: () => void setActive(true) }]
              }
            />
          ) : null}
        </div>
      </header>

      {person.active ? null : (
        <p className="callout callout-warn">
          <strong>Archived.</strong> Out of the directory listing and not choosable for a ticket
          or a device; still attached to everything that names them.
          {isAdmin ? ' Restore from the menu above.' : ' An administrator can restore the record.'}
        </p>
      )}

      <div className="ticket-grid">
        <div className="ticket-column">
          <section className="panel" aria-labelledby="person-devices-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-devices-heading">
                Devices
              </h2>
              <span className="panel-aside">{current.length} held now</span>
            </div>
            <div className="panel-body stack">
              {current.length === 0 ? (
                <p className="panel-empty">
                  Not holding any device. Assign one from the device&apos;s page or the inventory.
                </p>
              ) : (
                <ul className="loan-cards">
                  {current.map((loan) => (
                    <li key={loan.assignmentId} className="loan-card">
                      <div className="loan-card-text">
                        <Link href={`/devices/${loan.device.id}`} className="loan-card-tag mono">
                          {deviceLabel(loan.device)}
                        </Link>
                        <span className="loan-card-meta">
                          {loan.device.model ?? loan.device.type}
                          {loan.device.model ? `, ${loan.device.type}` : ''}
                        </span>
                        <span className="loan-card-meta">
                          <DeviceStatusBadge status={loan.device.status} />
                          <span>
                            assigned <TimeAgo iso={loan.assignedAt} />
                          </span>
                        </span>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        loading={pendingKey === `return:${loan.device.id}`}
                        onClick={() => setReturning(loan)}
                      >
                        Return device
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {past.length > 0 ? (
                <div className="stack-xs">
                  <p className="people-label">Previously held</p>
                  <div className="record-table">
                    <DataTable
                      columns={historyColumns}
                      rows={past}
                      rowKey={(loan) => loan.assignmentId}
                      caption="Devices previously held"
                      cardTitle={(loan) => (
                        <Link href={`/devices/${loan.device.id}`} className="mono">
                          {deviceLabel(loan.device)}
                        </Link>
                      )}
                      cardMeta={(loan) => loan.device.model ?? loan.device.type}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel" aria-labelledby="person-tickets-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-tickets-heading">
                Tickets
              </h2>
              <span className="panel-aside">{ticketsAside}</span>
            </div>
            <div className="panel-body">
              <RecordTicketList
                tickets={detail.tickets}
                emptyText={
                  isAdmin
                    ? 'No tickets have named this person as the requester.'
                    : 'No tickets you can see name this person as the requester.'
                }
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="person-history-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-history-heading">
                History
              </h2>
              <span className="panel-aside">
                {detail.events.length} {detail.events.length === 1 ? 'event' : 'events'}
              </span>
            </div>
            <div className="panel-body">
              <RecordHistory events={detail.events} />
            </div>
          </section>
        </div>

        <div className="ticket-column">
          <section className="panel" aria-labelledby="person-details-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-details-heading">
                {student ? 'Student details' : 'Staff details'}
              </h2>
            </div>
            <div className="panel-body">
              <dl className="facts">
                {student ? (
                  <>
                    <Fact label="Official class" value={person.officialClass} />
                    <Fact label="Class of" value={person.classOf} />
                    <Fact label="Parent or guardian" value={person.parentName} />
                    <Fact
                      label="Parent phone"
                      value={person.parentPhone}
                      href={person.parentPhone ? `tel:${person.parentPhone}` : undefined}
                    />
                    <Fact
                      label="Home phone"
                      value={person.homePhone}
                      href={person.homePhone ? `tel:${person.homePhone}` : undefined}
                    />
                    <Fact label="Address" value={person.address} />
                  </>
                ) : (
                  <>
                    <Fact label="Department" value={person.department} />
                    <Fact label="Role" value={person.roleTitle} />
                    <Fact label="School DBN" value={person.schoolDbn} />
                  </>
                )}
                <Fact
                  label="Email"
                  value={person.email}
                  href={person.email ? `mailto:${person.email}` : undefined}
                />
                <dt>Record</dt>
                <dd>
                  {person.source === 'import' ? 'Imported' : 'Entered by hand'}
                  <span className="facts-sub">
                    Added {formatDateTime(person.createdAt)}
                    {person.updatedAt !== person.createdAt
                      ? `, updated ${formatDateTime(person.updatedAt)}`
                      : ''}
                  </span>
                </dd>
              </dl>
            </div>
          </section>

          <section className="panel" aria-labelledby="person-notes-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-notes-heading">
                Notes
              </h2>
            </div>
            <div className="panel-body">
              {person.notes ? (
                <p className="record-notes">{person.notes}</p>
              ) : (
                <p className="panel-empty">No notes. Add one with Edit.</p>
              )}
            </div>
          </section>
        </div>
      </div>

      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit person"
        description={person.displayName}
        className="sheet-wide"
        footer={
          <>
            <Button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <PersonFormSubmit person={person} />
          </>
        }
      >
        <PersonForm
          key={person.updatedAt}
          person={person}
          departments={departments}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </Sheet>

      <ReturnDeviceDialog
        open={returning !== null}
        onClose={() => setReturning(null)}
        subject={returning ? deviceLabel(returning.device) : ''}
        pending={returning ? pendingKey === `return:${returning.device.id}` : false}
        onSubmit={onReturn}
      />

      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${person.displayName}?`}
        description="They leave the directory listing and cannot be chosen for a new ticket or device. Everything that already names them keeps doing so. You can restore them later."
        footer={
          <>
            <Button onClick={() => setArchiving(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === `person-active:${person.id}`}
              onClick={() => {
                void setActive(false).then((result) => {
                  if (result.ok) setArchiving(false);
                });
              }}
            >
              Archive person
            </Button>
          </>
        }
      >
        <p className="panel-note">
          Archived people stay searchable with &quot;Show archived&quot; on the people list.
        </p>
      </Dialog>
    </div>
  );
}
