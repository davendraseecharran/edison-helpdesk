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
import { MapPin, Pencil, Printer, Trash2, User, Wrench } from 'lucide-react';
import type { ActionResult } from '@/lib/data/actions';
import {
  assignDeviceAction,
  bulkUpdateDevicesAction,
  deleteDeviceAction,
  returnDeviceAction,
} from '@/lib/data/device-actions';
import { formatDateTime } from '@/lib/format';
import { deviceTypeLabel } from '@/lib/domain/device-types';
import { labelsHref } from '@/lib/labels/layout';
import {
  ASSIGNED_STATUS,
  AVAILABLE_STATUS,
  deviceLabel,
  PERSON_KIND_LABELS,
  type DeviceCatalogEntry,
  type DeviceDetail as DeviceDetailData,
} from '@/lib/domain/types';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { canWorkTickets } from '@/lib/auth/roles';
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel';
import { DeviceStatusBadge } from '@/components/Badges';
import { Avatar, TimeAgo } from '@/components/Primitives';
import { CopyButton } from '@/components/directory/CopyButton';
import { RecordHistory } from '@/components/directory/RecordHistory';
import { RecordTicketList } from '@/components/directory/RecordTicketList';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import '@/styles/device-model.css';
import { AssignDeviceDialog } from './AssignDeviceDialog';
import { ChangeStatusDialog } from './ChangeStatusDialog';
import { DeviceForm, DeviceFormSubmit } from './DeviceForm';
import { MoveDeviceDialog } from './MoveDeviceDialog';
import { ReturnDeviceDialog } from './ReturnDeviceDialog';

type DeviceDialog = 'assign' | 'return' | 'status' | 'move' | null;

/**
 * The machine, as an object.
 *
 * A small CSS 3D model beside the tag, drawn from what the record says
 * rather than from a picture: its kind decides the shape and its state
 * decides the pose, so the page says "a Chromebook, out with somebody" before
 * a word of it is read.
 *
 * - A laptop or a Chromebook is a deck and a lid on a hinge. A Chromebook's
 *   lid carries the round mark on its back.
 * - A tablet or a phone stands on its edge; anything else is a screen on a
 *   stand.
 * - Assigned: open, the screen on. Available: open, the screen dark, ready.
 *   In repair: half shut, with a wrench beside it. Retired, lost or any
 *   status the district invented: shut.
 *
 * When the status changes on this page (assigned, returned, sent to repair)
 * the lid moves to its new pose, which is the change confirmed in the one
 * place that shows it. Only `transform` and `opacity` move; it leans towards
 * a precise pointer (`data-tilt`); under reduced motion it simply takes the
 * pose. Monochrome, from the surface ladder. Decoration for a reader, who
 * has the tag, the type and the status in words beside it.
 */
type DeviceShape = 'laptop' | 'chromebook' | 'slab' | 'screen';
type DevicePose = 'on' | 'ready' | 'repair' | 'shut';

function deviceShape(type: string): DeviceShape {
  const known = deviceTypeLabel(type).toLowerCase();
  if (known === 'chromebook') return 'chromebook';
  if (known === 'tablet' || known === 'phone') return 'slab';
  if (known === 'desktop' || known === 'interactive panel' || known === 'projector') return 'screen';
  return 'laptop';
}

function devicePose(status: string | null | undefined): DevicePose {
  const value = (status ?? '').trim().toLowerCase();
  if (value === ASSIGNED_STATUS.toLowerCase()) return 'on';
  if (value === AVAILABLE_STATUS.toLowerCase()) return 'ready';
  if (value.includes('repair')) return 'repair';
  return 'shut';
}

function DeviceModel({ type, status }: { type: string; status: string | null | undefined }) {
  const shape = deviceShape(type);
  const pose = devicePose(status);
  const hinged = shape === 'laptop' || shape === 'chromebook';
  return (
    <div className="dm-stage" data-tilt="" data-shape={shape} data-pose={pose} aria-hidden="true">
      <div className="dm-scene">
        {hinged ? (
          <div className="dm-deck">
            <span className="dm-keys" />
            <span className="dm-pad" />
            <span className="dm-edge dm-edge-front" />
            <span className="dm-edge dm-edge-side" />
            <div className="dm-lid">
              <span className="dm-screen">
                <span className="dm-glow" />
              </span>
              <span className="dm-lid-back">{shape === 'chromebook' ? <span className="dm-emblem" /> : null}</span>
            </div>
          </div>
        ) : (
          <div className="dm-floor">
            <div className="dm-lid">
              <span className="dm-screen">
                <span className="dm-glow" />
              </span>
              <span className="dm-lid-back" />
            </div>
            {shape === 'screen' ? <span className="dm-neck" /> : null}
          </div>
        )}
      </div>
      {pose === 'repair' ? (
        <span className="dm-badge">
          <Icon icon={Wrench} size={12} />
        </span>
      ) : null}
    </div>
  );
}

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
  const { pendingKey, run, actor: runtimeActor } = useRuntime();
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
  // Deleting is for a record that should never have existed — a typo, a
  // duplicate. Administrators and NetRiders; every delete keeps the whole row
  // in the inventory history, so an administrator can see who and why.
  const canDelete = canWorkTickets(runtimeActor.roles);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');

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
        <div className="record-head-main">
          <DeviceModel type={device.deviceType} status={device.status} />
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
          <ButtonLink icon={Printer} href={labelsHref([device.id])}>
            Print label
          </ButtonLink>
          {canDelete ? (
            <Button
              icon={Trash2}
              variant="ghost"
              aria-label={`Delete the record ${label}`}
              title="Delete this record (typos and duplicates)"
              disabled={busy}
              onClick={() => setDeleting(true)}
            />
          ) : null}
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
                  {/* No button. "Return device" is the screen's primary action,
                      in the header above and in the phone's bar, and a device
                      screen that says it twice is a screen asking whether the
                      two do the same thing. */}
                </div>
              ) : (
                <div className="holder-empty">
                  <p className="panel-empty">
                    Nobody is holding this device.
                    {device.status && device.status !== ASSIGNED_STATUS
                      ? ` Its status is ${device.status}.`
                      : ''}
                  </p>
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
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete the record ${label}?`}
        description="For a record that should never have existed: a tag typed twice, a duplicate. A machine somebody has, or one named on a ticket, is kept; mark it Retired instead. The whole record stays in the inventory history."
        footer={
          <>
            <Button onClick={() => setDeleting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === 'device:delete'}
              onClick={() =>
                run('device:delete', () =>
                  deleteDeviceAction(device.id, deleteReason.trim() || null, device.version),
                ).then((result) => {
                  if (result.ok) router.replace('/devices');
                })
              }
            >
              Delete record
            </Button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">Why</span>
          <input
            type="text"
            value={deleteReason}
            maxLength={500}
            placeholder="Duplicate of DOE-LN0000412"
            onChange={(event) => setDeleteReason(event.target.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
