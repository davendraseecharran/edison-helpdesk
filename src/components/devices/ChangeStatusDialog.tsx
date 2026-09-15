'use client';

/**
 * Set a device's status by hand. The list is `app_inventory_statuses()` —
 * every status the district has in use, plus the five it seeds — because
 * `inventory_devices.status` is free text with no closed vocabulary.
 *
 * Assigned is not on the list: it means having a holder, which assigning and
 * returning are for. Setting it here would claim a loan that never started.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import {
  ASSIGNED_STATUS,
  AVAILABLE_STATUS,
  SEED_DEVICE_STATUSES,
  type DeviceStatus,
} from '@/lib/domain/types';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';

export interface ChangeStatusValues {
  status: DeviceStatus;
}

export function ChangeStatusDialog({
  open,
  onClose,
  subject,
  current,
  statuses,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  /** The single device's current status, so the select starts there. */
  current?: DeviceStatus;
  /** The vocabulary from app_inventory_statuses; the seeds when it has not loaded. */
  statuses?: string[];
  pending: boolean;
  onSubmit: (values: ChangeStatusValues) => Promise<ActionResult>;
}) {
  const offered = (statuses?.length ? statuses : SEED_DEVICE_STATUSES).filter(
    (value) => value !== ASSIGNED_STATUS,
  );
  const initial = current && current !== ASSIGNED_STATUS ? current : AVAILABLE_STATUS;
  const [status, setStatus] = useState<DeviceStatus>(initial);
  const [error, setError] = useState<string | null>(null);
  const formId = 'change-status-form';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await onSubmit({ status });
    if (result.ok) {
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
      description="A device somebody is holding is returned instead, so its loan is closed rather than forgotten."
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
          <Select
            id="status-value"
            value={status}
            data-autofocus=""
            aria-invalid={error ? true : undefined}
            onChange={(value) => setStatus(value as DeviceStatus)}
            options={offered.map((value) => ({ value, label: value }))}
          />
        </Field>
      </form>
    </Dialog>
  );
}
