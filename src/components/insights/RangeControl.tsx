'use client';

/**
 * The one filter on the page, above everything it scopes.
 *
 * Every figure, chart and table below re-renders against the same window, so
 * the numbers on the page always agree with each other. The choice goes into
 * the URL rather than into component state: the server does the reading, and
 * the default is left out of the address so a plain `/insights` is the
 * canonical link.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  DEFAULT_RANGE,
  INSIGHTS_RANGES,
  type InsightsRange,
} from '@/app/(app)/insights/search-params';

const OPTIONS = INSIGHTS_RANGES.map((days) => ({
  value: String(days),
  label: `${days} days`,
}));

export function RangeControl({ days }: { days: InsightsRange }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startNavigation] = useTransition();

  function choose(value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (Number(value) === DEFAULT_RANGE) next.delete('days');
    else next.set('days', value);
    const query = next.toString();
    startNavigation(() => router.replace(query ? `${pathname}?${query}` : pathname));
  }

  return (
    <SegmentedControl
      label="Range"
      value={String(days)}
      options={OPTIONS}
      onChange={choose}
      size="sm"
    />
  );
}
