'use client';

/**
 * "Export CSV" for the inventory list: the current filter, every page of
 * it, as a file. The text comes back from a server action and becomes a
 * download here through a Blob URL, so no export URL exists to be shared and
 * nothing is written on the server.
 */

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download } from 'lucide-react';
import { exportDevicesCsvAction } from '@/lib/data/export-actions';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { toDeviceFilters } from '@/app/(app)/devices/search-params';

export function ExportDevicesButton() {
  const { notify } = useRuntime();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);

  async function exportCsv() {
    setBusy(true);
    try {
      const filters = toDeviceFilters(Object.fromEntries(searchParams.entries()));
      const result = await exportDevicesCsvAction(filters);
      if (!result.ok || !result.csv) {
        notify('error', result.error ?? 'The export could not be made. Try again.');
        return;
      }
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename ?? 'devices.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      // A cut export is reported as a failure even though the file saved: a
      // success message leaves after five seconds, and "this file is not the
      // whole filter" must not disappear before it has been read.
      if (result.capped && result.message) notify('error', result.message);
      else notify('success', `Exported ${result.count ?? 0} ${result.count === 1 ? 'device' : 'devices'}.`);
    } catch {
      notify('error', 'The export could not be made. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button icon={Download} loading={busy} onClick={() => void exportCsv()}>
      Export CSV
    </Button>
  );
}
