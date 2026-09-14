/**
 * Who carried what: resolved tickets and logged time over the range, beside the
 * tickets each technician still owns.
 *
 * Resolved and time are the period's work; open is right now, which is why the
 * column says so. Every active administrator and technician is listed even with
 * nothing to show, because a table that quietly drops the people who resolved
 * nothing this week would be read as a team that is one person smaller.
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
    header: 'Technician',
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

export function TechTable({ rows, days }: { rows: InsightsTechnician[]; days: number }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.accountId}
      cardTitle={(row) => (
        <span className="tech-name">
          <Avatar name={row.name} />
          {row.name}
        </span>
      )}
      caption={`Each technician's resolved tickets and logged time over the last ${days} days, and the tickets they own now`}
      empty={
        <EmptyState title="No technicians yet">
          Accounts appear here once an administrator has added them.
        </EmptyState>
      }
    />
  );
}
