import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadResolvedStats } from '@/lib/data/resolved-stats';
import { PageHeader } from '@/components/Primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import {
  barPercent,
  formatHours,
  maxResolved,
  PERIOD_LABELS,
  PRIORITY_ORDER,
  statsSentence,
  STATS_PERIODS,
  topCategory,
  toStatsPeriod,
  type ResolverStats,
} from '@/lib/domain/resolved-stats';
import { PRIORITY_LABELS, TICKET_CATEGORY_LABELS } from '@/lib/domain/types';

export const metadata = { title: 'Resolved analytics — Edison Helpdesk' };

/** The footer's own row, named where a person's name would be. */
const TOTALS_LABEL = 'The desk';
const TOTALS_KEY = 'totals';

/**
 * Who resolved what, over a period.
 *
 * Administrator only. Unlike /admin, this one redirects rather than answering
 * not-found: every NetRider already has the Resolved list this page hangs off,
 * so the page's existence is not the secret — the ranking is. Sending them back
 * to the list they came from is the honest answer, and the database refuses
 * them the figures independently.
 */
export default async function ResolvedAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') redirect('/resolved');

  const period = toStatsPeriod((await searchParams).period);
  const stats = await loadResolvedStats(period);

  const most = maxResolved(stats.resolvers);
  /*
   * The totals row rides with the people or not at all: a footer under an empty
   * table is four zeros and a rule, which takes a panel's worth of screen to
   * repeat what the empty line already said.
   */
  const rows: ResolverStats[] =
    stats.resolvers.length > 0 && stats.totals ? [...stats.resolvers, stats.totals] : [];

  const columns: Column<ResolverStats>[] = [
    {
      key: 'who',
      header: 'NetRider',
      // The name is the phone card's headline, so the column would repeat it.
      hideOnPhone: true,
      cell: (row) => (
        <>
          <span className="stat-who">
            {row.resolverId === null ? TOTALS_LABEL : row.resolverName}
          </span>
          {/*
            A reopen is the one fact here that is not a quantity of work, so it
            sits under the name rather than in a column of its own: most rows
            have none, and a column of blanks is a column that has to be read
            anyway.
          */}
          {row.reopenedCount > 0 ? (
            <span className="stat-sub">{row.reopenedCount} reopened</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'resolved',
      header: 'Resolved',
      align: 'right',
      width: 140,
      cell: (row) => (
        <span className="stat-count">
          {/*
            The bar carries no information the number does not; it carries the
            comparison, which is the thing a column of numbers is worst at. It
            is drawn for the people and not for the totals row, whose length
            against itself would always be the full width and would say nothing.
          */}
          {row.resolverId === null ? null : (
            <span className="stat-bar" aria-hidden="true">
              <span
                className="stat-bar-fill"
                style={{ width: `${barPercent(row.resolvedCount, most)}%` }}
              />
            </span>
          )}
          <span className="stat-number">{row.resolvedCount}</span>
        </span>
      ),
    },
    ...PRIORITY_ORDER.map<Column<ResolverStats>>((priority) => ({
      key: priority,
      header: PRIORITY_LABELS[priority],
      align: 'right',
      width: 72,
      cell: (row) => row.byPriority[priority],
    })),
    {
      key: 'median',
      header: 'Median time',
      align: 'right',
      width: 110,
      /*
       * The median, with the mean on the cell's own title. The gap between the
       * two is what says a long tail exists — a median of three hours beside a
       * mean of two days is one machine that sat on the bench over a holiday —
       * and that is worth having without spending a column on it.
       */
      cell: (row) => (
        <span title={row.meanHours === null ? undefined : `Mean ${formatHours(row.meanHours)}`}>
          {row.medianHours === null ? (
            <span className="subtle">None</span>
          ) : (
            formatHours(row.medianHours)
          )}
        </span>
      ),
    },
    {
      key: 'category',
      header: 'Top category',
      cell: (row) => {
        const category = topCategory(row.byCategory);
        if (category === null) return <span className="subtle">None</span>;
        return TICKET_CATEGORY_LABELS[category];
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Resolved analytics"
        description="Who closed what, how hard it was and how long it took. Counted from the resolver on each ticket, so a collaborator who wrote the solution is credited for it. Cancellations are not resolutions and never appear here."
      />

      <nav className="segmented period-links" aria-label="Period">
        {STATS_PERIODS.map((option) => (
          <Link
            key={option}
            href={`/resolved/analytics?period=${option}`}
            className="segmented-option"
            aria-current={option === period ? 'page' : undefined}
          >
            <span>{PERIOD_LABELS[option]}</span>
          </Link>
        ))}
      </nav>

      {/*
        One line, in one place. When there is something to report it is the
        lead; when there is not, the same sentence would be the table's empty
        state as well, and a page that says "nothing resolved" twice reads as a
        page that is not sure.
      */}
      {rows.length > 0 ? <p className="stats-lead">{statsSentence(stats)}</p> : null}

      <section className="panel">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.resolverId ?? TOTALS_KEY}
          // A data attribute rather than a class: `rowProps` is spread over the
          // element after its own className, so a class here would take the
          // phone card's `row-card` away with it.
          rowProps={(key) => (key === TOTALS_KEY ? { 'data-total': 'true' } : {})}
          caption="Resolved tickets by NetRider for the chosen period, with the desk's totals last."
          cardTitle={(row) => (row.resolverId === null ? TOTALS_LABEL : row.resolverName)}
          cardMeta={(row) => (row.reopenedCount > 0 ? `${row.reopenedCount} reopened` : null)}
          empty={
            <p className="empty-line">
              {stats.ok
                ? 'Nothing resolved in this period.'
                : 'The figures could not be read. Try again.'}
            </p>
          }
        />
      </section>
    </>
  );
}
