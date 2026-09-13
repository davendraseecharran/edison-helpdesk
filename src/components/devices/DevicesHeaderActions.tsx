'use client';

/**
 * The devices page's header actions: the export of the current filter and
 * the link to add a device. A client component for the same reason as
 * `PeopleHeaderActions`.
 */

import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { ExportDevicesButton } from './ExportDevicesButton';

export function DevicesHeaderActions() {
  return (
    <>
      <ExportDevicesButton />
      <ButtonLink href="/devices/new" icon={Plus} collapseOnPhone>
        Add device
      </ButtonLink>
    </>
  );
}
