import { redirect } from 'next/navigation';
import { toStatsPeriod } from '@/lib/domain/resolved-stats';

/**
 * Where the administrator-only table used to be. The counting lives at
 * /analytics now, for everybody who works tickets, with the same periods; an
 * old link or bookmark lands there with its period intact.
 */
export default async function ResolvedAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const period = toStatsPeriod((await searchParams).period);
  redirect(`/analytics?period=${period}`);
}
