'use client';

import { ChartColumn } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';

/**
 * The Resolved page's one header action, as its own client component.
 *
 * The page is a server component, and an icon is a function: a server
 * component cannot hand a function to a client one, so the icon has to be
 * chosen on this side of the line.
 */
export function ResolvedAnalyticsLink() {
  return (
    <ButtonLink href="/resolved/analytics" size="sm" icon={ChartColumn}>
      Analytics
    </ButtonLink>
  );
}
