import { notFound } from 'next/navigation';
import { canWorkTickets } from '@/lib/auth/roles';
import { loadActor } from '@/lib/auth/session';
import { loadAnalytics } from '@/lib/data/analytics';
import { toStatsPeriod, type StatsPeriod } from '@/lib/domain/resolved-stats';
import type { Analytics } from '@/lib/domain/analytics';
import { AnalyticsScreen } from '@/components/analytics/AnalyticsScreen';
import '@/styles/analytics.css';

export const metadata = { title: 'Analytics — Edison Helpdesk' };

/**
 * The invented month, for looking at the page without a database. Loaded only
 * when asked for, so the fixture is not in the bundle otherwise.
 */
async function sampleAnalytics(period: StatsPeriod): Promise<Analytics> {
  const { SAMPLE_ANALYTICS } = await import('../../../../tests/fixtures/analytics');
  return { ...SAMPLE_ANALYTICS, period };
}

/**
 * `/analytics` — the desk over a period, for everybody who works tickets.
 *
 * A skills officer gets not-found rather than a redirect, like /admin: the
 * page is aggregate ticket data, and the answer to somebody with no tickets
 * is that there is no such page for them. The database refuses them the
 * document independently.
 *
 * The period is the URL's, through the same `toStatsPeriod` the Resolved
 * list's stats used, so `?period=term` means the same span on both.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const actor = await loadActor();
  if (actor.kind !== 'active' || !canWorkTickets(actor.account.roles)) notFound();

  const period = toStatsPeriod((await searchParams).period);
  const analytics =
    process.env.ANALYTICS_FIXTURE === '1' ? await sampleAnalytics(period) : await loadAnalytics(period);

  return <AnalyticsScreen period={period} analytics={analytics} />;
}
