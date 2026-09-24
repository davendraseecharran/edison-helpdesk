import { loadLabelDevices } from '@/lib/data/device-check';
import { idsFromParam } from '@/lib/labels/layout';
import { LabelPrinter } from '@/components/labels/LabelPrinter';

export const metadata = { title: 'Print labels — Edison Helpdesk' };

/**
 * `/devices/labels` — asset labels for a set of machines.
 *
 * `?ids=` carries the machines chosen elsewhere: a selection on Devices, one
 * device's page, a finished workflow run. They are read under the caller's
 * own session through the device page's reader, so a link names nothing its
 * holder could not already open. More are added on the page by scanning.
 */
export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ids = idsFromParam((await searchParams).ids);
  const devices = await loadLabelDevices(ids);
  return <LabelPrinter key={ids.join(',')} initial={devices} />;
}
