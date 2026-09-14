'use client';

/**
 * The form on its own page: save goes to the new record, cancel goes back.
 */

import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import type { DeviceCatalogEntry } from '@/lib/domain/types';
import { Button } from '@/components/ui/Button';
import { DeviceForm, DeviceFormSubmit } from './DeviceForm';

export function NewDeviceForm({
  catalog,
  statuses,
}: {
  catalog: DeviceCatalogEntry[];
  statuses: string[];
}) {
  const router = useRouter();
  const { pendingKey } = useRuntime();
  return (
    <DeviceForm
      catalog={catalog}
      statuses={statuses}
      onSaved={(id) => router.push(`/devices/${id}`)}
      actions={
        <>
          <DeviceFormSubmit />
          <Button onClick={() => router.back()} disabled={pendingKey !== null}>
            Cancel
          </Button>
        </>
      }
    />
  );
}
