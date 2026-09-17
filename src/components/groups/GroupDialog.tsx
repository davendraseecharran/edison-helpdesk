'use client';

/**
 * The two fields a group is made of.
 *
 * Starting one and renaming one are the same form, so they are the same
 * dialog: a name, a line saying what it is for, and nothing else. Everything
 * that makes a group useful — who is in it, what they are called on the team —
 * is on the group's own page, because that is where somebody is looking when
 * they think of it.
 */

import { useState, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/data/actions';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX } from '@/lib/domain/groups';

export interface GroupValues {
  name: string;
  description: string;
}

export function GroupDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  initial,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  initial?: GroupValues;
  pending: boolean;
  onSubmit: (values: GroupValues) => Promise<ActionResult>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [note, setNote] = useState(initial?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const formId = 'group-form';

  function close() {
    setName(initial?.name ?? '');
    setNote(initial?.description ?? '');
    setError(null);
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Give the group a name.');
      return;
    }
    setError(null);
    const result = await onSubmit({ name: name.trim(), description: note.trim() });
    // The database owns the two rules that can fail here — a name another
    // group already has, and a name of nothing — so its sentence is shown
    // beside the field rather than replaced with one of ours.
    if (result.ok) close();
    else setError(result.error ?? 'That did not go through. Nothing changed.');
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="group-name" error={error}>
          <input
            id="group-name"
            value={name}
            maxLength={GROUP_NAME_MAX}
            autoComplete="off"
            data-autofocus
            onChange={(event) => setName(event.target.value)}
            placeholder="Regionals 2027 competitors"
          />
        </Field>
        <Field
          label="What it is for"
          htmlFor="group-description"
          optional
          hint="One line. It is what the list says under the name."
        >
          <textarea
            id="group-description"
            value={note}
            rows={3}
            maxLength={GROUP_DESCRIPTION_MAX}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Everybody competing at regionals in March."
          />
        </Field>
      </form>
    </Dialog>
  );
}
