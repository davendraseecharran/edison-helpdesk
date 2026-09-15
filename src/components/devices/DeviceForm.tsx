'use client';

/**
 * Add or correct one inventory record.
 *
 * The four the database insists on come first — type, manufacturer, model and
 * serial number — and the first three cascade off `app_device_catalog()`:
 * choosing a type narrows the manufacturers, choosing a manufacturer narrows
 * the models. New values are allowed in all three, because saving one adds it
 * to the catalogue.
 *
 * The inventory id is not a field: `app_save_inventory_device` generates it.
 * Status is free text from `app_inventory_statuses()`, and Assigned is not
 * offered here — a machine is Assigned because somebody is holding it, which
 * is what assigning and returning are for.
 *
 * `version` is round-tripped, so a save against a record somebody else has
 * changed is refused with the database's own words rather than overwriting it.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { saveDeviceAction } from '@/lib/data/device-actions';
import type { ActionResult } from '@/lib/data/actions';
import { deviceErrorField } from '@/lib/domain/records';
import {
  ASSIGNED_STATUS,
  AVAILABLE_STATUS,
  SEED_DEVICE_STATUSES,
  type Device,
  type DeviceCatalogEntry,
  type DeviceInput,
  type DeviceStatus,
} from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { ScanTargetButton } from '@/components/scan/ScanTargetButton';
import { Button } from '@/components/ui/Button';
import { deviceTypeOptions } from '@/lib/domain/device-types';

type Draft = DeviceInput;

function draftFrom(device?: Device): Draft {
  return {
    deviceType: device?.deviceType ?? '',
    manufacturer: device?.manufacturer ?? '',
    model: device?.model ?? '',
    osVersion: device?.osVersion ?? '',
    serialNumber: device?.serialNumber ?? '',
    assetTag: device?.assetTag ?? '',
    status: device?.status ?? AVAILABLE_STATUS,
    location: device?.location ?? '',
    notes: device?.notes ?? '',
    assignedRequesterId: device?.assignedRequesterId ?? null,
  };
}

export const DEVICE_FORM_ID = 'device-form';

export interface DeviceFormProps {
  device?: Device;
  /** The type, manufacturer and model tuples already in the catalogue. */
  catalog: DeviceCatalogEntry[];
  /** The statuses in use, from app_inventory_statuses. */
  statuses: string[];
  locations?: string[];
  onSaved: (id: string) => void;
  actions?: ReactNode;
  formId?: string;
}

export function DeviceForm({
  device,
  catalog,
  statuses,
  locations = [],
  onSaved,
  actions,
  formId = DEVICE_FORM_ID,
}: DeviceFormProps) {
  const { run } = useRuntime();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(device));
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const key = device ? `save-device:${device.id}` : 'save-device';
  const held = draft.assignedRequesterId !== null;

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function errorFor(field: string): string | null {
    return error?.field === field ? error.message : null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result: ActionResult = await run(key, () =>
      saveDeviceAction({ ...draft, id: device?.id ?? null, version: device?.version ?? null }),
    );
    if (result.ok) {
      onSaved(result.id ?? device?.id ?? '');
    } else {
      const message = result.error ?? 'The device could not be saved.';
      setError({ field: deviceErrorField(message), message });
    }
  }

  // The catalogue, cascading. Changing a type clears a manufacturer that no
  // longer belongs to it, so the three fields can never disagree about which
  // machine they describe.
  // The catalogue holds whatever the district typed, so the words it already
  // uses come first through the one vocabulary, and the ones this product knows
  // that the inventory has not seen yet fill the rest of the list.
  const types = useMemo(() => deviceTypeOptions(catalog.map((entry) => entry.deviceType)), [
    catalog,
  ]);
  const manufacturers = useMemo(
    () =>
      [
        ...new Set(
          catalog
            .filter((entry) => !draft.deviceType || entry.deviceType === draft.deviceType)
            .map((entry) => entry.manufacturer),
        ),
      ].sort(),
    [catalog, draft.deviceType],
  );
  const models = useMemo(
    () =>
      [
        ...new Set(
          catalog
            .filter(
              (entry) =>
                (!draft.deviceType || entry.deviceType === draft.deviceType) &&
                (!draft.manufacturer || entry.manufacturer === draft.manufacturer),
            )
            .map((entry) => entry.model),
        ),
      ].sort(),
    [catalog, draft.deviceType, draft.manufacturer],
  );

  const offeredStatuses = (statuses.length ? statuses : SEED_DEVICE_STATUSES).filter(
    (value) => value !== ASSIGNED_STATUS,
  );

  return (
    <form id={formId} className="form device-form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field label="Type" htmlFor="device-type" error={errorFor('deviceType')} hint="New values are allowed.">
          <input
            id="device-type"
            type="text"
            list="device-type-options"
            value={draft.deviceType}
            autoComplete="off"
            aria-invalid={errorFor('deviceType') ? 'true' : undefined}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                deviceType: event.target.value,
                manufacturer: '',
                model: '',
              }))
            }
            placeholder="Chromebook"
            data-autofocus
          />
          <datalist id="device-type-options">
            {types.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </Field>
        <Field label="Manufacturer" htmlFor="device-manufacturer" error={errorFor('manufacturer')}>
          <input
            id="device-manufacturer"
            type="text"
            list="device-manufacturer-options"
            value={draft.manufacturer}
            autoComplete="off"
            aria-invalid={errorFor('manufacturer') ? 'true' : undefined}
            onChange={(event) =>
              setDraft((current) => ({ ...current, manufacturer: event.target.value, model: '' }))
            }
            placeholder="Lenovo"
          />
          <datalist id="device-manufacturer-options">
            {manufacturers.map((manufacturer) => (
              <option key={manufacturer} value={manufacturer} />
            ))}
          </datalist>
        </Field>
        <Field label="Model" htmlFor="device-model" error={errorFor('model')}>
          <input
            id="device-model"
            type="text"
            list="device-model-options"
            value={draft.model}
            autoComplete="off"
            aria-invalid={errorFor('model') ? 'true' : undefined}
            onChange={(event) => set('model', event.target.value)}
            placeholder="13w Yoga"
          />
          <datalist id="device-model-options">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </Field>
        <Field label="Serial number" htmlFor="device-serial" error={errorFor('serialNumber')}>
          {/* A technician holding the laptop reads the label with the phone in
              their other hand rather than typing thirteen characters twice. */}
          <div className="field-with-scan">
            <input
              id="device-serial"
              type="text"
              className="mono"
              value={draft.serialNumber}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errorFor('serialNumber') ? 'true' : undefined}
              onChange={(event) => set('serialNumber', event.target.value)}
              placeholder="PF3HK2QJ"
            />
            <ScanTargetButton label="Serial number" onScan={(code) => set('serialNumber', code)} />
          </div>
        </Field>
        <Field label="Asset tag" htmlFor="device-asset-tag" optional error={errorFor('assetTag')}>
          <div className="field-with-scan">
            <input
              id="device-asset-tag"
              type="text"
              className="mono"
              value={draft.assetTag}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errorFor('assetTag') ? 'true' : undefined}
              onChange={(event) => set('assetTag', event.target.value)}
              placeholder="DOE-LN0000001"
            />
            <ScanTargetButton label="Asset tag" onScan={(code) => set('assetTag', code)} />
          </div>
        </Field>
        <Field label="OS" htmlFor="device-os" optional>
          <input
            id="device-os"
            type="text"
            value={draft.osVersion}
            autoComplete="off"
            onChange={(event) => set('osVersion', event.target.value)}
            placeholder="ChromeOS 126"
          />
        </Field>
        <Field
          label="Status"
          htmlFor="device-status"
          error={errorFor('status')}
          hint={
            held
              ? 'Assigned while somebody holds it. Return the device to change it.'
              : 'Assigned is set by giving the device to a person.'
          }
        >
          {held ? (
            <input id="device-status" type="text" value={ASSIGNED_STATUS} readOnly disabled />
          ) : (
            <input
              id="device-status"
              type="text"
              list="device-status-options"
              value={draft.status}
              autoComplete="off"
              aria-invalid={errorFor('status') ? 'true' : undefined}
              onChange={(event) => set('status', event.target.value as DeviceStatus)}
            />
          )}
          <datalist id="device-status-options">
            {offeredStatuses.map((status) => (
              <option key={status} value={status} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Location"
          htmlFor="device-location"
          optional
          error={errorFor('location')}
          hint="A room, a cart or a shelf."
        >
          <input
            id="device-location"
            type="text"
            list="device-location-options"
            value={draft.location}
            autoComplete="off"
            onChange={(event) => set('location', event.target.value)}
            placeholder="Cart 4"
          />
          <datalist id="device-location-options">
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
