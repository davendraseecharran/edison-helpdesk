'use client';

/**
 * The people page's header action. A client component so the icon can be
 * handed to `ButtonLink` (a component cannot cross from a server page into a
 * client button as a prop).
 */

import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';

export function PeopleHeaderActions() {
  return (
    <ButtonLink href="/people/new" icon={Plus} collapseOnPhone>
      Add person
    </ButtonLink>
  );
}
