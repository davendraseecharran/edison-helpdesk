'use client';

/**
 * One device: what it is, who has it, where it has been, and what has
 * happened to the record.
 *
 * The same 2fr / 1fr grid as a ticket. Left: the holder, the tickets that name
 * it, the history. Right: the identifiers, in mono with copy buttons, and the
 * notes. The actions offered depend on whether somebody is holding it: a held
 * device is returned rather than given a status by hand, because returning is
 * what closes the loan. On phones the two main actions pin above the bottom
 * tabs, as a ticket's do.
 *
 * The loan history is the record history below, not a table of its own. The
 * district's inventory records where a machine IS; app_assign_inventory_device
 * and app_return_inventory_device write where it HAS BEEN, as record events on
 * the machine and on the person, which is where every other non-ticket history
 * in this application lives.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MapPin, Pencil, User } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import {
  assignDeviceAction,
  bulkUpdateDevicesAction,
  returnDeviceAction,
} from '@/lib/data/device-actions';
import { formatDateTime } from '@/lib/format';
import { deviceTypeLabel } from '@/lib/domain/device-types';
import {
  ASSIGNED_STATUS,
  deviceLabel,
  PERSON_KIND_LABELS,
  type DeviceCatalogEntry,
  type DeviceDetail as DeviceDetailData,
} from '@/lib/domain/types';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel';
import { DeviceStatusBadge } from '@/components/Badges';
import { Avatar, TimeAgo } from '@/components/Primitives';
import { CopyButton } from '@/components/directory/CopyButton';
import { RecordHistory } from '@/components/directory/RecordHistory';
import { RecordTicketList } from '@/components/directory/RecordTicketList';
import { Button } from '@/components/ui/Button';
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

export function DeviceDetail({
  detail,
  statuses,
  catalog,
}: {
  detail: DeviceDetailData;
  statuses: string[];
  catalog: DeviceCatalogEntry[];
}) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const { device } = detail;
  const holder =
    device.assignedRequesterId && device.assignedName
      ? {
          id: device.assignedRequesterId,
          displayName: device.assignedName,
          kind: device.assignedKind ?? 'staff',
        }
      : null;
  const isAdmin = actor.role === 'admin';
  const label = deviceLabel(device);
  const busy = pendingKey !== null;
  // The locations already on this machine and in its catalogue neighbours are
  // not available here; the move dialog offers the one it has plus free text.
  const locations = device.location ? [device.location] : [];

  const searchParams = useSearchParams();
  const [editing, setEditing] = useState(false);

  /*
   * A dialog asked for by the URL.
   *
   * The card that follows a scan offers Assign, and assigning needs a person,
   * which needs this page. `?do=assign` carries the intent across the
   * navigation so the scan is still one press: the dialog is open when the page
   * arrives rather than waiting behind a second button.
   *
   * Read once, on mount, and only for a value this page knows.
   */
  const [dialog, setDialog] = useState<DeviceDialog>(() => {
    const asked = searchParams?.get('do') ?? null;
    return asked === 'assign' || asked === 'return' ? asked : null;
  });

  const assignKey = `assign:${device.id}`;
  const returnKey = `return:${device.id}`;
  const statusKey = `status:${device.id}`;
  const moveKey = `move:${device.id}`;

  async function refreshed(result: ActionResult): Promise<ActionResult> {
    if (result.ok) router.refresh();
    return result;
  }

  async function onAssign(personId: string, note: string): Promise<ActionResult> {
    return refreshed(
      await run(assignKey, () => assignDeviceAction(device.id, personId, note, device.version)),
    );
  }

  async function onReturn(status: string, note: string): Promise<ActionResult> {
    return refreshed(
      await run(returnKey, () => returnDeviceAction(device.id, status, note, device.version)),
    );
  }

  // One machine through the bulk RPC: it is the writer that changes a status or
  // a location without touching anything else, and it snapshots what it changed.
  async function onStatus(status: string): Promise<ActionResult> {
    return refreshed(await run(statusKey, () => bulkUpdateDevicesAction([device.id], { status })));
  }

  async function onMove(location: string): Promise<ActionResult> {
    return refreshed(await run(moveKey, () => bulkUpdateDevicesAction([device.id], { location })));
  }

  const subtitle = [device.manufacturer, device.model].filter(Boolean).join(' ');
  const typeLabel = deviceTypeLabel(device.deviceType);

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

  return (
    <div className="ticket record">
      <header className="ticket-head record-head">
        <div className="ticket-head-text">
          <h1 className="record-tag mono">{label}</h1>
          {subtitle || typeLabel ? (
            <p className="record-subtitle">
              {subtitle && typeLabel ? `${subtitle}, ${typeLabel}` : subtitle || typeLabel}
            </p>
          ) : null}
          <div className="ticket-meta">
            <DeviceStatusBadge status={device.status} />
            <span className="ticket-meta-item">
              <Icon icon={MapPin} size={14} />
              <span>{device.location || 'No location recorded'}</span>
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
                      {PERSON_KIND_LABELS[holder.kind]}, since{' '}
                      {formatDateTime(device.updatedAt)} (<TimeAgo iso={device.updatedAt} />)
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
                    {device.status && device.status !== ASSIGNED_STATUS
                      ? ` Its status is ${device.status}.`
                      : ''}
                  </p>
                  <Button disabled={busy} onClick={() => setDialog('assign')}>
                    Assign device
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="device-tickets-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="device-tickets-heading">
                Linked tickets
              </h2>
              <span className="panel-aside">
                {isAdmin ? 'open first, then recent' : 'open tickets you can see, then recent'}
              </span>
            </div>
            <div className="panel-body">
              <RecordTicketList
                tickets={detail.tickets}
                emptyText={
                  isAdmin
                    ? "No ticket names this device. Link one from the ticket's page."
                    : "No ticket you can see names this device. Link one from the ticket's page."
                }
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

          {/* Under the history, because that is what the files are: the
              photograph of the cracked lid and the repair invoice belong to
              this machine rather than to whichever ticket happened to notice
              it. Inventory is shared, so any active account may add one. */}
          <AttachmentsPanel deviceId={device.id} />
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
                <IdentFact label="Asset tag" value={device.assetTag || null} />
                <IdentFact label="Serial number" value={device.serialNumber || null} />
                <IdentFact label="Inventory ID" value={device.externalId || null} />
                <Fact label="Type" value={typeLabel || null} />
                <Fact label="Manufacturer" value={device.manufacturer || null} />
                <Fact label="Model" value={device.model || null} />
                <Fact label="OS" value={device.osVersion || null} />
                <Fact label="Location" value={device.location || null} />
                <dt>Record</dt>
                <dd>
                  Version {device.version}
                  <span className="facts-sub">Updated {formatDateTime(device.updatedAt)}</span>
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
          statuses={statuses}
          catalog={catalog}
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
        statuses={statuses}
        pending={pendingKey === returnKey}
        onSubmit={({ status, note }) => onReturn(status, note)}
      />
      <ChangeStatusDialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        subject={label}
        current={device.status}
        statuses={statuses}
        pending={pendingKey === statusKey}
        onSubmit={({ status }) => onStatus(status)}
      />
      <MoveDeviceDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        subject={label}
        current={device.location}
        locations={locations}
        pending={pendingKey === moveKey}
        onSubmit={onMove}
      />
    </div>
  );
}
