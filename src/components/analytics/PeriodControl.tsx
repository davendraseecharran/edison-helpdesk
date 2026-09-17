'use client';

import { useOptimistic, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PERIOD_LABELS, STATS_PERIODS, type StatsPeriod } from '@/lib/domain/resolved-stats';

const OPTIONS = STATS_PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }));

/**
 * The period, as the one gooey pill every picker is.
 *
 * The URL stays the source of truth: choosing a period pushes `?period=`,
 * so each span has an address that can be pasted into a message and the back
 * button returns to the one before. The pill moves at once, optimistically,
 * and the server's answer confirms it; while the new page streams the control
 * is dimmed rather than disabled, so a second choice is still possible.
 */
export function PeriodControl({ period }: { period: StatsPeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [shown, show] = useOptimistic(period);

  function choose(next: StatsPeriod) {
    if (next === shown) return;
    startTransition(() => {
      show(next);
      router.push(`${pathname}?period=${next}`);
    });
  }

  return (
    <div className="analytics-period" data-busy={pending ? '' : undefined}>
      <SegmentedControl label="Period" size="sm" value={shown} options={OPTIONS} onChange={choose} />
    </div>
  );
}
