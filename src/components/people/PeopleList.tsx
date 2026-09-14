'use client';

/**
 * The directory list.
 *
 * Filters and pagination live in the URL and are applied by the database
 * (`app_list_people_m5`, SECURITY INVOKER) against the rows RLS allows, so a
 * filtered roster is shareable and nothing is filtered client-side for
 * security. The search runs as you type, after a short pause, because a
 * directory is something you narrow rather than query.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus, Upload } from 'lucide-react';
import type { PeopleFacets, PeoplePage } from '@/lib/data/people';
import { personPlacement, personSubtitle } from '@/lib/domain/records';
import { type PersonKind, type PersonSummary } from '@/lib/domain/types';
import { useActorAccount } from '@/components/AppRuntime';
import { ArchivedBadge } from '@/components/Badges';
import { EmptyState, Field } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

type KindFilter = 'all' | PersonKind;

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'student', label: 'Students' },
  { value: 'staff', label: 'Staff' },
];

/** After the last keystroke, before the URL (and so the database) is asked. */
const SEARCH_DEBOUNCE_MS = 250;

export function PeopleList({ page, facets }: { page: PeoplePage; facets: PeopleFacets }) {
  const actor = useActorAccount();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      query: searchParams.get('query') ?? '',
      kind: (searchParams.get('kind') ?? 'all') as KindFilter,
      department: searchParams.get('department') ?? 'all',
      classOf: searchParams.get('classOf') ?? 'all',
      archived: searchParams.get('archived') === '1',
    }),
    [searchParams],
  );

  const filtersActive =
    current.query.trim() !== '' ||
    current.kind !== 'all' ||
    current.department !== 'all' ||
    current.classOf !== 'all' ||
    current.archived;

  /** Any filter change resets to page 1; an empty value drops the parameter. */
  function updateParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === '' || value === 'all') next.delete(name);
      else next.set(name, value);
    }
    next.delete('page');
    const query = next.toString();
    startNavigation(() => router.replace(query ? `${pathname}?${query}` : pathname));
  }

  // The search box is controlled locally and pushed to the URL after a pause,
  // so typing "Whit" is one round trip rather than four. When the URL changes
  // under it (Clear filters, the back button) the box follows.
  const [query, setQuery] = useState(current.query);
  // The URL's value the box was last set from. When it changes underneath
  // (Clear filters, the back button), the box follows during render, which is
  // React's way of deriving state from a prop without an extra effect pass.
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

  const { people, total, pageCount } = page;
  const busy = navigating;
  // A technician's count is of the tickets they may see, and the header says
  // so rather than letting a smaller number read as the whole truth.
  const ticketsHeader = actor.role === 'admin' ? 'Open tickets' : 'Open tickets you can see';

  const columns: Column<PersonSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      hideOnPhone: true,
      cell: (person) => (
        <div className="dir-cell-title">
          <Link href={`/people/${person.id}`} className="dir-name">
            {person.displayName}
          </Link>
          <span className="dir-sub">
            {personSubtitle(person)}
            {person.active ? null : (
              <>
                {' '}
                <ArchivedBadge />
              </>
            )}
          </span>
        </div>
      ),
    },
    {
      key: 'id',
      header: 'ID',
      mono: true,
      width: 128,
      cell: (person) =>
        person.osis ?? person.staffId ?? <span className="dir-quiet">None</span>,
    },
    {
      key: 'placement',
      header: 'Department or class',
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
      key: 'tickets',
      header: ticketsHeader,
      align: 'right',
      hideOnPhone: true,
      width: actor.role === 'admin' ? 112 : 180,
      cell: (person) =>
        person.openTicketCount > 0 ? person.openTicketCount : <span className="dir-quiet">0</span>,
    },
  ];

  return (
    <section className="panel directory" data-busy={busy || undefined} aria-busy={busy || undefined}>
      <FilterBar
        label="Directory filters"
        active={filtersActive}
        clearHref={pathname}
        summary={busy ? 'Loading' : `${total} ${total === 1 ? 'person' : 'people'}`}
      >
        <div className="dir-filters">
          <Field label="Search" htmlFor="people-search" className="field-search">
            <input
              id="people-search"
              type="search"
              name="query"
              autoComplete="off"
              placeholder="Name, email, OSIS or staff ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') updateParams({ query });
              }}
            />
          </Field>
          <div className="field field-segmented">
            <span className="field-label">Kind</span>
            <SegmentedControl
              label="Kind"
              value={current.kind}
              options={KIND_OPTIONS}
              onChange={(value) => updateParams({ kind: value })}
            />
          </div>
          <Field label="Department" htmlFor="people-department">
            <select
              id="people-department"
              value={current.department}
              onChange={(event) => updateParams({ department: event.target.value })}
            >
              <option value="all">Any department</option>
              {facets.departments.map((department) => (
                <option key={department} value={department}>
                  {department}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Class of" htmlFor="people-class-of">
            <select
              id="people-class-of"
              value={current.classOf}
              onChange={(event) => updateParams({ classOf: event.target.value })}
            >
              <option value="all">Any year</option>
              {facets.classYears.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </Field>
          <div className="field field-check">
            <span className="field-label" aria-hidden="true">
              Archived
            </span>
            <label className="check">
              <input
                type="checkbox"
                checked={current.archived}
                onChange={(event) => updateParams({ archived: event.target.checked ? '1' : '' })}
              />
              <span className="check-text">Show archived</span>
            </label>
          </div>
        </div>
      </FilterBar>

      {people.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="No people match these filters"
            action={<ButtonLink href={pathname}>Clear filters</ButtonLink>}
          >
            Try fewer letters, or clear a filter. Archived people are hidden unless you show them.
          </EmptyState>
        ) : (
          <EmptyState
            title="No people yet"
            action={
              <>
                <ButtonLink href="/admin" icon={Upload}>
                  Import the directory
                </ButtonLink>
                <ButtonLink href="/people/new" icon={Plus} variant="primary">
                  Add a person
                </ButtonLink>
              </>
            }
          >
            Import the directory or add a person.
          </EmptyState>
        )
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={people}
            rowKey={(person) => person.id}
            caption="People in the directory"
            settle
            cardTitle={(person) => (
              <Link href={`/people/${person.id}`}>
                {person.displayName}
                {person.active ? null : (
                  <>
                    {' '}
                    <ArchivedBadge />
                  </>
                )}
              </Link>
            )}
            cardMeta={(person) => personSubtitle(person)}
          />
          <Pagination page={page.page} pageCount={pageCount} hrefFor={hrefForPage} label="Directory pages" />
        </>
      )}
    </section>
  );
}
