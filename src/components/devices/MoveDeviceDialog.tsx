'use client';

/**
 * Record where a device, or a selection of devices, now lives. The location
 * is free text with the inventory's existing locations as suggestions, so a
 * cart keeps one spelling. Blank clears it.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export function MoveDeviceDialog({
  open,
  onClose,
  subject,
  count = 1,
  current,
  locations,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  count?: number;
  current?: string | null;
  /** Known locations, offered as suggestions. */
  locations: string[];
  pending: boolean;
  onSubmit: (location: string) => Promise<ActionResult>;
}) {
  const [location, setLocation] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const formId = 'move-device-form';
  const listId = 'move-device-locations';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await onSubmit(location.trim());
    if (result.ok) onClose();
    else setError(result.error ?? 'The device could not be moved.');
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move ${subject}`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {count === 1 ? 'Move device' : `Move ${count} devices`}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <Field
          label="Location"
          htmlFor="move-location"
          error={error}
          hint="A room, a cart or a shelf. Leave it blank to clear the location."
        >
          <input
            id="move-location"
            type="text"
            list={listId}
            value={location}
            data-autofocus
            autoComplete="off"
            aria-invalid={error ? 'true' : undefined}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Cart 4"
          />
        </Field>
        <datalist id={listId}>
          {locations.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </form>
    </Dialog>
  );
}
