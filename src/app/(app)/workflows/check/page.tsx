import { loadDeviceFacets, loadDeviceStatuses } from '@/lib/data/devices';
import { DeviceCheck } from '@/components/workflows/DeviceCheck';

export const metadata = { title: 'Check a device — Edison Helpdesk' };

/**
 * `/workflows/check` — scan a machine, see who has it.
 *
 * `?code=` is checked on arrival: the corner card after a palette scan and the
 * assistant's links land here with the machine already on screen. The
 * statuses and locations are for the card's own Return and Move.
 */
export default async function CheckDevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 200) ?? '';
  const [facets, statuses] = await Promise.all([loadDeviceFacets(), loadDeviceStatuses()]);
  return <DeviceCheck initialCode={code} statuses={statuses} locations={facets.locations} />;
}
