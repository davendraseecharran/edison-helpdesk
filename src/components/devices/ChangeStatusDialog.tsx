'use client';

/**
 * Set a device's status by hand, with a reason for the history. `deployed`
 * is not on the list because it means having a holder; a deployed device is
 * returned instead, and the database says so if this is tried on one.
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

export interface ChangeStatusValues {
  status: DeviceStatus;
  reason: string;
}

export function ChangeStatusDialog({
  open,
  onClose,
  subject,
  count = 1,
  current,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  count?: number;
  /** The single device's current status, so the select starts there. */
  current?: DeviceStatus;
  pending: boolean;
  onSubmit: (values: ChangeStatusValues) => Promise<ActionResult>;
}) {
  const initial = current && current !== 'deployed' ? current : 'in_stock';
  const [status, setStatus] = useState<DeviceStatus>(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formId = 'change-status-form';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await onSubmit({ status, reason });
    if (result.ok) {
      setReason('');
      onClose();
    } else {
      setError(result.error ?? 'The status could not be changed.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Change status of ${subject}`}
      description="A device somebody is holding is returned instead, so it keeps its loan history."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            Change status
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <Field label="New status" htmlFor="status-value" error={error}>
          <select
            id="status-value"
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
        <Field label="Reason" htmlFor="status-reason" optional hint="Kept on the history.">
          <input
            id="status-reason"
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={count === 1 ? 'Hinge broken, sent for repair' : 'End of loan cycle'}
          />
        </Field>
      </form>
    </Dialog>
  );
}
