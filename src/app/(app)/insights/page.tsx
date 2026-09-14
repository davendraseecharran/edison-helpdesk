import { loadInsights, OPEN_STATUSES, PRIORITIES_BY_SEVERITY } from '@/lib/data/insights';
import {
  DEVICE_STATUSES,
  TICKET_CATEGORY_LABELS,
  type TicketCategory,
} from '@/lib/domain/types';
import { DeviceStatusBadge, PriorityBadge, StatusBadge } from '@/components/Badges';
import { EmptyState, PageHeader } from '@/components/Primitives';
import { BarChart, type BarRow } from '@/components/insights/BarChart';
import { LineChart } from '@/components/insights/LineChart';
import { RangeControl } from '@/components/insights/RangeControl';
import { StatTile, formatHours } from '@/components/insights/StatTile';
import { TechTable } from '@/components/insights/TechTable';
import { toInsightsRange, type InsightsSearchParams } from './search-params';
import '@/styles/insights.css';
import { requireTicketWorker } from '@/lib/auth/session';

export const metadata = { title: 'Insights — Edison Helpdesk' };

/**
 * The helpdesk's month at a glance, for everybody with an active account.
 *
 * Two kinds of number share the page and are labelled as such throughout.
 * Opened, resolved, time to resolve and each technician's work belong to the
 * chosen window; what is open and what is in the cupboard are facts about this
 * moment, and a ticket raised in March that is still waiting belongs in them.
 * Saying "right now" beside the second kind is the difference between a
 * dashboard and a set of numbers that do not add up.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<InsightsSearchParams>;
}) {
  await requireTicketWorker();
  const days = toInsightsRange((await searchParams).days);
  const insights = await loadInsights(days);

  const since = `in the last ${days} days`;
  const rangeLabel = `Last ${days} days`;

  const opened = insights.series.reduce((sum, point) => sum + point.opened, 0);
  const resolved = insights.series.reduce((sum, point) => sum + point.resolved, 0);
  const openNow = OPEN_STATUSES.reduce((sum, status) => sum + insights.openByStatus[status], 0);
  const { medianHours, meanHours, resolvedCount } = insights.resolution;

  const statusRows: BarRow[] = OPEN_STATUSES.map((status) => ({
    key: status,
    label: <StatusBadge status={status} />,
    value: insights.openByStatus[status],
  }));

  const priorityRows: BarRow[] = PRIORITIES_BY_SEVERITY.map((priority) => ({
    key: priority,
    label: <PriorityBadge priority={priority} />,
    value: insights.openByPriority[priority],
  }));

  const categoryRows: BarRow[] = insights.byCategory.map((row) => ({
    key: row.category,
    label: TICKET_CATEGORY_LABELS[row.category as TicketCategory] ?? row.category,
    value: row.count,
  }));

  const inventoryStatusRows: BarRow[] = DEVICE_STATUSES.map((status) => ({
    key: status,
    label: <DeviceStatusBadge status={status} />,
    value: insights.inventory.byStatus[status],
  }));

  const inventoryTypeRows: BarRow[] = insights.inventory.byType.map((row) => ({
    key: row.type,
    label: row.type,
    value: row.count,
  }));

  const ticketDeviceRows: BarRow[] = insights.deviceTypesInTickets.map((row) => ({
    key: row.type,
    label: row.type,
    value: row.count,
  }));

  return (
    <div className="insights">
      <PageHeader
        title="Insights"
        description="How the helpdesk is doing, team-wide."
        actions={<RangeControl days={days} />}
      />

      <div className="insights-tiles">
        <StatTile label="Opened" value={String(opened)} meta={since} />
        <StatTile label="Resolved" value={String(resolved)} meta={since} />
        <StatTile
          label="Median time to resolve"
          value={medianHours === null ? '—' : formatHours(medianHours)}
          meta={
            resolvedCount === 0
              ? `Nothing resolved ${since}`
              : meanHours === null
                ? `over ${resolvedCount} resolved`
                : `over ${resolvedCount} resolved, mean ${formatHours(meanHours)}`
          }
        />
        <StatTile label="Open now" value={String(openNow)} meta="across every status, right now" accent />
      </div>

      <section className="panel" aria-labelledby="insights-series-heading">
        <div className="panel-head">
          <h2 className="panel-title" id="insights-series-heading">
            Opened and resolved
          </h2>
          <span className="panel-aside">{rangeLabel}</span>
        </div>
        <div className="panel-body">
          {opened + resolved === 0 ? (
            <EmptyState title={`Nothing opened or resolved ${since}`}>
              Tickets appear here as the team logs and closes them.
            </EmptyState>
          ) : (
            <LineChart
              title="Tickets opened and resolved per day"
              series={insights.series}
              days={days}
            />
          )}
        </div>
      </section>

      <div className="insights-grid">
        <section className="panel" aria-labelledby="insights-status-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="insights-status-heading">
              Open by status
            </h2>
            <span className="panel-aside">Right now</span>
          </div>
          <div className="panel-body">
            {openNow === 0 ? (
              <EmptyState title="Nothing open right now">
                Every ticket has been resolved or cancelled.
              </EmptyState>
            ) : (
              <BarChart caption="Open tickets by status, right now" rows={statusRows} />
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="insights-priority-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="insights-priority-heading">
              Open by priority
            </h2>
            <span className="panel-aside">Right now</span>
          </div>
          <div className="panel-body">
            {openNow === 0 ? (
              <EmptyState title="Nothing open right now">
                Priorities appear here while work is in the queue.
              </EmptyState>
            ) : (
              <BarChart caption="Open tickets by priority, right now" rows={priorityRows} />
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="insights-category-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="insights-category-heading">
              Open by category
            </h2>
            <span className="panel-aside">Right now</span>
          </div>
          <div className="panel-body">
            {categoryRows.length === 0 ? (
              <EmptyState title="Nothing open right now">
                Categories appear here while work is in the queue.
              </EmptyState>
            ) : (
              <BarChart caption="Open tickets by category, right now" rows={categoryRows} />
            )}
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="insights-team-heading">
        <div className="panel-head">
          <h2 className="panel-title" id="insights-team-heading">
            Technicians
          </h2>
          <span className="panel-aside">{rangeLabel}</span>
        </div>
        <div className="panel-body">
          <TechTable rows={insights.technicians} days={days} />
        </div>
      </section>

      <div className="insights-grid insights-grid-wide">
        <section className="panel" aria-labelledby="insights-inventory-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="insights-inventory-heading">
              Inventory
            </h2>
            <span className="panel-aside">
              Right now, {insights.inventory.total}{' '}
              {insights.inventory.total === 1 ? 'device' : 'devices'}
            </span>
          </div>
          <div className="panel-body">
            {insights.inventory.total === 0 ? (
              <EmptyState title="No devices yet">
                Devices appear here once they are added to the inventory.
              </EmptyState>
            ) : (
              <div className="insights-pair">
                <div className="chart-block">
                  <h3 className="chart-heading">By status</h3>
                  <BarChart caption="Devices by status, right now" rows={inventoryStatusRows} />
                </div>
                <div className="chart-block">
                  <h3 className="chart-heading">Most common types</h3>
                  <BarChart caption="Devices by type, right now" rows={inventoryTypeRows} />
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="insights-ticket-devices-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="insights-ticket-devices-heading">
              Device types in tickets
            </h2>
            <span className="panel-aside">{rangeLabel}</span>
          </div>
          <div className="panel-body">
            {ticketDeviceRows.length === 0 ? (
              <EmptyState title={`No devices recorded on tickets ${since}`}>
                A technician can note the machine a ticket is about while working on it.
              </EmptyState>
            ) : (
              <BarChart
                caption={`Device types recorded on tickets in the last ${days} days`}
                rows={ticketDeviceRows}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
