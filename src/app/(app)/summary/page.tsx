import { loadActor } from '@/lib/auth/session';
import { loadWeeklySummary } from '@/lib/data/summary';
import { schoolToday } from '@/lib/format';
import { weekStartOf } from '@/lib/domain/summary';
import { WeeklySummaryScreen } from '@/components/summary/WeeklySummaryScreen';
import '@/styles/analytics.css';
import '@/styles/summary.css';

export const metadata = { title: 'Your week — Edison Helpdesk' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `/summary` — the week in review, for everybody. `?week=` is any day of the
 * week wanted (the notice links to last week's Monday); the default is the
 * week in progress. The database refuses a future week and anybody inactive.
 */
export default async function SummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const actor = await loadActor();
  const asked = (await searchParams).week;
  const thisWeek = weekStartOf(schoolToday());
  const week = asked && DAY.test(asked) ? weekStartOf(asked) : thisWeek;
  const summary = week > thisWeek ? null : await loadWeeklySummary(week);
  const name = actor.kind === 'active' ? actor.account.displayName : '';

  return <WeeklySummaryScreen summary={summary} week={week} thisWeek={thisWeek} name={name} />;
}
