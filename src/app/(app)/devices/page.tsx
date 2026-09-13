import { loadDeviceFacets, loadDevices } from '@/lib/data/devices';
import { PageHeader } from '@/components/Primitives';
import { DeviceList } from '@/components/devices/DeviceList';
import { DevicesHeaderActions } from '@/components/devices/DevicesHeaderActions';
import { toDeviceFilters, type DeviceSearchParams } from './search-params';

export const metadata = { title: 'Devices — Edison Helpdesk' };

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<DeviceSearchParams>;
}) {
  const filters = toDeviceFilters(await searchParams);
  const [page, facets] = await Promise.all([loadDevices(filters), loadDeviceFacets()]);

  return (
    <>
      <PageHeader
        title="Devices"
        description="Every machine the school lends out: where it is, who has it, and what state it is in."
        actions={<DevicesHeaderActions />}
      />
      <DeviceList page={page} facets={facets} />
    </>
  );
}
