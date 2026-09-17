import { PageHeader } from '@/components/Primitives';
import { analyticsSentence, type Analytics } from '@/lib/domain/analytics';
import type { StatsPeriod } from '@/lib/domain/resolved-stats';
import { ArrivalsSection } from './ArrivalsSection';
import { HardestSection } from './HardestSection';
import { HowCounted } from './HowCounted';
import { IssuesSection } from './IssuesSection';
import { OverviewSection } from './OverviewSection';
import { PeopleSection } from './PeopleSection';
import { PeriodControl } from './PeriodControl';
import { PrioritySection } from './PrioritySection';
import { ThroughputSection } from './ThroughputSection';
import { WaitingSection } from './WaitingSection';
import { WhereSection } from './WhereSection';

/**
 * The analytics page, top to bottom.
 *
 * A server component over one document: every section is a pure function of
 * `Analytics`, and the only client piece is the period control, which owns
 * the URL. The stylesheet is imported by the route, not here, so the screen
 * renders in a plain test. When the document could not be read the header and the control
 * still render, so the reader can try another period, and one quiet line
 * says what happened.
 */
export function AnalyticsScreen({
  period,
  analytics,
}: {
  period: StatsPeriod;
  analytics: Analytics | null;
}) {
  return (
    <>
      <PageHeader
        title="Analytics"
        description="How the desk is doing: what came in, what was closed, how long it took, and who did what."
        actions={<PeriodControl period={period} />}
      />
      {analytics === null ? (
        <p className="analytics-lead">The analytics could not be read just now.</p>
      ) : (
        <>
          <p className="analytics-lead">{analyticsSentence(analytics.overview, analytics.period)}</p>
          <div className="analytics-sections">
            <OverviewSection overview={analytics.overview} />
            <ThroughputSection throughput={analytics.throughput} bucket={analytics.bucket} />
            <ArrivalsSection arrivals={analytics.arrivals} />
            <IssuesSection categories={analytics.categories} bucket={analytics.bucket} />
            <PrioritySection priorities={analytics.priorities} />
            <WhereSection
              locations={analytics.locations}
              remote={analytics.remote}
              channels={analytics.channels}
              requesters={analytics.requesters}
            />
            <WaitingSection waiting={analytics.waiting} />
            <PeopleSection people={analytics.people} />
            <HardestSection hardest={analytics.hardest} />
            <HowCounted />
          </div>
        </>
      )}
    </>
  );
}
