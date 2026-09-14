/**
 * Who carried what: resolved tickets and logged time over the range, beside the
 * tickets each technician still owns.
 *
 * Resolved and time are the period's work; open is right now, which is why the
 * column says so. Nobody is dropped — a table that quietly loses the people who
 * resolved nothing this week reads as a team that is one person smaller — but
 * a colleague with no resolved tickets, no logged time and no open ticket adds
 * a row of dashes and zeroes, and a school that has accumulated accounts over a
 * few years ends up with more of those rows than real ones. They are named in a
 * line under the table instead, so the table is the work and the line is the
 * rest of the team.
 *
 * Sorted by resolved, descending, by the database. It stays that way: this is a
 * short list of colleagues, not a leaderboard to re-rank by clicking.
 */

import { formatMinutes } from '@/lib/format';
import { Avatar, EmptyState } from '@/components/Primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { InsightsTechnician } from '@/lib/data/insights';

const columns: Column<InsightsTechnician>[] = [
  {
    key: 'name',
    header: 'NetRider',
    cell: (row) => (
      <span className="tech-name">
        <Avatar name={row.name} />
        {row.name}
      </span>
    ),
    hideOnPhone: true,
  },
  { key: 'resolved', header: 'Resolved', align: 'right', cell: (row) => row.resolved },
  {
    key: 'minutes',
    header: 'Time logged',
    align: 'right',
    // Logging time is optional, so nothing logged is a blank rather than a zero:
    // "0m" reads as a measurement of work that took no time.
    cell: (row) =>
      row.minutes > 0 ? (
        formatMinutes(row.minutes)
      ) : (
        <span className="tech-blank" aria-label="None logged">
          —
        </span>
      ),
  },
  { key: 'open', header: 'Open now', align: 'right', cell: (row) => row.open },
];

/** Nothing resolved, nothing logged and nothing open: a row of dashes. */
function isQuiet(row: InsightsTechnician): boolean {
  return row.resolved === 0 && row.minutes === 0 && row.open === 0;
}

/** Names in the quiet-technician line, past which it says "and N more" instead. */
const MAX_NAMED_QUIET = 12;

export function TechTable({ rows, days }: { rows: InsightsTechnician[]; days: number }) {
  const busy = rows.filter((row) => !isQuiet(row));
  const quiet = rows.filter(isQuiet);
  // With nobody to show, the table would be an empty state next to a line
  // naming the whole team, which says the same thing twice and buries it in the
  // smaller type. A team that did nothing this range keeps its table.
  const tabled = busy.length === 0 ? rows : busy;
  const named = busy.length === 0 ? [] : quiet;
  const caption =
    `Each NetRider's resolved tickets and logged time over the last ${days} days, and the tickets they own now` +
    (named.length > 0 ? '; colleagues with no activity are named below' : '');
  const shownNames = named.slice(0, MAX_NAMED_QUIET).map((row) => row.name);
  const moreCount = named.length - shownNames.length;

  return (
    <>
      <DataTable
        columns={columns}
        rows={tabled}
        rowKey={(row) => row.accountId}
        cardTitle={(row) => (
          <span className="tech-name">
            <Avatar name={row.name} />
            {row.name}
          </span>
        )}
        caption={caption}
        empty={
          <EmptyState title="No NetRiders yet">
            Accounts appear here once an administrator has added them.
          </EmptyState>
        }
      />
      {named.length > 0 ? (
        <p className="tech-quiet-note">
          <span className="tech-quiet-label">
            No activity in the last {days} days, and nothing open:
          </span>{' '}
          {shownNames.join(', ')}
          {moreCount > 0 ? `, and ${moreCount} more` : ''}
        </p>
      ) : null}
    </>
  );
}
