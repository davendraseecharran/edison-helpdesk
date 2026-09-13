'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { recordDeviceAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';

const EMPTY_DRAFT = {
  deviceType: '',
  model: '',
  osVersion: '',
  serialNumber: '',
  assetTag: '',
  identifiersNotApplicable: false,
};

/**
 * Device observations recorded at service time. Unknown serials and asset tags
 * are allowed: the plan requires that missing identifiers never block the record.
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
          Devices observed
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
                    {nameOf(directory, device.recordedById)}, <TimeAgo iso={device.recordedAt} />
                  </span>
                </div>
                <dl className="device-specs">
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
                </dl>
              </li>
            ))}
          </ul>
        )}

        {open && mayAdd ? (
          <form onSubmit={onSubmit} className="form">
            <fieldset className="draft">
              <legend>New device</legend>
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
