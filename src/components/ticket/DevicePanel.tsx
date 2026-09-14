'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, X } from 'lucide-react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { recordDeviceAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';
import { DevicePicker, type DeviceSearchResult } from '@/components/devices/DevicePicker';
import { ActorLabel } from '@/components/ui/ActorLabel';
import { Button } from '@/components/ui/Button';

interface DeviceDraft {
  deviceType: string;
  model: string;
  osVersion: string;
  serialNumber: string;
  assetTag: string;
  identifiersNotApplicable: boolean;
  /** Set only when the machine was chosen from the inventory, never when typed. */
  inventoryDeviceId: string | null;
  /** How the chosen machine is named, for the line that says which one it is. */
  inventoryLabel: string | null;
}

const EMPTY_DRAFT: DeviceDraft = {
  deviceType: '',
  model: '',
  osVersion: '',
  serialNumber: '',
  assetTag: '',
  identifiersNotApplicable: false,
  inventoryDeviceId: null,
  inventoryLabel: null,
};

/**
 * Device observations recorded at service time. Unknown serials and asset tags
 * are allowed: the plan requires that missing identifiers never block the record.
 *
 * The form opens with the inventory picker above the fields, because most of
 * what the desk sees is the district's own equipment. Choosing a machine fills
 * the identifiers AND names the inventory record the observation is about —
 * `device_observations.inventory_device_id`, a column that has existed since
 * 20260912220000 and that nothing ever wrote, so an observation and the machine
 * it was made about never referred to each other.
 *
 * Choosing is optional and stays optional. A parent's laptop, a projector
 * nobody ever tagged and a machine on loan from another school are still
 * described by hand in the fields below, which is the whole reason an
 * observation is a different thing from a link.
 */
export function DevicePanel({ detail }: { detail: TicketDetail }) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const ticket = detail.ticket;
  const mayAdd = canContribute(ticket, actor);
  const key = `device:${ticket.id}`;
  const saving = pendingKey === key;
  const count = detail.devices.length;
  const formId = `device-form-${ticket.id}`;

  /*
   * Choosing from the inventory fills the form and remembers WHICH record was
   * chosen. The fields stay editable afterwards: the inventory's idea of a
   * machine's model can be out of date, and what the technician is holding is
   * the more recent fact. Correcting one of them does not unpick the choice —
   * the observation is still about that machine, which is the whole point of
   * naming it.
   */
  function chooseFromInventory(device: DeviceSearchResult) {
    setError(null);
    setDraft((current) => ({
      ...current,
      deviceType: device.type,
      model: device.model ?? '',
      serialNumber: device.serialNumber ?? '',
      assetTag: device.assetTag ?? '',
      identifiersNotApplicable: false,
      inventoryDeviceId: device.id,
      inventoryLabel: device.label,
    }));
  }

  function clearInventoryChoice() {
    setDraft((current) => ({ ...current, inventoryDeviceId: null, inventoryLabel: null }));
  }

  async function onSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);
    const result = await run(key, () => recordDeviceAction(ticket.id, draft));
    if (result.ok) {
      setDraft(EMPTY_DRAFT);
      setOpen(false);
    } else {
      setError(result.error ?? 'That change could not be saved.');
    }
  }

  return (
    <section className="panel" aria-labelledby={`devices-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`devices-heading-${ticket.id}`}>
          Device details observed
        </h2>
        <div className="panel-head-end">
          <span className="panel-aside">
            {count} {count === 1 ? 'device' : 'devices'}
          </span>
          {mayAdd ? (
            <Button
              size="sm"
              icon={open ? undefined : Plus}
              aria-expanded={open}
              aria-controls={open ? formId : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? 'Cancel' : 'Record device'}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="panel-body stack">
        {count === 0 ? (
          <p className="panel-empty">
            No devices recorded. A room-wide fault may legitimately have none.
          </p>
        ) : (
          <ul className="devices">
            {detail.devices.map((device) => (
              <li className="device" key={device.id}>
                <div className="device-head">
                  <span className="device-type">{device.deviceType}</span>
                  <span className="device-meta">
                    <ActorLabel
                      name={nameOf(directory, device.recordedById)}
                      via={device.performedVia}
                      model={device.aiModel}
                    />
                    , <TimeAgo iso={device.recordedAt} />
                  </span>
                </div>
                <dl className="device-specs">
                  <div>
                    <dt>Manufacturer</dt>
                    <dd>{device.manufacturer ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{device.model ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>OS or firmware</dt>
                    <dd>{device.osVersion ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Serial</dt>
                    <dd className={device.serialNumber ? 'mono' : undefined}>
                      {device.identifiersNotApplicable
                        ? 'Not applicable'
                        : (device.serialNumber ?? 'Unknown')}
                    </dd>
                  </div>
                  <div>
                    <dt>Asset tag</dt>
                    <dd className={device.assetTag ? 'mono' : undefined}>
                      {device.identifiersNotApplicable
                        ? 'Not applicable'
                        : (device.assetTag ?? 'Unknown')}
                    </dd>
                  </div>
                  {device.inventoryDeviceId ? (
                    <div>
                      <dt>In the inventory</dt>
                      <dd>
                        <Link href={`/devices/${device.inventoryDeviceId}`}>
                          Open this machine
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        )}

        {open && mayAdd ? (
          <form id={formId} onSubmit={onSubmit} className="form">
            <fieldset className="draft">
              <legend>New device</legend>
              {draft.inventoryDeviceId ? (
                <p className="panel-aside">
                  From the inventory: <span className="mono">{draft.inventoryLabel}</span>{' '}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={X}
                    aria-label="Do not name an inventory machine"
                    title="Do not name an inventory machine"
                    onClick={clearInventoryChoice}
                  />
                </p>
              ) : (
                <DevicePicker
                  id={`observe-device-${ticket.id}`}
                  label="Find it in the inventory"
                  hint="Optional. Choosing one fills the details below and records which machine this is about."
                  onSelect={chooseFromInventory}
                  disabled={pendingKey !== null}
                />
              )}
              <div className="form-grid">
                <Field label="Device type" htmlFor={`add-device-type-${ticket.id}`} error={error}>
                  <input
                    id={`add-device-type-${ticket.id}`}
                    type="text"
                    value={draft.deviceType}
                    aria-invalid={error ? 'true' : undefined}
                    onChange={(event) => setDraft({ ...draft, deviceType: event.target.value })}
                    placeholder="Laptop"
                  />
                </Field>
                <Field label="Manufacturer and model" htmlFor={`add-device-model-${ticket.id}`} optional>
                  <input
                    id={`add-device-model-${ticket.id}`}
                    type="text"
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  />
                </Field>
                <Field label="OS or firmware" htmlFor={`add-device-os-${ticket.id}`} optional>
                  <input
                    id={`add-device-os-${ticket.id}`}
                    type="text"
                    value={draft.osVersion}
                    onChange={(event) => setDraft({ ...draft, osVersion: event.target.value })}
                  />
                </Field>
                <Field
                  label="Serial number"
                  htmlFor={`add-device-serial-${ticket.id}`}
                  optional
                  hint="Blank is fine when unknown."
                >
                  <input
                    id={`add-device-serial-${ticket.id}`}
                    type="text"
                    className="mono"
                    value={draft.serialNumber}
                    disabled={draft.identifiersNotApplicable}
                    onChange={(event) => setDraft({ ...draft, serialNumber: event.target.value })}
                  />
                </Field>
                <Field label="Asset tag" htmlFor={`add-device-asset-${ticket.id}`} optional>
                  <input
                    id={`add-device-asset-${ticket.id}`}
                    type="text"
                    className="mono"
                    value={draft.assetTag}
                    disabled={draft.identifiersNotApplicable}
                    onChange={(event) => setDraft({ ...draft, assetTag: event.target.value })}
                  />
                </Field>
                <div className="field">
                  <span className="field-label">Identifiers</span>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.identifiersNotApplicable}
                      onChange={(event) =>
                        setDraft({ ...draft, identifiersNotApplicable: event.target.checked })
                      }
                    />
                    <span className="check-text">Serial and asset tag not applicable</span>
                  </label>
                </div>
              </div>
            </fieldset>
            <div className="form-actions">
              <Button type="submit" size="sm" disabled={pendingKey !== null} loading={saving}>
                Save device
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
