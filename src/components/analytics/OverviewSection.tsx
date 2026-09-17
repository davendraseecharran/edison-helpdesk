import { deltaOf, percentOf, type Overview } from '@/lib/domain/analytics';
import { formatHours } from '@/lib/domain/resolved-stats';
import { StatCard } from './charts/StatCard';
import { count, hoursOr } from './format';
import { Section } from './Section';

/** The six figures a person asks for first, and the two they ask about after. */
export function OverviewSection({ overview }: { overview: Overview }) {
  const perDay = overview.perSchoolDay;
  const perWeek = overview.perWeek;

  return (
    <Section
      id="overview"
      title="Overview"
      note="The period at a glance. An arrow compares with the span of equal length just before it."
    >
      <div className="stat-grid">
        <StatCard
          label="Resolved"
          value={overview.resolved}
          delta={deltaOf(overview.resolved, overview.resolvedPrevious)}
          lines={
            overview.resolvedPrevious === null ? [] : [`${overview.resolvedPrevious} the period before`]
          }
        />
        <StatCard
          label="Created"
          value={overview.created}
          delta={deltaOf(overview.created, overview.createdPrevious)}
          lines={
            overview.createdPrevious === null ? [] : [`${overview.createdPrevious} the period before`]
          }
        />
        <StatCard
          label="Median time to resolve"
          value={hoursOr(overview.medianHours)}
          delta={
            overview.medianHours === null
              ? undefined
              : deltaOf(overview.medianHours, overview.medianHoursPrevious)
          }
          lines={[
            overview.p90Hours === null
              ? 'From creation to resolution'
              : `Nine in ten within ${formatHours(overview.p90Hours)}`,
          ]}
        />
        <StatCard
          label="Resolved within a day"
          value={percentOf(overview.sameDayShare)}
          lines={['Within twenty-four hours of being created']}
        />
        <StatCard
          label="Per school day"
          value={perDay === null ? '—' : perDay.toFixed(1)}
          lines={[
            perWeek === null ? 'No week yet' : `${perWeek.toFixed(perWeek < 10 ? 1 : 0)} a week`,
            count(overview.schoolDays, 'school day'),
          ]}
        />
        <StatCard
          label="Open now"
          value={overview.openNow}
          lines={[
            `${overview.unassignedNow} unassigned · ${overview.waitingNow} waiting`,
            overview.oldestOpenHours === null
              ? 'Nothing waiting'
              : `Oldest open ${formatHours(overview.oldestOpenHours)}`,
          ]}
        />
      </div>
      <p className="analytics-quiet">
        {count(overview.cancelled, 'ticket')} cancelled, which never count as resolved.{' '}
        {overview.reopened === 0
          ? 'None of the resolved tickets had been reopened.'
          : `${count(overview.reopened, 'resolved ticket')} had been reopened at least once.`}
      </p>
    </Section>
  );
}
