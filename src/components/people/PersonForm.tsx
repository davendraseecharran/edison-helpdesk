'use client';

/**
 * Add or correct one directory record.
 *
 * Kind decides which fields follow: a student has an OSIS, a class, an
 * enrolment status and a guardian to call; a member of staff has an email that
 * their staff ID is derived from, a department and a role. It is chosen once,
 * when the record is made, and is not offered afterwards — a student does not
 * become a member of staff, and `app_save_person` refuses the change anyway.
 *
 * Every value is sent, blank ones included, so a cleared field really clears.
 * The database validates (`app_validate_profile`), derives the staff ID from
 * the email, and enforces the optimistic lock; its message lands beside the
 * field it names when it names one, and at the foot of the form when it is
 * about the whole record — which "This record changed since you opened it" is.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { savePersonAction } from '@/lib/data/people-actions';
import type { ActionResult } from '@/lib/data/actions';
import { personErrorField } from '@/lib/domain/records';
import {
  PERSON_KIND_LABELS,
  STUDENT_STATUSES,
  STUDENT_STATUS_LABELS,
  type Person,
  type PersonInput,
  type PersonKind,
  type StudentStatus,
} from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';

const KIND_OPTIONS: { value: PersonKind; label: string }[] = [
  { value: 'student', label: PERSON_KIND_LABELS.student },
  { value: 'staff', label: PERSON_KIND_LABELS.staff },
];

type Draft = PersonInput;

function draftFrom(person: Person | undefined, kind: PersonKind): Draft {
  return {
    kind: person?.kind ?? kind,
    displayName: person?.displayName ?? '',
    externalId: person?.externalId ?? '',
    firstName: person?.firstName ?? '',
    lastName: person?.lastName ?? '',
    email: person?.email ?? '',
    schoolDbn: person?.schoolDbn ?? '',
    department: person?.department ?? '',
    staffRole: person?.staffRole ?? '',
    classOf: person?.classOf ?? '',
    studentStatus: person?.studentStatus ?? 'current',
    officialClass: person?.officialClass ?? '',
    guardianName: person?.guardianName ?? '',
    guardianPhone: person?.guardianPhone ?? '',
    homePhone: person?.homePhone ?? '',
    address: person?.address ?? '',
    notes: person?.notes ?? '',
  };
}

/** The staff ID the database will derive, shown live as the email is typed. */
export function staffIdFrom(email: string): string {
  return email.trim().split('@')[0] ?? '';
}

export const PERSON_FORM_ID = 'person-form';

export interface PersonFormProps {
  /** Absent for a new record. */
  person?: Person;
  /** Which list a new record joins. Ignored when editing. */
  kind?: PersonKind;
  /** Known departments and roles, offered as suggestions. New values are allowed. */
  departments: string[];
  roles?: string[];
  /** Called with the record id after a successful save. */
  onSaved: (id: string) => void;
  /** Rendered after the fields; the sheet variant puts its buttons in the footer instead. */
  actions?: ReactNode;
  formId?: string;
}

export function PersonForm({
  person,
  kind = 'student',
  departments,
  roles = [],
  onSaved,
  actions,
  formId = PERSON_FORM_ID,
}: PersonFormProps) {
  const { run } = useRuntime();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(person, kind));
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
    const result: ActionResult = await run(key, () =>
      savePersonAction({ ...draft, id: person?.id ?? null, version: person?.version ?? null }),
    );
    if (result.ok) {
      onSaved(result.id ?? person?.id ?? '');
    } else {
      const message = result.error ?? 'The person could not be saved.';
      setError({ field: personErrorField(message), message });
    }
  }

  const student = draft.kind === 'student';
  const nameHint = draft.displayName.trim()
    ? undefined
    : 'Shown everywhere: on tickets, on devices and in the lookup bar.';

  return (
    <form id={formId} className="form person-form" onSubmit={submit} noValidate>
      {person ? null : (
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
      )}

      <div className="form-grid">
        <Field label="Display name" htmlFor="person-display-name" error={errorFor('displayName')} hint={nameHint}>
          <input
            id="person-display-name"
            type="text"
            value={draft.displayName}
            autoComplete="off"
            aria-invalid={errorFor('displayName') ? 'true' : undefined}
            onChange={(event) => set('displayName', event.target.value)}
            data-autofocus
          />
        </Field>
        <Field label="First name" htmlFor="person-first-name" optional>
          <input
            id="person-first-name"
            type="text"
            value={draft.firstName}
            autoComplete="off"
            onChange={(event) => set('firstName', event.target.value)}
          />
        </Field>
        <Field label="Last name" htmlFor="person-last-name" optional>
          <input
            id="person-last-name"
            type="text"
            value={draft.lastName}
            autoComplete="off"
            onChange={(event) => set('lastName', event.target.value)}
          />
        </Field>

        {student ? (
          <>
            <Field
              label="OSIS"
              htmlFor="person-osis"
              error={errorFor('externalId')}
              hint="Numbers only. Leading zeros are kept."
            >
              <input
                id="person-osis"
                type="text"
                inputMode="numeric"
                className="mono"
                value={draft.externalId}
                autoComplete="off"
                aria-invalid={errorFor('externalId') ? 'true' : undefined}
                onChange={(event) => set('externalId', event.target.value)}
                placeholder="240000123"
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
                placeholder="awhitfield@edison.example"
              />
            </Field>
            <Field label="Official class" htmlFor="person-official-class" optional>
              <input
                id="person-official-class"
                type="text"
                value={draft.officialClass}
                autoComplete="off"
                onChange={(event) => set('officialClass', event.target.value)}
                placeholder="9A"
              />
            </Field>
            <Field label="Class of" htmlFor="person-class-of" optional error={errorFor('classOf')} hint="Four digits.">
              <input
                id="person-class-of"
                type="text"
                inputMode="numeric"
                value={draft.classOf}
                autoComplete="off"
                aria-invalid={errorFor('classOf') ? 'true' : undefined}
                onChange={(event) => set('classOf', event.target.value)}
                placeholder="2029"
              />
            </Field>
            <Field label="Enrolment status" htmlFor="person-student-status">
              <Select
                id="person-student-status"
                value={draft.studentStatus}
                onChange={(value) => set('studentStatus', value as StudentStatus)}
                options={STUDENT_STATUSES.map((status) => ({
                  value: status,
                  label: STUDENT_STATUS_LABELS[status],
                }))}
              />
            </Field>
            <Field label="Parent or guardian" htmlFor="person-guardian-name" optional>
              <input
                id="person-guardian-name"
                type="text"
                value={draft.guardianName}
                autoComplete="off"
                onChange={(event) => set('guardianName', event.target.value)}
              />
            </Field>
            <Field
              label="Guardian phone"
              htmlFor="person-guardian-phone"
              optional
              error={errorFor('guardianPhone')}
            >
              <input
                id="person-guardian-phone"
                type="tel"
                value={draft.guardianPhone}
                autoComplete="off"
                aria-invalid={errorFor('guardianPhone') ? 'true' : undefined}
                onChange={(event) => set('guardianPhone', event.target.value)}
              />
            </Field>
            <Field label="Home phone" htmlFor="person-home-phone" optional>
              <input
                id="person-home-phone"
                type="tel"
                value={draft.homePhone}
                autoComplete="off"
                onChange={(event) => set('homePhone', event.target.value)}
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
              label="Email"
              htmlFor="person-email"
              error={errorFor('email')}
              hint="The staff ID is taken from the part before the @."
            >
              <input
                id="person-email"
                type="email"
                value={draft.email}
                autoComplete="off"
                aria-invalid={errorFor('email') ? 'true' : undefined}
                onChange={(event) => set('email', event.target.value)}
                placeholder="rcalloway@edison.example"
              />
            </Field>
            <Field label="Staff ID" htmlFor="person-staff-id" hint="Taken from the email.">
              <input
                id="person-staff-id"
                type="text"
                className="mono"
                value={staffIdFrom(draft.email) || draft.externalId}
                readOnly
                tabIndex={-1}
              />
            </Field>
            <Field label="Department" htmlFor="person-department" optional hint="New values are allowed.">
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
            <Field label="Role" htmlFor="person-role" optional hint="New values are allowed.">
              <input
                id="person-role"
                type="text"
                list="person-role-options"
                value={draft.staffRole}
                autoComplete="off"
                onChange={(event) => set('staffRole', event.target.value)}
                placeholder="Teacher"
              />
              <datalist id="person-role-options">
                {roles.map((role) => (
                  <option key={role} value={role} />
                ))}
              </datalist>
            </Field>
            <Field label="School DBN" htmlFor="person-dbn" optional>
              <input
                id="person-dbn"
                type="text"
                className="mono"
                value={draft.schoolDbn}
                autoComplete="off"
                onChange={(event) => set('schoolDbn', event.target.value)}
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
