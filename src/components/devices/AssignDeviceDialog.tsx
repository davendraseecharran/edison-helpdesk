'use client';

/**
 * Hand a device, or a selection of devices, to somebody in the directory.
 * The person is found with `PersonPicker`; the device that is already with
 * that person is refused by the database, and a device with another holder
 * is taken back from them first, which the history records on both sides.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  ChosenPerson,
  PersonPicker,
  type PersonSearchResult,
} from '@/components/people/PersonPicker';

export interface AssignDeviceValues {
  person: PersonSearchResult;
  note: string;
}

export function AssignDeviceDialog({
  open,
  onClose,
  subject,
  count = 1,
  pending,
  currentHolderId,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** What is being assigned: "DOE-LN0000001" or "12 devices". */
  subject: string;
  count?: number;
  pending: boolean;
  /** Shown but not choosable: they have it already. */
  currentHolderId?: string | null;
  onSubmit: (values: AssignDeviceValues) => Promise<ActionResult>;
}) {
  const [person, setPerson] = useState<PersonSearchResult | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formId = 'assign-device-form';

  function reset() {
    setPerson(null);
    setNote('');
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!person) {
      setError('Choose who is receiving the device.');
      return;
    }
    setError(null);
    const result = await onSubmit({ person, note });
    if (result.ok) close();
    else setError(result.error ?? 'The device could not be assigned.');
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Assign ${subject}`}
      description={
        count === 1
          ? 'The device is marked deployed and the loan starts now.'
          : 'Every selected device is marked deployed and its loan starts now.'
      }
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending} disabled={!person}>
            {count === 1 ? 'Assign device' : `Assign ${count} devices`}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        {person ? (
          <div className="field">
            <span className="field-label">Assign to</span>
            <ChosenPerson person={person} onChange={() => setPerson(null)} />
          </div>
        ) : (
          <PersonPicker
            id="assign-person"
            label="Assign to"
            autoFocus
            onSelect={setPerson}
            excludeIds={currentHolderId ? [currentHolderId] : undefined}
            excludeNote="already holding it"
            error={person ? null : error}
          />
        )}
        <Field label="Note" htmlFor="assign-note" optional hint="Kept on the device's and the person's history.">
          <textarea
            id="assign-note"
            value={note}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Loaner while the screen is repaired"
          />
        </Field>
        {person && error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
