'use client';

/**
 * Find one person in 2,800 without leaving the form.
 *
 * Results are grouped under Students and Staff, each showing the name and
 * the identifier a technician would check it against: an OSIS or a staff id,
 * else the class or department. Used by device assignment, and made for the
 * intake form to adopt.
 */

import { searchPeopleAction, type PersonSearchResult } from '@/lib/data/people-actions';
import { groupPeople } from '@/lib/domain/records';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { SearchPicker } from '@/components/directory/SearchPicker';

export type { PersonSearchResult };

export interface PersonPickerProps {
  id: string;
  label?: string;
  hint?: string;
  placeholder?: string;
  onSelect: (person: PersonSearchResult) => void;
  /** People who can be seen but not chosen, for example the current holder. */
  excludeIds?: string[];
  excludeNote?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string | null;
}

export function PersonPicker({
  id,
  label = 'Find a person',
  hint = 'Search by name, OSIS, staff ID or email address.',
  placeholder = 'Whitfield or 240000123',
  onSelect,
  excludeIds,
  excludeNote,
  autoFocus,
  disabled,
  error,
}: PersonPickerProps) {
  return (
    <SearchPicker<PersonSearchResult>
      id={id}
      label={label}
      hint={hint}
      placeholder={placeholder}
      search={searchPeopleAction}
      keyOf={(person) => person.id}
      groups={(items) =>
        groupPeople(items).map((group) => ({
          key: group.kind,
          label: group.label,
          items: group.items,
        }))
      }
      renderOption={(person) => (
        <>
          <span className="picker-option-name">{person.displayName}</span>
          <span className="picker-option-meta">
            {PERSON_KIND_LABELS[person.kind]}
            {person.identifier ? (
              <>
                , <span className="mono">{person.identifier}</span>
              </>
            ) : person.descriptor ? (
              `, ${person.descriptor}`
            ) : null}
          </span>
        </>
      )}
      onSelect={onSelect}
      disabledKeys={excludeIds}
      disabledNote={excludeNote}
      autoFocus={autoFocus}
      disabled={disabled}
      error={error}
      emptyText={(term) => `Nobody in the directory matches "${term}".`}
    />
  );
}

/** The chosen person, shown in place of the search until "Change" is pressed. */
export function ChosenPerson({
  person,
  onChange,
  changeLabel = 'Change',
}: {
  person: PersonSearchResult;
  onChange: () => void;
  changeLabel?: string;
}) {
  return (
    <div className="picker-chosen">
      <span className="person-text">
        <span className="person-name">{person.displayName}</span>
        <span className="person-meta">
          {PERSON_KIND_LABELS[person.kind]}
          {person.identifier ? (
            <>
              , <span className="mono">{person.identifier}</span>
            </>
          ) : person.descriptor ? (
            `, ${person.descriptor}`
          ) : null}
        </span>
      </span>
      <span className="person-end">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onChange}>
          {changeLabel}
        </button>
      </span>
    </div>
  );
}
