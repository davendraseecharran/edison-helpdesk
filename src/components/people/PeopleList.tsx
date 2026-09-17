'use client';

/**
 * The directory list.
 *
 * Students and staff are two lists rather than one list with a filter, because
 * `app_list_people` takes a kind and because that is how the school talks about
 * them. The tab and the search term live in the URL and are applied by the
 * database against 3,709 real people, so a narrowed roster is shareable and
 * nothing is filtered client-side for security. The search runs as you type,
 * after a short pause, because a directory is something you narrow rather than
 * query.
 *
 * Rows can be ticked, the same way the inventory's can, and a bar for the
 * selection carries the things somebody does with a handful of people: write to
 * them, copy their addresses, take them as a file. The selection is the rows on
 * THIS page only — a page change or a new search cannot leave somebody acting
 * on a row they can no longer see — and the people in it are already on screen,
 * so nothing is fetched for it. The header's version of the same controls acts
 * on the whole filter instead, which is a different question and a different
 * read.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { PeoplePage } from '@/lib/data/people';
import type { GmailMode } from '@/lib/domain/preferences';
import { personPlacement, personSubtitle } from '@/lib/domain/records';
import { type PersonKind, type PersonSummary } from '@/lib/domain/types';
import type { PersonAddressee } from '@/lib/people/clipboard';
import { ArchivedBadge } from '@/components/Badges';
import { EmptyState, Field } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PeopleActions } from './PeopleActions';

/**
 * One row's checkbox. Declared here, not inside the list, so React keeps the
 * same element across renders: a component declared in the parent's body is a
 * new type every render, which remounts the box and drops keyboard focus on
 * every tick.
 */
function RowCheck({
  person,
  checked,
  onToggle,
}: {
  person: PersonSummary;
  checked: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <label className="row-check">
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Select ${person.displayName}`}
        onChange={(event) => onToggle(person.id, event.target.checked)}
      />
    </label>
  );
}

/** A directory row, as much of it as writing to somebody or listing them needs. */
function addresseeOf(person: PersonSummary): PersonAddressee {
  return {
    id: person.id,
    displayName: person.displayName,
    email: person.email || null,
    externalId: person.externalId || null,
    kind: person.kind,
    guardianName: person.guardianName || null,
    guardianPhone: person.guardianPhone || null,
  };
}

const KIND_OPTIONS: { value: PersonKind; label: string }[] = [
  { value: 'student', label: 'Students' },
  { value: 'staff', label: 'Staff' },
];

/** After the last keystroke, before the URL (and so the database) is asked. */
const SEARCH_DEBOUNCE_MS = 250;

export function PeopleList({
  page,
  gmailMode = 'cc',
  canExport = false,
}: {
  page: PeoplePage;
  gmailMode?: GmailMode;
  canExport?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      query: searchParams.get('query') ?? '',
      kind: (searchParams.get('kind') === 'staff' ? 'staff' : 'student') as PersonKind,
    }),
    [searchParams],
  );

  const filtersActive = current.query.trim() !== '';

  /** Any change resets to page 1; an empty value drops the parameter. */
  function updateParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    next.delete('page');
    const query = next.toString();
    startNavigation(() => router.replace(query ? `${pathname}?${query}` : pathname));
  }

  // The search box is controlled locally and pushed to the URL after a pause,
  // so typing "Whit" is one round trip rather than four. When the URL changes
  // under it (Clear filters, the back button) the box follows during render,
  // which is React's way of deriving state from a prop without an extra pass.
  const [query, setQuery] = useState(current.query);
  const [seen, setSeen] = useState(current.query);
  if (seen !== current.query) {
    setSeen(current.query);
    setQuery(current.query);
  }
  useEffect(() => {
    if (query === current.query) return;
    const timer = setTimeout(() => updateParams({ query }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // updateParams reads the latest params itself; re-running on every
    // params change would restart the pause mid-word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, current.query]);

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const params = next.toString();
    return params ? `${pathname}?${params}` : pathname;
  }

  const { people, total, pageCount, openTickets } = page;
  const busy = navigating;
  const isStudent = current.kind === 'student';

  // Ticked ids. Only the ones on the current page count: a filter or a page
  // change cannot leave a hidden row in the selection, and the ids fall out of
  // the set the next time it is rebuilt.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const selected = useMemo(() => {
    const onPage = new Set(people.map((person) => person.id));
    return new Set([...ticked].filter((id) => onPage.has(id)));
  }, [ticked, people]);

  const chosen = useMemo(
    () => people.filter((person) => selected.has(person.id)).map(addresseeOf),
    [people, selected],
  );

  const allOnPage = people.length > 0 && people.every((person) => selected.has(person.id));
  const someOnPage = people.some((person) => selected.has(person.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  function toggle(id: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setTicked(on ? new Set(people.map((person) => person.id)) : new Set());
  }

  const selectionExportHref = canExport
    ? `/people/export?${new URLSearchParams({
        ...(current.kind === 'staff' ? { kind: 'staff' } : {}),
        ids: [...selected].join(','),
      }).toString()}`
    : null;

  const columns: Column<PersonSummary>[] = [
    {
      key: 'select',
      header: (
        <label className="row-check">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allOnPage}
            aria-label="Select everybody on this page"
            onChange={(event) => toggleAll(event.target.checked)}
          />
        </label>
      ),
      hideOnPhone: true,
      width: 40,
      cell: (person) => (
        <RowCheck person={person} checked={selected.has(person.id)} onToggle={toggle} />
      ),
    },
    {
      key: 'name',
      header: 'Name',
      hideOnPhone: true,
      cell: (person) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/people/${person.id}`} className="dir-name row-link">
              {person.displayName}
            </Link>
            {/* Beside the name rather than in a column of its own: almost
                nobody in the directory has left, so a column would be empty
                down its whole length to say something about one row. */}
            {person.archivedAt ? <ArchivedBadge /> : null}
          </span>
          <span className="dir-sub">{personSubtitle(person)}</span>
        </div>
      ),
    },
    {
      key: 'id',
      header: isStudent ? 'OSIS' : 'Staff ID',
      mono: true,
      width: 128,
      cell: (person) => person.externalId || <span className="dir-quiet">None</span>,
    },
    {
      key: 'placement',
      header: isStudent ? 'Class' : 'Department',
      hideOnPhone: true,
      width: 220,
      cell: (person) => personPlacement(person) || <span className="dir-quiet">Not recorded</span>,
    },
    {
      key: 'devices',
      header: 'Devices',
      align: 'right',
      width: 96,
      cell: (person) =>
        person.deviceCount > 0 ? person.deviceCount : <span className="dir-quiet">0</span>,
    },
    {
      /*
       * Tickets still waiting on an answer. It is the question somebody scans
       * this list for — who is stuck — and until now it took opening each
       * record to find out. A zero is set quiet, so the column reads as the
       * few names that have something open rather than as a wall of noughts;
       * an account that may read the roster but no tickets sees every row
       * quiet, which is the truth for them.
       */
      key: 'open',
      header: 'Open',
      align: 'right',
      width: 88,
      cell: (person) => {
        const count = openTickets[person.id] ?? 0;
        // Not a link: the name in the same row already goes to the record, and
        // that record is where the tickets are listed.
        return count > 0 ? count : <span className="dir-quiet">0</span>;
      },
    },
  ];

  return (
    <section className="panel directory" data-busy={busy || undefined} aria-busy={busy || undefined}>
      <FilterBar
        label="Directory filters"
        active={filtersActive}
        clearHref={current.kind === 'student' ? pathname : `${pathname}?kind=staff`}
        summary={busy ? 'Loading' : `${total} ${total === 1 ? 'person' : 'people'}`}
      >
        <div className="dir-filters">
          <div className="field field-segmented">
            <span className="field-label">List</span>
            <SegmentedControl
              label="List"
              value={current.kind}
              options={KIND_OPTIONS}
              onChange={(value) => updateParams({ kind: value === 'staff' ? 'staff' : '' })}
            />
          </div>
          <Field label="Search" htmlFor="people-search" className="field-search">
            <input
              id="people-search"
              type="search"
              name="query"
              autoComplete="off"
              placeholder={isStudent ? 'Name, OSIS, class or address' : 'Name, staff ID, email or department'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') updateParams({ query });
              }}
            />
          </Field>
        </div>
      </FilterBar>

      {people.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="Nobody matches this search"
            action={
              <ButtonLink href={current.kind === 'student' ? pathname : `${pathname}?kind=staff`}>
                Clear the search
              </ButtonLink>
            }
          >
            Try fewer letters, or the other list. A student is not in the staff list and a member of
            staff is not in the students list.
          </EmptyState>
        ) : (
          <EmptyState
            title={isStudent ? 'No students yet' : 'No staff yet'}
            action={
              <ButtonLink href={`/people/new?kind=${current.kind}`} icon={Plus} variant="primary">
                Add a person
              </ButtonLink>
            }
          >
            The directory is empty. Add somebody, or ask an administrator to load the roster.
          </EmptyState>
        )
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={people}
            rowKey={(person) => person.id}
            caption={isStudent ? 'Students in the directory' : 'Staff in the directory'}
            settle
            cardTitle={(person) => (
              <span className="dir-card-title">
                <RowCheck person={person} checked={selected.has(person.id)} onToggle={toggle} />
                <span className="dir-name-row">
                  <Link href={`/people/${person.id}`} className="row-link">
                    {person.displayName}
                  </Link>
                  {person.archivedAt ? <ArchivedBadge /> : null}
                </span>
              </span>
            )}
            cardMeta={(person) => personSubtitle(person)}
          />

          {selected.size > 0 ? (
            <div className="bulk-bar" role="region" aria-label="Selected people">
              <span className="bulk-bar-count" aria-live="polite">
                {selected.size} selected
              </span>
              <div className="bulk-bar-actions">
                <PeopleActions
                  people={chosen}
                  label={`${selected.size} selected`}
                  kind={current.kind}
                  gmailMode={gmailMode}
                  exportHref={selectionExportHref}
                  size="sm"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="bulk-bar-clear"
                onClick={() => setTicked(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <Pagination
            page={page.page}
            pageCount={pageCount}
            hrefFor={hrefForPage}
            label="Directory pages"
          />
        </>
      )}
    </section>
  );
}
