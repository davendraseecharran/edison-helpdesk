'use client';

/**
 * Add or correct one directory record.
 *
 * Kind comes first because it decides which fields follow: a student has an
 * OSIS, a class and a parent to call; a member of staff has a staff id, a
 * department and a role. Every value is sent, blank ones included, so a
 * cleared field really clears; the database does the normalising (case,
 * separators) and the validating, and its message lands beside the field it
 * names when it names one.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { savePersonAction, type PersonFields } from '@/lib/data/people-actions';
import type { ActionResult } from '@/lib/data/actions';
import { personErrorField } from '@/lib/domain/records';
import { PERSON_KIND_LABELS, type Person, type PersonKind } from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

const KIND_OPTIONS: { value: PersonKind; label: string }[] = [
  { value: 'student', label: PERSON_KIND_LABELS.student },
  { value: 'staff', label: PERSON_KIND_LABELS.staff },
];

type Draft = Required<Omit<PersonFields, 'kind'>> & { kind: PersonKind };

function draftFrom(person?: Person): Draft {
  return {
    kind: person?.kind ?? 'student',
    first_name: person?.firstName ?? '',
    last_name: person?.lastName ?? '',
    display_name: person?.displayName ?? '',
    email: person?.email ?? '',
    osis: person?.osis ?? '',
    staff_id: person?.staffId ?? '',
    school_dbn: person?.schoolDbn ?? '',
    department: person?.department ?? '',
    role_title: person?.roleTitle ?? '',
    official_class: person?.officialClass ?? '',
    class_of: person?.classOf ?? '',
    parent_name: person?.parentName ?? '',
    parent_phone: person?.parentPhone ?? '',
    home_phone: person?.homePhone ?? '',
    address: person?.address ?? '',
    notes: person?.notes ?? '',
  };
}

export const PERSON_FORM_ID = 'person-form';

export interface PersonFormProps {
  /** Absent for a new record. */
  person?: Person;
  /** Known departments, offered as suggestions. */
  departments: string[];
  /** Called with the record id after a successful save. */
  onSaved: (id: string) => void;
  /** Rendered after the fields; the sheet variant puts its buttons in the footer instead. */
  actions?: ReactNode;
  formId?: string;
}

export function PersonForm({
  person,
  departments,
  onSaved,
  actions,
  formId = PERSON_FORM_ID,
}: PersonFormProps) {
  const { run } = useRuntime();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(person));
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const key = person ? `save-person:${person.id}` : 'save-person';

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function errorFor(field: string): string | null {
    return error?.field === field ? error.message : null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const student = draft.kind === 'student';
    // The other kind's fields go as blanks: changing a student into staff
    // means their OSIS and parent details no longer apply, and a blank is how
    // the database clears a column.
    const fields: PersonFields & { id?: string } = {
      ...draft,
      osis: student ? draft.osis : '',
      official_class: student ? draft.official_class : '',
      class_of: student ? draft.class_of : '',
      parent_name: student ? draft.parent_name : '',
      parent_phone: student ? draft.parent_phone : '',
      home_phone: student ? draft.home_phone : '',
      address: student ? draft.address : '',
      staff_id: student ? '' : draft.staff_id,
      department: student ? '' : draft.department,
      role_title: student ? '' : draft.role_title,
      school_dbn: student ? '' : draft.school_dbn,
      id: person?.id,
    };
    const result: ActionResult = await run(key, () => savePersonAction(fields));
    if (result.ok) {
      onSaved(result.id ?? person?.id ?? '');
    } else {
      const message = result.error ?? 'The person could not be saved.';
      setError({ field: personErrorField(message), message });
    }
  }

  const student = draft.kind === 'student';
  const nameHint = draft.display_name.trim()
    ? undefined
    : 'Shown everywhere. Left blank, it is the first and last name together.';

  return (
    <form id={formId} className="form person-form" onSubmit={submit} noValidate>
      <div className="field">
        <span className="field-label">Kind</span>
        <SegmentedControl
          label="Kind"
          value={draft.kind}
          options={KIND_OPTIONS}
          onChange={(value) => set('kind', value)}
        />
        {errorFor('kind') ? (
          <span className="field-error" role="alert">
            {errorFor('kind')}
          </span>
        ) : null}
      </div>

      <div className="form-grid">
        <Field label="First name" htmlFor="person-first-name" error={errorFor('first_name')}>
          <input
            id="person-first-name"
            type="text"
            value={draft.first_name}
            autoComplete="off"
            aria-invalid={errorFor('first_name') ? 'true' : undefined}
            onChange={(event) => set('first_name', event.target.value)}
            data-autofocus
          />
        </Field>
        <Field label="Last name" htmlFor="person-last-name">
          <input
            id="person-last-name"
            type="text"
            value={draft.last_name}
            autoComplete="off"
            onChange={(event) => set('last_name', event.target.value)}
          />
        </Field>
        <Field label="Display name" htmlFor="person-display-name" optional hint={nameHint}>
          <input
            id="person-display-name"
            type="text"
            value={draft.display_name}
            autoComplete="off"
            onChange={(event) => set('display_name', event.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor="person-email" optional error={errorFor('email')}>
          <input
            id="person-email"
            type="email"
            value={draft.email}
            autoComplete="off"
            aria-invalid={errorFor('email') ? 'true' : undefined}
            onChange={(event) => set('email', event.target.value)}
            placeholder={student ? 'awhitfield@edison.example' : 'rcalloway@edison.example'}
          />
        </Field>

        {student ? (
          <>
            <Field
              label="OSIS"
              htmlFor="person-osis"
              optional
              error={errorFor('osis')}
              hint="6 to 12 digits. Spaces and commas are removed."
            >
              <input
                id="person-osis"
                type="text"
                inputMode="numeric"
                className="mono"
                value={draft.osis}
                autoComplete="off"
                aria-invalid={errorFor('osis') ? 'true' : undefined}
                onChange={(event) => set('osis', event.target.value)}
                placeholder="240000123"
              />
            </Field>
            <Field label="Official class" htmlFor="person-official-class" optional>
              <input
                id="person-official-class"
                type="text"
                value={draft.official_class}
                autoComplete="off"
                onChange={(event) => set('official_class', event.target.value)}
                placeholder="9A"
              />
            </Field>
            <Field label="Class of" htmlFor="person-class-of" optional>
              <input
                id="person-class-of"
                type="text"
                inputMode="numeric"
                value={draft.class_of}
                autoComplete="off"
                onChange={(event) => set('class_of', event.target.value)}
                placeholder="2029"
              />
            </Field>
            <Field label="Parent or guardian" htmlFor="person-parent-name" optional>
              <input
                id="person-parent-name"
                type="text"
                value={draft.parent_name}
                autoComplete="off"
                onChange={(event) => set('parent_name', event.target.value)}
              />
            </Field>
            <Field label="Parent phone" htmlFor="person-parent-phone" optional>
              <input
                id="person-parent-phone"
                type="tel"
                value={draft.parent_phone}
                autoComplete="off"
                onChange={(event) => set('parent_phone', event.target.value)}
              />
            </Field>
            <Field label="Home phone" htmlFor="person-home-phone" optional>
              <input
                id="person-home-phone"
                type="tel"
                value={draft.home_phone}
                autoComplete="off"
                onChange={(event) => set('home_phone', event.target.value)}
              />
            </Field>
            <Field label="Address" htmlFor="person-address" optional className="form-grid-full">
              <textarea
                id="person-address"
                value={draft.address}
                rows={2}
                autoComplete="off"
                onChange={(event) => set('address', event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Staff ID"
              htmlFor="person-staff-id"
              optional
              error={errorFor('staff_id')}
              hint="Stored in capitals."
            >
              <input
                id="person-staff-id"
                type="text"
                className="mono"
                value={draft.staff_id}
                autoComplete="off"
                aria-invalid={errorFor('staff_id') ? 'true' : undefined}
                onChange={(event) => set('staff_id', event.target.value)}
                placeholder="EMP-4021"
              />
            </Field>
            <Field label="Department" htmlFor="person-department" optional>
              <input
                id="person-department"
                type="text"
                list="person-department-options"
                value={draft.department}
                autoComplete="off"
                onChange={(event) => set('department', event.target.value)}
                placeholder="Science"
              />
              <datalist id="person-department-options">
                {departments.map((department) => (
                  <option key={department} value={department} />
                ))}
              </datalist>
            </Field>
            <Field label="Role" htmlFor="person-role" optional>
              <input
                id="person-role"
                type="text"
                value={draft.role_title}
                autoComplete="off"
                onChange={(event) => set('role_title', event.target.value)}
                placeholder="Teacher"
              />
            </Field>
            <Field label="School DBN" htmlFor="person-dbn" optional>
              <input
                id="person-dbn"
                type="text"
                className="mono"
                value={draft.school_dbn}
                autoComplete="off"
                onChange={(event) => set('school_dbn', event.target.value)}
                placeholder="31R445"
              />
            </Field>
          </>
        )}

        <Field
          label="Notes"
          htmlFor="person-notes"
          optional
          className="form-grid-full"
          hint="Read by every NetRider. Not the place for anything a parent would not want them to read."
        >
          <textarea
            id="person-notes"
            value={draft.notes}
            rows={3}
            onChange={(event) => set('notes', event.target.value)}
          />
        </Field>
      </div>

      {error && !error.field ? (
        <p className="flash flash-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {/* The page variant puts its buttons here; the sheet variant puts
          `PersonFormSubmit` in its footer and passes nothing. */}
      {actions ? <div className="form-actions">{actions}</div> : null}
    </form>
  );
}

/** The submit button for either variant; `form` ties it to the form from a footer. */
export function PersonFormSubmit({
  person,
  formId = PERSON_FORM_ID,
}: {
  person?: Person;
  formId?: string;
}) {
  const { pendingKey } = useRuntime();
  const key = person ? `save-person:${person.id}` : 'save-person';
  return (
    <Button type="submit" form={formId} variant="primary" loading={pendingKey === key}>
      {person ? 'Save person' : 'Add person'}
    </Button>
  );
}
