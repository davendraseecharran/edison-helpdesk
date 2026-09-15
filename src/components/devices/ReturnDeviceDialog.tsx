'use client';

/**
 * Take a device back from whoever holds it, and say what state it came back
 * in. Available is the default because that is what a return usually is; the
 * other choices are for a machine that came back broken, or did not come back
 * at all. Assigned is not offered: it means having a holder, which is what a
 * return ends.
 *
 * The list is `app_inventory_statuses()` — every status the district has in
 * use, plus the five it seeds — because `inventory_devices.status` is free
 * text and there is no closed vocabulary to offer instead.
 *
 * The note is offered for one device only, and only when the caller can
 * actually send it: a bulk change goes through app_bulk_update_inventory,
 * which restatuses rather than returning and has nothing to write a note on.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import {
  ASSIGNED_STATUS,
  AVAILABLE_STATUS,
  DEVICE_NOTE_MAX,
  SEED_DEVICE_STATUSES,
  type DeviceStatus,
} from '@/lib/domain/types';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';

export interface ReturnDeviceValues {
  status: DeviceStatus;
  note: string;
}

export function ReturnDeviceDialog({
  open,
  onClose,
  subject,
  statuses,
  count = 1,
  allowNote = true,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** What is being returned: "DOE-LN0000001" or "12 devices". */
  subject: string;
  /** The vocabulary from app_inventory_statuses; the seeds when it has not loaded. */
  statuses?: string[];
  count?: number;
  /** False when the caller cannot send a note anywhere, whatever `count` is. */
  allowNote?: boolean;
  pending: boolean;
  onSubmit: (values: ReturnDeviceValues) => Promise<ActionResult>;
}) {
  const [status, setStatus] = useState<DeviceStatus>(AVAILABLE_STATUS);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formId = 'return-device-form';
  // Assigned is what a return ends, so it is not one of the ways back.
  const offered = (statuses?.length ? statuses : SEED_DEVICE_STATUSES).filter(
    (value) => value !== ASSIGNED_STATUS,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await onSubmit({ status, note });
    if (result.ok) {
      setStatus(AVAILABLE_STATUS);
      setNote('');
      onClose();
    } else {
      setError(result.error ?? 'The device could not be returned.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Return ${subject}`}
      description="The loan is closed and the device gets the status it came back in."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {count === 1 ? 'Return device' : `Return ${count} devices`}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <Field label="Came back as" htmlFor="return-status" error={error}>
          <Select
            id="return-status"
            value={status}
            data-autofocus=""
            aria-invalid={error ? true : undefined}
            onChange={(value) => setStatus(value as DeviceStatus)}
            options={offered.map((value) => ({ value, label: value }))}
          />
        </Field>
        {count === 1 && allowNote ? (
          <Field label="Note" htmlFor="return-note" optional hint="Kept on the device's and the person's history.">
            <textarea
              id="return-note"
              value={note}
              rows={3}
              maxLength={DEVICE_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Charger missing; screen scratched on the left"
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
