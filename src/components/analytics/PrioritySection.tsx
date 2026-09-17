import { percentOf, type PriorityStat } from '@/lib/domain/analytics';
import { PRIORITY_ORDER } from '@/lib/domain/resolved-stats';
import { PRIORITY_LABELS, type Priority } from '@/lib/domain/types';
import { PriorityBadge } from '@/components/Badges';
import { Donut } from './charts/Donut';
import { hoursOr } from './format';
import { Section } from './Section';

/** Hottest darkest: the one ink, four steps. */
const PRIORITY_OPACITY: Record<Priority, number> = { urgent: 1, high: 0.7, normal: 0.45, low: 0.22 };

/** How resolutions split by priority, and how fast each priority moves. */
export function PrioritySection({ priorities }: { priorities: PriorityStat[] }) {
  const ordered = PRIORITY_ORDER.map((priority) => priorities.find((p) => p.priority === priority)).filter(
    (stat): stat is PriorityStat => stat !== undefined,
  );
  const total = ordered.reduce((sum, stat) => sum + stat.resolved, 0);

  return (
    <Section
      id="priority"
      title="Priority"
      note="How the period's resolutions split by priority, and how quickly each priority is closed."
    >
      {total === 0 ? (
        <p className="analytics-quiet">Nothing resolved in this period yet.</p>
      ) : (
        <div className="donut-row">
          <Donut
            slices={ordered.map((stat) => ({
              key: stat.priority,
              label: PRIORITY_LABELS[stat.priority],
              value: stat.resolved,
              opacity: PRIORITY_OPACITY[stat.priority],
            }))}
            figure={String(total)}
            caption="resolved"
            describe={`Resolved by priority: ${ordered
              .map((stat) => `${PRIORITY_LABELS[stat.priority]} ${stat.resolved}`)
              .join(', ')}`}
          />
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col" className="num">
                    Resolved
                  </th>
                  <th scope="col" className="num">
                    Share
                  </th>
                  <th scope="col" className="num">
                    Median
                  </th>
                  <th scope="col" className="num">
                    Nine in ten
                  </th>
                  <th scope="col" className="num">
                    From claim
                  </th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((stat) => (
                  <tr key={stat.priority}>
                    <td>
                      <span className="chart-legend">
                        <span>
                          <span
                            className="chart-key"
                            style={{ opacity: PRIORITY_OPACITY[stat.priority] }}
                            aria-hidden="true"
                          />
                          <PriorityBadge priority={stat.priority} />
                        </span>
                      </span>
                    </td>
                    <td className="num">{stat.resolved}</td>
                    <td className="num">{percentOf(stat.share)}</td>
                    <td className="num">{hoursOr(stat.medianHours)}</td>
                    <td className="num">{hoursOr(stat.p90Hours)}</td>
                    <td className="num">{hoursOr(stat.medianFromClaimHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}
