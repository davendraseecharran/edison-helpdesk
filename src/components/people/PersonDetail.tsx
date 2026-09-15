'use client';

/**
 * One person: who they are, what they are holding, what they have asked for,
 * and what has happened to the record.
 *
 * The page is a 2fr / 1fr grid from 1024px (the same one a ticket uses, so the
 * skeleton fits): devices, tickets and history on the left; the contact details
 * and notes on the right. Editing opens the form in a sheet over the page
 * rather than a separate route, so the record stays in view.
 *
 * The machines are what they are holding NOW — `app_requester_devices` — and
 * the loan history is in the record history below, written there by
 * app_assign_inventory_device and app_return_inventory_device.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Mail, Pencil } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import { returnDeviceAction } from '@/lib/data/device-actions';
import { formatDateTime } from '@/lib/format';
import {
  deviceLabel,
  STUDENT_STATUS_LABELS,
  type Device,
  type PersonDetail as PersonDetailData,
} from '@/lib/domain/types';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { DeviceStatusBadge, PersonKindBadge } from '@/components/Badges';
import { Avatar } from '@/components/Primitives';
import { Identifier } from '@/components/directory/CopyButton';
import { deviceTypeLabel } from '@/lib/domain/device-types';
import { RecordHistory } from '@/components/directory/RecordHistory';
import { RecordTicketList } from '@/components/directory/RecordTicketList';
import { ReturnDeviceDialog, type ReturnDeviceValues } from '@/components/devices/ReturnDeviceDialog';
import { Button } from '@/components/ui/Button';
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
  roles,
  statuses,
}: {
  detail: PersonDetailData;
  departments: string[];
  roles: string[];
  statuses: string[];
}) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const { person } = detail;
  const isAdmin = actor.role === 'admin';
  const busy = pendingKey !== null;

  const [editing, setEditing] = useState(false);
  const [returning, setReturning] = useState<Device | null>(null);

  const ticketsAside = isAdmin ? 'open first, then recent' : 'open tickets you can see, then recent';

  async function onReturn(values: ReturnDeviceValues): Promise<ActionResult> {
    if (!returning) return { ok: false, error: 'Choose a device to return.' };
    const device = returning;
    const result = await run(`return:${device.id}`, () =>
      returnDeviceAction(device.id, values.status, values.note, device.version),
    );
    if (result.ok) router.refresh();
    return result;
  }

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
            </div>
            <div className="ticket-meta record-idents">
              {person.externalId ? (
                <Identifier label={student ? 'OSIS' : 'Staff ID'} value={person.externalId} />
              ) : null}
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
        </div>
      </header>

      {student && person.studentStatus !== 'current' ? (
        <p className="callout callout-warn">
          <strong>{STUDENT_STATUS_LABELS[person.studentStatus]}.</strong> Still in the directory and
          still attached to everything that names them. Change it from Edit if that is wrong.
        </p>
      ) : null}

      <div className="ticket-grid">
        <div className="ticket-column">
          <section className="panel" aria-labelledby="person-devices-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="person-devices-heading">
                Devices
              </h2>
              <span className="panel-aside">{detail.devices.length} held now</span>
            </div>
            <div className="panel-body stack">
              {detail.devices.length === 0 ? (
                <p className="panel-empty">
                  Not holding any device. Assign one from the device&apos;s page or the inventory.
                </p>
              ) : (
                <ul className="loan-cards">
                  {detail.devices.map((device) => (
                    <li key={device.id} className="loan-card">
                      <div className="loan-card-text">
                        <Link href={`/devices/${device.id}`} className="loan-card-tag mono">
                          {deviceLabel(device)}
                        </Link>
                        <span className="loan-card-meta">
                          {[device.manufacturer, device.model, deviceTypeLabel(device.deviceType)]
                            .filter(Boolean)
                            .join(', ')}
                        </span>
                        <span className="loan-card-meta">
                          <DeviceStatusBadge status={device.status} />
                          {device.location ? <span>{device.location}</span> : null}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        loading={pendingKey === `return:${device.id}`}
                        onClick={() => setReturning(device)}
                      >
                        Return device
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
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
                    <Fact label="Official class" value={person.officialClass || null} />
                    <Fact label="Class of" value={person.classOf || null} />
                    <Fact label="Enrolment" value={STUDENT_STATUS_LABELS[person.studentStatus]} />
                    <Fact label="Parent or guardian" value={person.guardianName || null} />
                    <Fact
                      label="Guardian phone"
                      value={person.guardianPhone || null}
                      href={person.guardianPhone ? `tel:${person.guardianPhone}` : undefined}
                    />
                    <Fact
                      label="Home phone"
                      value={person.homePhone || null}
                      href={person.homePhone ? `tel:${person.homePhone}` : undefined}
                    />
                    <Fact label="Address" value={person.address || null} />
                  </>
                ) : (
                  <>
                    <Fact label="Department" value={person.department || null} />
                    <Fact label="Role" value={person.staffRole || null} />
                    <Fact label="School DBN" value={person.schoolDbn || null} />
                  </>
                )}
                <Fact
                  label="Email"
                  value={person.email || null}
                  href={person.email ? `mailto:${person.email}` : undefined}
                />
                <dt>Record</dt>
                <dd>
                  Version {person.version}
                  <span className="facts-sub">Updated {formatDateTime(person.updatedAt)}</span>
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
          roles={roles}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </Sheet>

      <ReturnDeviceDialog
        open={returning !== null}
        onClose={() => setReturning(null)}
        subject={returning ? deviceLabel(returning) : ''}
        statuses={statuses}
        pending={returning ? pendingKey === `return:${returning.id}` : false}
        onSubmit={onReturn}
      />
    </div>
  );
}
