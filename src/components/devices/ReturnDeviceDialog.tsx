'use client';

/**
 * Take a device back from whoever holds it, and say what state it came back
 * in. In stock is the default because that is what a return usually is; the
 * other choices are for a machine that came back broken, or did not come
 * back at all. `deployed` is not offered: it means having a holder.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import {
  DEVICE_STATUS_LABELS,
  MANUAL_DEVICE_STATUSES,
  type DeviceStatus,
} from '@/lib/domain/types';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export interface ReturnDeviceValues {
  status: DeviceStatus;
  note: string;
}

export function ReturnDeviceDialog({
  open,
  onClose,
  subject,
  count = 1,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** What is being returned: "DOE-LN0000001" or "12 devices". */
  subject: string;
  count?: number;
  pending: boolean;
  onSubmit: (values: ReturnDeviceValues) => Promise<ActionResult>;
}) {
  const [status, setStatus] = useState<DeviceStatus>('in_stock');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formId = 'return-device-form';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await onSubmit({ status, note });
    if (result.ok) {
      setStatus('in_stock');
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
          <select
            id="return-status"
            value={status}
            data-autofocus
            aria-invalid={error ? 'true' : undefined}
            onChange={(event) => setStatus(event.target.value as DeviceStatus)}
          >
            {MANUAL_DEVICE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {DEVICE_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {count === 1 ? (
          <Field label="Note" htmlFor="return-note" optional hint="Kept on the device's and the person's history.">
            <textarea
              id="return-note"
              value={note}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Charger missing; screen scratched on the left"
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
