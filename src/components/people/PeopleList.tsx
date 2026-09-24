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
 * them, copy their addresses, take them as a file. The selection outlives a
 * search or a page change — tick three people, search for a fourth, tick them
 * too — because that is how a list of recipients is built. So nobody acts on a
 * row they cannot see without knowing it, the bar counts the ones out of view
 * and opens into the whole list, each removable. The rows are kept as they were
 * read, so nothing is fetched for them. Boxes can be painted: press and drag
 * down the column, or shift-click for a range. The header's version of the same
 * controls acts on the whole filter instead, which is a different question and
 * a different read.
 */

import { startTransition, useEffect, useMemo, useRef, useState, useTransition, type ComponentProps } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { PeoplePage } from '@/lib/data/people';
import type { GmailMode } from '@/lib/domain/preferences';
import {
  directoryTailColumns,
  personPlacement,
  personSubtitle,
  type DirectoryTailColumn,
} from '@/lib/domain/records';
import { type PersonKind, type PersonSummary } from '@/lib/domain/types';
import type { PersonAddressee } from '@/lib/people/clipboard';
import { ArchivedBadge } from '@/components/Badges';
import { EmptyState, Field } from '@/components/Primitives';
import { RollingNumber } from '@/components/ui/RollingNumber';
import { ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SelectionTray } from '@/components/ui/SelectionTray';
import { useKeptSelection, usePaintSelect } from '@/components/ui/useSelection';
import { useUrlSearch } from '@/components/ui/useUrlSearch';
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
  paint,
}: {
  person: PersonSummary;
  checked: boolean;
  onToggle: (id: string, on: boolean) => void;
  paint?: ComponentProps<'label'>;
}) {
  return (
    <label className="row-check" {...paint}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Select ${person.displayName}`}
        onChange={(event) => onToggle(person.id, event.target.checked)}
      />
    </label>
  );
}

const personKey = (person: PersonSummary) => person.id;

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
  other = null,
  gmailMode = 'cc',
  canExport = false,
  ticketWorker = true,
}: {
  page: PeoplePage;
  /** The other list's first page, when the page loaded it, so a switch is a swap rather than a round trip. */
  other?: PeoplePage | null;
  gmailMode?: GmailMode;
  canExport?: boolean;
  /** Whether the reader works tickets. It decides the last two columns. */
  ticketWorker?: boolean;
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

  // The search box is typed into locally and pushed to the URL after a pause,
  // so typing "Whit" is one round trip rather than four; `useUrlSearch` keeps
  // what was typed while an earlier push is still loading.
  const search = useUrlSearch(current.query, (query) => updateParams({ query }), SEARCH_DEBOUNCE_MS);

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const params = next.toString();
    return params ? `${pathname}?${params}` : pathname;
  }

  /*
   * Which list is showing. Normally the URL's; for the moment between a
   * press on the students/staff control and the server's answer it is the
   * pressed one, drawn from the other list the page already holds. Rendered
   * in a transition so the pill's own motion is never queued behind the
   * table's re-render.
   */
  const [shownKind, setShownKind] = useState<PersonKind>(current.kind);
  const [urlKind, setUrlKind] = useState<PersonKind>(current.kind);
  if (urlKind !== current.kind) {
    setUrlKind(current.kind);
    setShownKind(current.kind);
  }
  const swapped = shownKind !== current.kind && other !== null;
  const shown = swapped ? other : page;
  const { people, total, pageCount, openTickets, groups } = shown;
  // Waiting on the server only when there was nothing to swap to.
  const busy = navigating && !swapped;
  const isStudent = shownKind === 'student';

  function chooseKind(value: PersonKind) {
    if (value === shownKind) return;
    startTransition(() => setShownKind(value));
    updateParams({ kind: value === 'staff' ? 'staff' : '' });
  }

  // Ticked people, kept across searches and pages; see the file comment.
  const selection = useKeptSelection(people, personKey);
  const paint = usePaintSelect({
    order: selection.onPage,
    isOn: selection.has,
    apply: selection.apply,
  });
  const chosen = useMemo(() => selection.items.map(addresseeOf), [selection.items]);
  const chosenKinds = new Set(selection.items.map((person) => person.kind));

  const selectAllRef = useRef<HTMLInputElement>(null);
  const { someOnPage, allOnPage } = selection;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  // One file is one list: a selection of students and staff together is
  // written to and copied, but exported a list at a time.
  const selectionKind = chosenKinds.size === 1 ? [...chosenKinds][0] : null;
  const selectionExportHref =
    canExport && selectionKind
      ? `/people/export?${new URLSearchParams({
          ...(selectionKind === 'staff' ? { kind: 'staff' } : {}),
          ids: selection.items.map((person) => person.id).join(','),
        }).toString()}`
      : null;

  /*
   * The end of the row, which is a different pair of facts for a technician
   * and for a skills officer. Both pairs are declared; `directoryTailColumns`
   * picks, and the data behind the pair nobody is shown was never read.
   */
  const tail: Record<DirectoryTailColumn, Column<PersonSummary>> = {
    devices: {
      key: 'devices',
      header: 'Devices',
      align: 'right',
      width: 96,
      cell: (person) =>
        person.deviceCount > 0 ? person.deviceCount : <span className="dir-quiet">0</span>,
    },
    /*
     * Tickets still waiting on an answer. It is the question somebody scans
     * this list for — who is stuck — and until now it took opening each
     * record to find out. A zero is set quiet, so the column reads as the
     * few names that have something open rather than as a wall of noughts.
     */
    open: {
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
    /*
     * The address, for the reader whose work is writing to people. Mono
     * because an address is an identifier: it is read character by character
     * when it is read at all, and a proportional font hides the difference
     * between an l and a 1.
     */
    email: {
      key: 'email',
      header: 'Email',
      mono: true,
      width: 240,
      cell: (person) => person.email || <span className="dir-quiet">None</span>,
    },
    /*
     * Which rosters somebody is on. A skills officer's whole question about a
     * name is which of their groups it belongs to, and the answer took opening
     * every group to find.
     */
    groups: {
      key: 'groups',
      header: 'Groups',
      hideOnPhone: true,
      width: 220,
      cell: (person) => {
        const names = groups[person.id] ?? [];
        return names.length > 0 ? names.join(', ') : <span className="dir-quiet">None</span>;
      },
    },
  };

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
            onChange={(event) => selection.setAllOnPage(event.target.checked)}
          />
        </label>
      ),
      hideOnPhone: true,
      width: 40,
      cell: (person) => (
        <RowCheck
          person={person}
          checked={selection.has(person.id)}
          onToggle={paint.change}
          paint={paint.boxProps(person.id)}
        />
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
    ...directoryTailColumns(ticketWorker).map((key) => tail[key]),
  ];

  return (
    <section
      className="panel directory"
      data-busy={busy || undefined}
      aria-busy={busy || undefined}
      data-painting={paint.painting || undefined}
    >
      <FilterBar
        label="Directory filters"
        active={filtersActive}
        clearHref={current.kind === 'student' ? pathname : `${pathname}?kind=staff`}
        summary={
          <span className="summary-count" data-busy={busy || undefined}>
            <RollingNumber value={total} /> {total === 1 ? 'person' : 'people'}
          </span>
        }
      >
        <div className="dir-filters">
          <div className="field field-segmented">
            <span className="field-label">List</span>
            <SegmentedControl
              label="List"
              value={shownKind}
              options={KIND_OPTIONS}
              onChange={(value) => chooseKind(value === 'staff' ? 'staff' : 'student')}
            />
          </div>
          <Field label="Search" htmlFor="people-search" className="field-search">
            <input
              id="people-search"
              type="search"
              name="query"
              autoComplete="off"
              placeholder={isStudent ? 'Name, OSIS, class or address' : 'Name, staff ID, email or department'}
              value={search.value}
              onChange={(event) => search.setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') search.commit();
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
                <RowCheck person={person} checked={selection.has(person.id)} onToggle={paint.change} />
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

          <Pagination
            page={page.page}
            pageCount={pageCount}
            hrefFor={hrefForPage}
            label="Directory pages"
          />
        </>
      )}

      <SelectionTray
        label="Selected people"
        count={selection.size}
        offPage={selection.offPage}
        noun={['person', 'people']}
        items={selection.items.map((person) => ({
          id: person.id,
          title: person.displayName,
          meta: person.kind === 'staff' ? 'Staff' : 'Student',
          code: person.externalId || undefined,
          href: `/people/${person.id}`,
        }))}
        onRemove={selection.remove}
        onClear={selection.clear}
      >
        <PeopleActions
          people={chosen}
          label={`${selection.size} selected`}
          kind={selectionKind ?? current.kind}
          gmailMode={gmailMode}
          exportHref={selectionExportHref}
          size="sm"
        />
      </SelectionTray>
    </section>
  );
}
