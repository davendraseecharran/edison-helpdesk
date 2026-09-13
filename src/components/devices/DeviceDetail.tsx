'use client';

/**
 * One device: what it is, who has it, where it has been, and what has
 * happened to the record.
 *
 * The same 2fr / 1fr grid as a ticket. Left: the holder, the loan history,
 * the tickets that name it, the history. Right: the identifiers, in mono
 * with copy buttons, and the notes. The actions offered depend on whether
 * somebody is holding it: a held device is returned rather than given a
 * status by hand, because the database keeps those two things in step. On
 * phones the two main actions pin above the bottom tabs, as a ticket's do.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MapPin, Pencil, User } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import {
  assignDeviceAction,
  moveDeviceAction,
  returnDeviceAction,
  setDeviceStatusAction,
} from '@/lib/data/device-actions';
import type { DeviceFacets } from '@/lib/data/devices';
import { formatDateTime } from '@/lib/format';
import {
  deviceLabel,
  PERSON_KIND_LABELS,
  type DeviceAssignment,
  type DeviceDetail as DeviceDetailData,
} from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { DeviceStatusBadge } from '@/components/Badges';
import { Avatar, TimeAgo } from '@/components/Primitives';
import { CopyButton } from '@/components/directory/CopyButton';
import { RecordHistory } from '@/components/directory/RecordHistory';
import { RecordTicketList } from '@/components/directory/RecordTicketList';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { AssignDeviceDialog } from './AssignDeviceDialog';
import { ChangeStatusDialog } from './ChangeStatusDialog';
import { DeviceForm, DeviceFormSubmit } from './DeviceForm';
import { MoveDeviceDialog } from './MoveDeviceDialog';
import { ReturnDeviceDialog } from './ReturnDeviceDialog';

type DeviceDialog = 'assign' | 'return' | 'status' | 'move' | null;

function IdentFact({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ? (
          <span className="fact-ident">
            <span className="mono">{value}</span>
            <CopyButton value={value} label={label.toLowerCase()} />
          </span>
        ) : (
          <span className="dir-quiet">None</span>
        )}
      </dd>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ? value : <span className="dir-quiet">Not recorded</span>}</dd>
    </>
  );
}

export function DeviceDetail({ detail, facets }: { detail: DeviceDetailData; facets: DeviceFacets }) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const { device, holder } = detail;
  const label = deviceLabel(device);
  const busy = pendingKey !== null;

  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<DeviceDialog>(null);

  const assignKey = `assign:${device.id}`;
  const returnKey = `return:${device.id}`;
  const statusKey = `status:${device.id}`;
  const moveKey = `move:${device.id}`;

  function onAssign(personId: string, note: string): Promise<ActionResult> {
    return run(assignKey, () => assignDeviceAction(device.id, personId, note));
  }

  function onReturn(status: string, note: string): Promise<ActionResult> {
    return run(returnKey, () => returnDeviceAction(device.id, status, note));
  }

  function onStatus(status: string, reason: string): Promise<ActionResult> {
    return run(statusKey, () => setDeviceStatusAction(device.id, status, reason));
  }

  function onMove(location: string): Promise<ActionResult> {
    return run(moveKey, () => moveDeviceAction(device.id, location));
  }

  const subtitle = [device.manufacturer, device.model].filter(Boolean).join(' ');

  // The two actions the phone bar repeats. Rendered twice with different
  // classes (the header's copies hide on phones), so they are functions of a
  // class rather than one element used in two places.
  const primaryAction = (className?: string) =>
    holder ? (
      <Button
        key="return"
        variant="primary"
        className={className}
        disabled={busy}
        loading={pendingKey === returnKey}
        onClick={() => setDialog('return')}
      >
        Return device
      </Button>
    ) : (
      <Button
        key="assign"
        variant="primary"
        className={className}
        disabled={busy}
        loading={pendingKey === assignKey}
        onClick={() => setDialog('assign')}
      >
        Assign device
      </Button>
    );

  const secondaryAction = (className?: string) =>
    holder ? (
      <Button
        key="move"
        className={className}
        disabled={busy}
        loading={pendingKey === moveKey}
        onClick={() => setDialog('move')}
      >
        Move device
      </Button>
    ) : (
      <Button
        key="status"
        className={className}
        disabled={busy}
        loading={pendingKey === statusKey}
        onClick={() => setDialog('status')}
      >
        Change status
      </Button>
    );

  const historyColumns: Column<DeviceAssignment>[] = [
    {
      key: 'person',
      header: 'Person',
      hideOnPhone: true,
      cell: (loan) => (
        <div className="dir-cell-title">
          <Link href={`/people/${loan.personId}`} className="dir-name">
            {loan.personName}
          </Link>
          <span className="dir-sub">{PERSON_KIND_LABELS[loan.personKind]}</span>
        </div>
      ),
    },
    {
      key: 'assigned',
      header: 'Assigned',
      width: 180,
      cell: (loan) => (
        <div className="dir-cell-title">
          <TimeAgo iso={loan.assignedAt} />
          {loan.assignedByName ? <span className="dir-sub">by {loan.assignedByName}</span> : null}
        </div>
      ),
    },
    {
      key: 'returned',
      header: 'Returned',
      width: 180,
      cell: (loan) =>
        loan.returnedAt ? (
          <div className="dir-cell-title">
            <TimeAgo iso={loan.returnedAt} />
            {loan.returnedByName ? <span className="dir-sub">by {loan.returnedByName}</span> : null}
          </div>
        ) : (
          <span className="dir-quiet">Still held</span>
        ),
    },
    {
      key: 'note',
      header: 'Note',
      hideOnPhone: true,
      cell: (loan) => loan.note ?? null,
    },
  ];

  return (
    <div className="ticket record">
      <header className="ticket-head record-head">
        <div className="ticket-head-text">
          <h1 className="record-tag mono">{label}</h1>
          {subtitle || device.type ? (
            <p className="record-subtitle">
              {subtitle ? `${subtitle}, ${device.type.toLowerCase()}` : device.type}
            </p>
          ) : null}
          <div className="ticket-meta">
            <DeviceStatusBadge status={device.status} />
            <span className="ticket-meta-item">
              <Icon icon={MapPin} size={14} />
              <span>{device.location ?? 'No location recorded'}</span>
            </span>
            {holder ? (
              <span className="ticket-meta-item">
                <Icon icon={User} size={14} />
                <span>
                  Held by <Link href={`/people/${holder.id}`}>{holder.displayName}</Link>
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="btn-row record-actions">
          {primaryAction('btn-twin')}
          {secondaryAction('btn-twin')}
          {holder ? null : (
            <Button disabled={busy} loading={pendingKey === moveKey} onClick={() => setDialog('move')}>
              Move device
            </Button>
          )}
          <Button icon={Pencil} onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </Button>
        </div>
      </header>

      <div className="ticket-grid">
        <div className="ticket-column">
          <section className="panel" aria-labelledby="device-holder-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-holder-heading">
                Holder
              </h2>
            </div>
            <div className="panel-body">
              {holder ? (
                <div className="holder-card">
                  <Avatar name={holder.displayName} size="md" />
                  <div className="holder-card-text">
                    <Link href={`/people/${holder.id}`} className="holder-card-name">
                      {holder.displayName}
                    </Link>
                    <span className="holder-card-meta">
                      {PERSON_KIND_LABELS[holder.kind]}, since {formatDateTime(holder.assignedAt)} (
                      <TimeAgo iso={holder.assignedAt} />)
                    </span>
                  </div>
                  <Button
                    disabled={busy}
                    loading={pendingKey === returnKey}
                    onClick={() => setDialog('return')}
                  >
                    Return device
                  </Button>
                </div>
              ) : (
                <div className="holder-empty">
                  <p className="panel-empty">
                    Nobody is holding this device.
                    {device.status === 'in_stock' ? ' It is in stock and ready to hand out.' : ''}
                  </p>
                  <Button disabled={busy} onClick={() => setDialog('assign')}>
                    Assign device
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="device-loans-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-loans-heading">
                Assignment history
              </h2>
              <span className="panel-aside">
                {detail.assignments.length} {detail.assignments.length === 1 ? 'loan' : 'loans'}
              </span>
            </div>
            <div className="panel-body">
              {detail.assignments.length === 0 ? (
                <p className="panel-empty">This device has never been assigned to anyone.</p>
              ) : (
                <div className="record-table">
                  <DataTable
                    columns={historyColumns}
                    rows={detail.assignments}
                    rowKey={(loan) => loan.id}
                    caption="Everyone who has held this device"
                    cardTitle={(loan) => (
                      <Link href={`/people/${loan.personId}`}>{loan.personName}</Link>
                    )}
                    cardMeta={(loan) => loan.note ?? PERSON_KIND_LABELS[loan.personKind]}
                  />
                </div>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="device-tickets-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-tickets-heading">
                Linked tickets
              </h2>
              <span className="panel-aside">tickets you can see</span>
            </div>
            <div className="panel-body">
              <RecordTicketList
                tickets={detail.tickets}
                emptyText="No ticket you can see names this device. Link one from the ticket's page."
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="device-history-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-history-heading">
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
          <section className="panel" aria-labelledby="device-details-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-details-heading">
                Identifiers and details
              </h2>
            </div>
            <div className="panel-body">
              <dl className="facts">
                <IdentFact label="Asset tag" value={device.assetTag} />
                <IdentFact label="Serial number" value={device.serialNumber} />
                <IdentFact label="Device ID" value={device.deviceId} />
                <Fact label="Type" value={device.type} />
                <Fact label="Manufacturer" value={device.manufacturer} />
                <Fact label="Model" value={device.model} />
                <Fact label="OS" value={device.os} />
                <Fact label="Location" value={device.location} />
                <dt>Record</dt>
                <dd>
                  {device.source === 'import' ? 'Imported' : 'Entered by hand'}
                  <span className="facts-sub">
                    Added {formatDateTime(device.createdAt)}
                    {device.updatedAt !== device.createdAt
                      ? `, updated ${formatDateTime(device.updatedAt)}`
                      : ''}
                  </span>
                </dd>
              </dl>
            </div>
          </section>

          <section className="panel" aria-labelledby="device-notes-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-notes-heading">
                Notes
              </h2>
            </div>
            <div className="panel-body">
              {device.notes ? (
                <p className="record-notes">{device.notes}</p>
              ) : (
                <p className="panel-empty">No notes. Add one with Edit.</p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* The phone bar: the two actions that matter, pinned above the tabs. */}
      <div className="ticket-bar-space" aria-hidden="true" />
      <div className="ticket-bar" role="group" aria-label="Device actions">
        {primaryAction()}
        {secondaryAction()}
      </div>

      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit device"
        description={label}
        className="sheet-wide"
        footer={
          <>
            <Button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <DeviceFormSubmit device={device} />
          </>
        }
      >
        <DeviceForm
          key={device.updatedAt}
          device={device}
          held={holder !== null}
          types={facets.types}
          locations={facets.locations}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </Sheet>

      <AssignDeviceDialog
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        subject={label}
        pending={pendingKey === assignKey}
        currentHolderId={holder?.id ?? null}
        onSubmit={({ person, note }) => onAssign(person.id, note)}
      />
      <ReturnDeviceDialog
        open={dialog === 'return'}
        onClose={() => setDialog(null)}
        subject={label}
        pending={pendingKey === returnKey}
        onSubmit={({ status, note }) => onReturn(status, note)}
      />
      <ChangeStatusDialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        subject={label}
        current={device.status}
        pending={pendingKey === statusKey}
        onSubmit={({ status, reason }) => onStatus(status, reason)}
      />
      <MoveDeviceDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        subject={label}
        current={device.location}
        locations={facets.locations}
        pending={pendingKey === moveKey}
        onSubmit={onMove}
      />
    </div>
  );
}
