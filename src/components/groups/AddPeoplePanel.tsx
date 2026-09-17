'use client';

/**
 * The two ways people get into a group.
 *
 * ONE AT A TIME, by search, because half the time a roster changes by one
 * person and finding them is a three-letter type-ahead over the same directory
 * everything else here reads.
 *
 * A WHOLE LIST, pasted, because the other half of the time it arrives as a
 * column out of a spreadsheet: thirty-one OSIS numbers, or a block of names
 * somebody typed in a group chat. Each line is read by `app_find_people` — an
 * identifier matched exactly, a name matched whole and case-folded — and the
 * answers are SHOWN BEFORE ANYTHING IS ADDED. That is the whole point of the
 * middle step: a line that matched nobody, and a name that belongs to two
 * people, are the two things somebody has to see and fix themselves, and they
 * are both invisible in a count of how many landed.
 */

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { addGroupMembersAction, resolvePeopleAction } from '@/lib/data/group-actions';
import { PASTE_LIMIT, type ResolvedPerson } from '@/lib/domain/groups';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { PersonPicker, type PersonSearchResult } from '@/components/people/PersonPicker';

export function AddPeoplePanel({
  groupId,
  memberIds,
}: {
  groupId: string;
  memberIds: string[];
}) {
  const { pendingKey, run } = useRuntime();
  const [paste, setPaste] = useState('');
  const [checking, setChecking] = useState(false);
  const [resolved, setResolved] = useState<ResolvedPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = new Set(memberIds);
  const busy = pendingKey !== null;

  async function addOne(person: PersonSearchResult) {
    await run(`group:add:${person.id}`, () => addGroupMembersAction(groupId, [person.id]));
  }

  async function check() {
    const lines = paste.split('\n');
    setChecking(true);
    setError(null);
    try {
      const answers = await resolvePeopleAction(lines);
      setResolved(answers);
      if (answers.length === 0) {
        setError('There is nothing in the box to look up.');
      }
    } catch {
      setError('That list could not be looked up. Nothing was added.');
    } finally {
      setChecking(false);
    }
  }

  // Everyone the list found who is not in the group already. A person who is
  // both matched and already a member is not an error and not an addition;
  // they are simply already true, and the row says so.
  const matched = (resolved ?? []).filter(
    (row) => row.found === 'match' && row.id !== null,
  );
  const addable = matched.filter((row) => !members.has(row.id as string));
  const missing = (resolved ?? []).filter((row) => row.found === 'none').length;
  const ambiguous = (resolved ?? []).filter((row) => row.found === 'ambiguous').length;

  async function addAll() {
    const ids = addable.map((row) => row.id as string);
    if (ids.length === 0) return;
    const result = await run('group:add-list', () => addGroupMembersAction(groupId, ids));
    if (result.ok) {
      setPaste('');
      setResolved(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="group-add-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="group-add-heading">
          Add people
        </h2>
      </div>
      <div className="panel-body stack">
        <PersonPicker
          id="group-add-person"
          label="Find somebody"
          hint="Name, OSIS, staff ID or email address. They are added straight away."
          onSelect={addOne}
          excludeIds={memberIds}
          excludeNote="already in the group"
          disabled={busy}
        />

        <div className="group-paste">
          <Field
            label="Paste a list"
            htmlFor="group-paste"
            hint={`One per line: OSIS, staff ID, email address or full name. Up to ${PASTE_LIMIT} at a time.`}
          >
            <textarea
              id="group-paste"
              className="group-paste-box"
              rows={6}
              value={paste}
              spellCheck={false}
              onChange={(event) => {
                setPaste(event.target.value);
                setResolved(null);
              }}
              placeholder={'230020049\n230020050\nmarcus.ellery@edison.example\nNia Okonkwo'}
            />
          </Field>
          <div className="btn-row">
            <Button
              onClick={check}
              loading={checking}
              disabled={busy || paste.trim() === ''}
            >
              Check the list
            </Button>
          </div>

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          {resolved !== null && resolved.length > 0 ? (
            <div className="paste-report">
              <p className="paste-summary" role="status">
                {summaryLine(matched.length, addable.length, missing, ambiguous)}
              </p>
              <ul className="paste-rows">
                {resolved.map((row) => (
                  <li key={row.key} className={`paste-row paste-row-${row.found}`}>
                    <span className="paste-key mono">{row.key}</span>
                    <span className="paste-answer">
                      <PasteAnswer row={row} already={row.id !== null && members.has(row.id)} />
                    </span>
                  </li>
                ))}
              </ul>
              <div className="btn-row">
                <Button
                  variant="primary"
                  icon={UserPlus}
                  onClick={addAll}
                  loading={pendingKey === 'group:add-list'}
                  disabled={busy || addable.length === 0}
                >
                  {addable.length === 1 ? 'Add 1 match' : `Add ${addable.length} matches`}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** What one pasted line turned out to be. */
function PasteAnswer({ row, already }: { row: ResolvedPerson; already: boolean }) {
  if (row.found === 'none') return <span className="paste-miss">No match</span>;
  if (row.found === 'ambiguous') {
    return (
      <span className="paste-miss">
        {row.matches} people are called that. Use their OSIS or staff ID.
      </span>
    );
  }
  return (
    <>
      <span className="paste-name">{row.displayName}</span>
      <span className="paste-meta">
        {row.kind ? PERSON_KIND_LABELS[row.kind] : null}
        {row.groupLabel ? `, ${row.groupLabel}` : null}
        {already ? ' — already in the group' : null}
      </span>
    </>
  );
}

/**
 * The count line, which says the three numbers that decide what to do next:
 * how many were found, how many of those are new, and how many lines still
 * need a person's attention.
 */
function summaryLine(
  matched: number,
  addable: number,
  missing: number,
  ambiguous: number,
): string {
  const parts = [`${matched} found`];
  if (matched !== addable) parts.push(`${matched - addable} already in the group`);
  if (missing > 0) parts.push(`${missing} with no match`);
  if (ambiguous > 0) parts.push(`${ambiguous} ambiguous`);
  return `${parts.join(', ')}.`;
}
