'use client';

/**
 * The audit log.
 *
 * One question, asked in five ways: who changed what, when, and was an
 * assistant involved. Ticket history, account history and record history are
 * one list here because that is how the question is actually asked — nobody
 * wondering who deactivated an account wants to know which table it landed in.
 *
 * Every filter lives in the URL and is applied by `app_audit_log` against the
 * whole history, never by this component against the page it was handed. A
 * filtered log is therefore shareable, survives a refresh, and pages correctly:
 * the total under the filter bar is the count of matching events, not the count
 * of the fifty on screen.
 */

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';
import { ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import type { AuditEntry, AuditLogPage } from '@/lib/data/audit';

/**
 * A stored kind as a person reads it: `returned_to_queue` becomes "Returned to
 * queue". Only the first letter is touched, so a kind that already carries an
 * initialism keeps it rather than being flattened to lower case.
 */
export function auditKindLabel(kind: string): string {
  const words = kind.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words === '') return 'Change';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The entity types that have a page of their own. The rest are plain text. */
const ENTITY_HREF: Record<string, (id: string) => string> = {
  ticket: (id) => `/tickets/${id}`,
  person: (id) => `/people/${id}`,
  device: (id) => `/devices/${id}`,
};

const ENTITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'ticket', label: 'Tickets' },
  { value: 'account', label: 'Accounts' },
  { value: 'person', label: 'People' },
  { value: 'device', label: 'Devices' },
  { value: 'invite', label: 'Invites' },
  { value: 'import', label: 'Imports' },
];

export function AuditLog({ page }: { page: AuditLogPage }) {
  const { directory } = useRuntime();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      actor: searchParams.get('actor') ?? 'all',
      via: searchParams.get('via') ?? 'all',
      entity: searchParams.get('entity') ?? 'all',
      kind: searchParams.get('kind') ?? '',
      from: searchParams.get('from') ?? '',
      to: searchParams.get('to') ?? '',
    }),
    [searchParams],
  );

  const filtersActive =
    current.actor !== 'all' ||
    current.via !== 'all' ||
    current.entity !== 'all' ||
    current.kind.trim() !== '' ||
    current.from !== '' ||
    current.to !== '';

  /**
   * The kind field is the one control that is typed rather than chosen, so it
   * holds a local draft between keystrokes and only reaches the URL on Enter
   * or on blur. The draft is keyed to the query string: "Clear filters", the
   * back button and a pasted link all change `searchParams`, React remounts
   * the state with the new key, and the box shows what the URL actually says
   * instead of the last thing anybody typed into it.
   */
  const queryKey = searchParams.toString();
  const [kindDraft, setKindDraft] = useState(current.kind);
  const [kindKey, setKindKey] = useState(queryKey);
  if (kindKey !== queryKey) {
    setKindKey(queryKey);
    setKindDraft(current.kind);
  }

  // A datalist of what is actually on this page. It is a hint, not a closed
  // set: the field still accepts any kind, so a value read off an older page
  // still works when it is typed in by hand.
  const kindsOnPage = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of page.entries) seen.add(entry.kind);
    return [...seen].sort();
  }, [page.entries]);

  function updateParam(name: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === '' || value === 'all') next.delete(name);
    else next.set(name, value);
    // Any filter change starts again at the first page, or page four of the
    // old filter would be a page of nothing under the new one.
    next.delete('page');
    startNavigation(() => router.replace(`${pathname}?${next.toString()}`));
  }

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  const columns: Column<AuditEntry>[] = [
    {
      key: 'at',
      header: 'When',
      hideOnPhone: true,
      width: 150,
      cell: (entry) => (
        <span className="audit-when">
          <TimeAgo iso={entry.at} />
        </span>
      ),
    },
    {
      key: 'who',
      header: 'Who',
      hideOnPhone: true,
      width: 190,
      cell: (entry) => <AuditActor entry={entry} />,
    },
    {
      key: 'kind',
      header: 'What',
      hideOnPhone: true,
      width: 180,
      cell: (entry) => auditKindLabel(entry.kind),
    },
    {
      key: 'record',
      header: 'Record',
      hideOnPhone: true,
      width: 170,
      cell: (entry) => <AuditRecord entry={entry} />,
    },
    {
      key: 'summary',
      header: 'Summary',
      cell: (entry) =>
        entry.summary || entry.detail ? (
          <div className="audit-summary">
            {entry.summary ? <span>{entry.summary}</span> : null}
            {entry.detail ? <span className="audit-detail">{entry.detail}</span> : null}
          </div>
        ) : null,
    },
  ];

  const { entries, total, pageCount } = page;

  return (
    <section
      className="panel audit"
      data-busy={navigating || undefined}
      aria-busy={navigating || undefined}
    >
      <FilterBar
        label="Audit filters"
        active={filtersActive}
        clearHref={pathname}
        summary={navigating ? 'Loading' : `${total} ${total === 1 ? 'event' : 'events'}`}
      >
        <div className="audit-filters">
          <Field label="Actor" htmlFor="audit-actor">
            <Select
              id="audit-actor"
              value={current.actor}
              onChange={(value) => updateParam('actor', value)}
              options={[
                { value: 'all', label: 'Anyone' },
                ...directory.map((account) => ({
                  value: account.id,
                  label: account.displayName,
                })),
              ]}
            />
          </Field>

          <div className="field audit-via">
            <span className="field-label">Made by</span>
            <SegmentedControl
              label="Made by"
              size="sm"
              value={current.via}
              options={[
                { value: 'all', label: 'Anyone' },
                { value: 'user', label: 'People' },
                { value: 'ai', label: 'Their AI' },
              ]}
              onChange={(value) => updateParam('via', value)}
            />
          </div>

          <Field label="Record type" htmlFor="audit-entity">
            <Select
              id="audit-entity"
              value={current.entity}
              onChange={(value) => updateParam('entity', value)}
              options={ENTITY_OPTIONS}
            />
          </Field>

          <Field label="Kind" htmlFor="audit-kind" hint="Exact kind, such as resolved">
            <input
              id="audit-kind"
              type="text"
              list="audit-kind-options"
              value={kindDraft}
              placeholder="Any kind"
              onChange={(event) => setKindDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') updateParam('kind', kindDraft.trim());
              }}
              onBlur={() => {
                if (kindDraft.trim() !== current.kind) updateParam('kind', kindDraft.trim());
              }}
            />
            <datalist id="audit-kind-options">
              {kindsOnPage.map((kind) => (
                <option key={kind} value={kind} />
              ))}
            </datalist>
          </Field>

          <Field label="From" htmlFor="audit-from">
            <input
              id="audit-from"
              type="date"
              value={current.from}
              max={current.to || undefined}
              onChange={(event) => updateParam('from', event.target.value)}
            />
          </Field>

          <Field label="To" htmlFor="audit-to">
            <input
              id="audit-to"
              type="date"
              value={current.to}
              min={current.from || undefined}
              onChange={(event) => updateParam('to', event.target.value)}
            />
          </Field>
        </div>
      </FilterBar>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing recorded for these filters."
          action={filtersActive ? <ButtonLink href={pathname}>Clear filters</ButtonLink> : undefined}
        >
          {filtersActive
            ? 'Widen the dates or drop a filter to see more of the history.'
            : 'Every change to a ticket, account, person, device, invite or import appears here as it happens.'}
        </EmptyState>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={entries}
            rowKey={(entry) => `${entry.source}:${entry.id}`}
            caption="Every recorded change, newest first"
            settle
            cardTitle={(entry) => (
              <span className="audit-card-title">
                <AuditActor entry={entry} />
                <span className="audit-card-kind">{auditKindLabel(entry.kind)}</span>
              </span>
            )}
            cardMeta={(entry) => (
              <span className="audit-card-meta">
                <AuditRecord entry={entry} />
                <TimeAgo iso={entry.at} />
              </span>
            )}
          />
          <Pagination
            page={page.page}
            pageCount={pageCount}
            hrefFor={hrefForPage}
            label="Audit pages"
          />
        </>
      )}
    </section>
  );
}

/**
 * Who acted. A row with no account behind it is a trusted server flow — an
 * import finishing, a credential binding — and says "System" rather than
 * pretending somebody pressed something.
 */
function AuditActor({ entry }: { entry: AuditEntry }) {
  if (!entry.actorName) return <span className="muted">System</span>;
  return <ActorLabel name={entry.actorName} via={entry.performedVia} model={entry.aiModel} />;
}

/**
 * What the event was about. The label links when the record has a page; a
 * label that came back empty means the record itself is gone, which is said
 * plainly rather than papered over with an identifier nobody can look up.
 */
function AuditRecord({ entry }: { entry: AuditEntry }) {
  if (!entry.entityLabel) return <span className="muted">(deleted)</span>;
  const href = entry.entityId ? ENTITY_HREF[entry.entityType]?.(entry.entityId) : undefined;
  if (!href) return <span className="audit-record">{entry.entityLabel}</span>;
  return (
    <Link href={href} className="audit-record audit-record-link">
      {entry.entityLabel}
    </Link>
  );
}
