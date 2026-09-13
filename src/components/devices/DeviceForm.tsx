'use client';

/**
 * Add or correct one inventory record.
 *
 * Identifiers first, because one of them is what a technician has in their
 * hand; the database wants at least one and upper-cases all three. Status is
 * on the form for a machine nobody holds; a deployed one is deployed because
 * somebody holds it, so the select is locked and points at Return instead.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { saveDeviceAction, type DeviceFields } from '@/lib/data/device-actions';
import type { ActionResult } from '@/lib/data/actions';
import { deviceErrorField } from '@/lib/domain/records';
import {
  DEVICE_STATUS_LABELS,
  MANUAL_DEVICE_STATUSES,
  type Device,
  type DeviceStatus,
} from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';

const TYPE_SUGGESTIONS = [
  'Laptop',
  'Chromebook',
  'Desktop',
  'Tablet',
  'Projector',
  'Interactive panel',
  'Printer',
  'Phone',
  'Network equipment',
];

type Draft = Required<DeviceFields>;

function draftFrom(device?: Device): Draft {
  return {
    device_id: device?.deviceId ?? '',
    serial_number: device?.serialNumber ?? '',
    asset_tag: device?.assetTag ?? '',
    type: device?.type ?? 'Laptop',
    manufacturer: device?.manufacturer ?? '',
    model: device?.model ?? '',
    os: device?.os ?? '',
    status: device?.status ?? 'in_stock',
    location: device?.location ?? '',
    notes: device?.notes ?? '',
  };
}

export const DEVICE_FORM_ID = 'device-form';

export interface DeviceFormProps {
  device?: Device;
  /** Somebody is holding it, so its status is not the form's to change. */
  held?: boolean;
  types: string[];
  locations: string[];
  onSaved: (id: string) => void;
  actions?: ReactNode;
  formId?: string;
}

export function DeviceForm({
  device,
  held = false,
  types,
  locations,
  onSaved,
  actions,
  formId = DEVICE_FORM_ID,
}: DeviceFormProps) {
  const { run } = useRuntime();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(device));
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const key = device ? `save-device:${device.id}` : 'save-device';

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function errorFor(field: string): string | null {
    return error?.field === field ? error.message : null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const fields: DeviceFields & { id?: string } = { ...draft, id: device?.id };
    // A held device keeps its status; sending it would only invite a refusal.
    if (held) delete fields.status;
    const result: ActionResult = await run(key, () => saveDeviceAction(fields));
    if (result.ok) {
      onSaved(result.id ?? device?.id ?? '');
    } else {
      const message = result.error ?? 'The device could not be saved.';
      setError({ field: deviceErrorField(message), message });
    }
  }

  const typeSuggestions = Array.from(new Set([...types, ...TYPE_SUGGESTIONS]));
  const identifierError = errorFor('asset_tag') ?? errorFor('serial_number') ?? errorFor('device_id');
  const identifierHint = 'At least one of the three. Stored in capitals.';

  return (
    <form id={formId} className="form device-form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field
          label="Asset tag"
          htmlFor="device-asset-tag"
          optional
          error={errorFor('asset_tag')}
          hint={identifierError ? undefined : identifierHint}
        >
          <input
            id="device-asset-tag"
            type="text"
            className="mono"
            value={draft.asset_tag}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorFor('asset_tag') ? 'true' : undefined}
            onChange={(event) => set('asset_tag', event.target.value)}
            placeholder="DOE-LN0000001"
            data-autofocus
          />
        </Field>
        <Field label="Serial number" htmlFor="device-serial" optional error={errorFor('serial_number')}>
          <input
            id="device-serial"
            type="text"
            className="mono"
            value={draft.serial_number}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorFor('serial_number') ? 'true' : undefined}
            onChange={(event) => set('serial_number', event.target.value)}
            placeholder="PF3HK2QJ"
          />
        </Field>
        <Field
          label="Device ID"
          htmlFor="device-device-id"
          optional
          error={errorFor('device_id')}
          hint="The managed-device id, for Windows machines."
        >
          <input
            id="device-device-id"
            type="text"
            className="mono"
            value={draft.device_id}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorFor('device_id') ? 'true' : undefined}
            onChange={(event) => set('device_id', event.target.value)}
            placeholder="PW0FYJ9B-WIN"
          />
        </Field>
        <Field label="Type" htmlFor="device-type">
          <input
            id="device-type"
            type="text"
            list="device-type-suggestions"
            value={draft.type}
            autoComplete="off"
            onChange={(event) => set('type', event.target.value)}
            placeholder="Laptop"
          />
          <datalist id="device-type-suggestions">
            {typeSuggestions.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </Field>
        <Field label="Manufacturer" htmlFor="device-manufacturer" optional>
          <input
            id="device-manufacturer"
            type="text"
            value={draft.manufacturer}
            autoComplete="off"
            onChange={(event) => set('manufacturer', event.target.value)}
            placeholder="Lenovo"
          />
        </Field>
        <Field label="Model" htmlFor="device-model" optional>
          <input
            id="device-model"
            type="text"
            value={draft.model}
            autoComplete="off"
            onChange={(event) => set('model', event.target.value)}
            placeholder="13w Yoga"
          />
        </Field>
        <Field label="OS" htmlFor="device-os" optional>
          <input
            id="device-os"
            type="text"
            value={draft.os}
            autoComplete="off"
            onChange={(event) => set('os', event.target.value)}
            placeholder="Windows 11"
          />
        </Field>
        <Field
          label="Status"
          htmlFor="device-status"
          error={errorFor('status')}
          hint={
            held
              ? 'Deployed while somebody holds it. Return the device to change it.'
              : 'Deployed is set by assigning the device to a person.'
          }
        >
          {held ? (
            <input id="device-status" type="text" value={DEVICE_STATUS_LABELS.deployed} readOnly disabled />
          ) : (
            <select
              id="device-status"
              value={draft.status}
              aria-invalid={errorFor('status') ? 'true' : undefined}
              onChange={(event) => set('status', event.target.value as DeviceStatus)}
            >
              {MANUAL_DEVICE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {DEVICE_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Location" htmlFor="device-location" optional hint="A room, a cart or a shelf.">
          <input
            id="device-location"
            type="text"
            list="device-location-suggestions"
            value={draft.location}
            autoComplete="off"
            onChange={(event) => set('location', event.target.value)}
            placeholder="Cart 4"
          />
          <datalist id="device-location-suggestions">
            {locations.map((location) => (
              <option key={location} value={location} />
            ))}
          </datalist>
        </Field>
        <Field label="Notes" htmlFor="device-notes" optional className="form-grid-full">
          <textarea
            id="device-notes"
            value={draft.notes}
            rows={3}
            onChange={(event) => set('notes', event.target.value)}
            placeholder="Cracked bezel, works fine"
          />
        </Field>
      </div>

      {error && !error.field ? (
        <p className="flash flash-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {actions ? <div className="form-actions">{actions}</div> : null}
    </form>
  );
}

/** The submit button for either variant; `form` ties it to the form from a footer. */
export function DeviceFormSubmit({
  device,
  formId = DEVICE_FORM_ID,
}: {
  device?: Device;
  formId?: string;
}) {
  const { pendingKey } = useRuntime();
  const key = device ? `save-device:${device.id}` : 'save-device';
  return (
    <Button type="submit" form={formId} variant="primary" loading={pendingKey === key}>
      {device ? 'Save device' : 'Add device'}
    </Button>
  );
}
