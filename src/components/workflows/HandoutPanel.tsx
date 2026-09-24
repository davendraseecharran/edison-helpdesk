'use client';

/**
 * Who is taking them.
 *
 * Hand-out mode is two beats repeated down a line of students: their ID
 * card, then their laptop. The card can be scanned into the same field as the
 * laptops (a code that is no machine but is exactly one person switches to
 * them), typed, or found by name here. "Next person" clears the card so the
 * next one can be read.
 */

import { UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { PersonPicker, type PersonSearchResult } from '@/components/people/PersonPicker';
import type { WorkflowPerson } from '@/lib/workflows/session';

export interface HandoutPanelProps {
  person: WorkflowPerson | null;
  /** How many this run has handed to the current person. */
  given: number;
  onChoose: (person: WorkflowPerson | null) => void;
  finished: boolean;
}

export function personFromSearch(result: PersonSearchResult): WorkflowPerson {
  return {
    id: result.id,
    displayName: result.displayName,
    kind: result.kind,
    externalId: result.identifier ?? '',
    // Unknown from a search; a scanned card knows.
    holding: -1,
  };
}

export function HandoutPanel({ person, given, onChoose, finished }: HandoutPanelProps) {
  if (!person) {
    return (
      <section className="wf-person wf-person-empty" aria-label="Who is taking them">
        <p className="wf-person-prompt">Scan their ID card into the field, or find them here.</p>
        <PersonPicker
          id="wf-person-search"
          label="Find a person"
          hint="Name, OSIS or staff ID."
          disabled={finished}
          onSelect={(result) => onChoose(personFromSearch(result))}
        />
      </section>
    );
  }

  const holding = person.holding >= 0 ? person.holding + given : null;
  return (
    <section className="wf-person" aria-label="Handing out to">
      <span className="wf-person-avatar" aria-hidden="true">
        <Icon icon={UserRound} size={20} />
      </span>
      <div className="wf-person-text">
        <p className="wf-person-name">{person.displayName}</p>
        <p className="wf-person-meta">
          {person.kind === 'staff' ? 'Staff' : 'Student'}
          {person.externalId ? (
            <>
              , <span className="mono">{person.externalId}</span>
            </>
          ) : null}
          {holding !== null ? `. Holds ${holding === 1 ? '1 device' : `${holding} devices`}.` : '.'}
        </p>
      </div>
      <Button variant="secondary" onClick={() => onChoose(null)} disabled={finished}>
        Next person
      </Button>
    </section>
  );
}
