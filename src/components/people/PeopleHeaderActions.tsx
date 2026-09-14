'use client';

/**
 * The people page's header action. A client component so the icon can be
 * handed to `ButtonLink` (a component cannot cross from a server page into a
 * client button as a prop). The kind follows the list somebody is looking at,
 * so Add person from the staff tab starts a member of staff.
 */

import { Plus } from 'lucide-react';
import type { PersonKind } from '@/lib/domain/types';
import { ButtonLink } from '@/components/ui/Button';

export function PeopleHeaderActions({ kind = 'student' }: { kind?: PersonKind }) {
  return (
    <ButtonLink href={`/people/new?kind=${kind}`} icon={Plus} collapseOnPhone>
      Add person
    </ButtonLink>
  );
}
