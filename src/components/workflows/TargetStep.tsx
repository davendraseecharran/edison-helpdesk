'use client';

/**
 * Step one: what the scans are for.
 *
 * A cart or room for loading and auditing, a status for a restatus run, and
 * for a collection the state and place returned machines should end up in
 * (both optional: by default they go back to Available where they are).
 *
 * Locations are free text in this inventory, so the field offers every
 * location already in use — the way a cart keeps one spelling — and takes a
 * new one as typed, saying so, because a new name is a new place on the next
 * report.
 */

import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import {
  COLLECT_DEFAULT_STATUS,
  LOCATION_MAX,
  targetReady,
  type WorkflowKind,
  type WorkflowTarget,
} from '@/lib/domain/workflows';
import { ASSIGNED_STATUS } from '@/lib/domain/types';

export interface TargetStepProps {
  kind: WorkflowKind;
  initial: WorkflowTarget;
  locations: readonly string[];
  statuses: readonly string[];
  onStart: (target: WorkflowTarget) => void;
}

const COPY: Record<Exclude<WorkflowKind, 'handout'>, { legend: string; start: string }> = {
  move: { legend: 'Which cart or room are they going to?', start: 'Start loading' },
  audit: { legend: 'Which room are you checking?', start: 'Start the audit' },
  status: { legend: 'What status should they get?', start: 'Start scanning' },
  collect: { legend: 'Where do returned machines go?', start: 'Start collecting' },
};

export function TargetStep({ kind, initial, locations, statuses, onStart }: TargetStepProps) {
  const [location, setLocation] = useState(initial.location);
  const [status, setStatus] = useState(
    initial.status || (kind === 'collect' ? COLLECT_DEFAULT_STATUS : ''),
  );
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const copy = COPY[kind === 'handout' ? 'move' : kind];

  const offered = statuses.filter((value) => value !== ASSIGNED_STATUS);
  const needsLocation = kind === 'move' || kind === 'audit';
  const typed = location.trim();
  const isNew =
    typed !== '' && !locations.some((known) => known.trim().toLowerCase() === typed.toLowerCase());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = { location: typed, status: status.trim() };
    if (!targetReady(kind, target)) {
      setError(needsLocation ? 'Choose or type a location.' : 'Choose a status.');
      return;
    }
    if (typed.length > LOCATION_MAX) {
      setError(`Keep the location under ${LOCATION_MAX} characters.`);
      return;
    }
    setError(null);
    onStart(target);
  }

  return (
    <form className="wf-step panel" onSubmit={submit} noValidate>
      <h2 className="wf-step-title">{copy.legend}</h2>
      <div className="wf-step-fields">
        {kind === 'status' || kind === 'collect' ? (
          <Field
            label={kind === 'collect' ? 'They come back as' : 'Status'}
            htmlFor="wf-status"
            error={kind === 'status' ? error : null}
          >
            <Select
              id="wf-status"
              value={status}
              onChange={(value) => setStatus(value)}
              options={[
                ...(kind === 'status' ? [{ value: '', label: 'Choose a status', disabled: true }] : []),
                ...offered.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        ) : null}
        {kind !== 'status' ? (
          <Field
            label={kind === 'collect' ? 'And go to' : 'Location'}
            htmlFor="wf-location"
            optional={kind === 'collect'}
            error={needsLocation ? error : null}
            hint={
              isNew
                ? `${typed} is not a location yet. It will be once a machine is in it.`
                : kind === 'collect'
                  ? 'Leave it blank to keep each machine where it was recorded.'
                  : 'Pick one in use, or type a new one.'
            }
          >
            <input
              id="wf-location"
              type="text"
              list={listId}
              value={location}
              autoComplete="off"
              data-autofocus=""
              autoFocus={needsLocation}
              placeholder={kind === 'audit' ? 'Room 204' : 'Cart 3'}
              aria-invalid={needsLocation && error ? 'true' : undefined}
              onChange={(event) => setLocation(event.target.value)}
            />
            <datalist id={listId}>
              {locations.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </Field>
        ) : null}
      </div>
      <div className="wf-step-foot">
        <Button type="submit" variant="primary" size="lg">
          {copy.start}
        </Button>
      </div>
    </form>
  );
}
