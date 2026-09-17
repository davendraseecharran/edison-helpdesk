'use client';

import { ChartColumn } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import type { StatsPeriod } from '@/lib/domain/resolved-stats';

/**
 * The Resolved page's one header action, as its own client component.
 *
 * The page is a server component, and an icon is a function: a server
 * component cannot hand a function to a client one, so the icon has to be
 * chosen on this side of the line. It points at the analytics page every
 * ticket worker can read, carrying a period along when the caller has one.
 */
export function ResolvedAnalyticsLink({ period }: { period?: StatsPeriod }) {
  const href = period ? `/analytics?period=${period}` : '/analytics';
  return (
    <ButtonLink href={href} size="sm" icon={ChartColumn}>
      Analytics
    </ButtonLink>
  );
}
