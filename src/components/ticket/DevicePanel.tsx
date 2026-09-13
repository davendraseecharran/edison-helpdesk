'use client';

import { useState } from 'react';
import type { TicketDetail } from '@/lib/domain/selectors';
import { canContribute } from '@/lib/domain/permissions';
import { recordDeviceAction } from '@/lib/data/actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Field, TimeAgo } from '@/components/Primitives';

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
    <div className="card">
      <div className="card-header">
        <h2>
          Devices
          <span className="badge badge-neutral">{detail.devices.length}</span>
        </h2>
        {mayAdd ? (
          <button type="button" className="btn btn-sm" onClick={() => setOpen((value) => !value)}>
            {open ? 'Cancel' : 'Record device'}
          </button>
        ) : null}
      </div>
      <div className="card-body stack">
        {detail.devices.length === 0 ? (
          <p className="small muted">
            No devices recorded. A room-wide fault may legitimately have none.
          </p>
        ) : (
          detail.devices.map((device) => (
            <div className="device" key={device.id}>
              <div className="device-head">
                <strong>{device.deviceType}</strong>
                <span className="small subtle">
                  {nameOf(directory, device.recordedById)} · <TimeAgo iso={device.recordedAt} />
                </span>
              </div>
              <div className="device-specs">
                <div>
                  <div className="device-spec-label">Manufacturer / model</div>
                  <div>{[device.manufacturer, device.model].filter(Boolean).join(' ') || 'Unknown'}</div>
                </div>
                <div>
                  <div className="device-spec-label">OS / firmware</div>
                  <div>{device.osVersion ?? 'Unknown'}</div>
                </div>
                <div>
                  <div className="device-spec-label">Serial</div>
                  <div className={device.serialNumber ? 'mono' : undefined}>
                    {device.identifiersNotApplicable
                      ? 'Not applicable'
                      : (device.serialNumber ?? 'Unknown')}
                  </div>
                </div>
                <div>
                  <div className="device-spec-label">Asset tag</div>
                  <div className={device.assetTag ? 'mono' : undefined}>
                    {device.identifiersNotApplicable
                      ? 'Not applicable'
                      : (device.assetTag ?? 'Unknown')}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}

        {open && mayAdd ? (
          <form onSubmit={onSubmit} className="stack-sm">
            <fieldset>
              <legend>New device observation</legend>
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
                    value={draft.serialNumber}
                    disabled={draft.identifiersNotApplicable}
                    onChange={(event) => setDraft({ ...draft, serialNumber: event.target.value })}
                  />
                </Field>
                <Field label="Asset tag" htmlFor={`add-device-asset-${ticket.id}`} optional>
                  <input
                    id={`add-device-asset-${ticket.id}`}
                    type="text"
                    value={draft.assetTag}
                    disabled={draft.identifiersNotApplicable}
                    onChange={(event) => setDraft({ ...draft, assetTag: event.target.value })}
                  />
                </Field>
                <div className="field">
                  <span className="field-label">Identifiers</span>
                  <label className="checkbox-row small">
                    <input
                      type="checkbox"
                      checked={draft.identifiersNotApplicable}
                      onChange={(event) =>
                        setDraft({ ...draft, identifiersNotApplicable: event.target.checked })
                      }
                    />
                    <span>Serial and asset tag not applicable</span>
                  </label>
                </div>
              </div>
            </fieldset>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Saving…' : 'Save device'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
