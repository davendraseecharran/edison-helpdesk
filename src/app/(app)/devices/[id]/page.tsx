import { loadDevice, loadDeviceCatalog, loadDeviceStatuses } from '@/lib/data/devices';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { DeviceDetail } from '@/components/devices/DeviceDetail';

export const metadata = { title: 'Device — Edison Helpdesk' };

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, statuses, catalog] = await Promise.all([
    loadDevice(id),
    loadDeviceStatuses(),
    loadDeviceCatalog(),
  ]);

  if (!detail) {
    // Identical whether the record is missing or not visible to this account.
    return (
      <div className="panel">
        <EmptyState
          title="Device not available"
          action={<ButtonLink href="/devices">Back to devices</ButtonLink>}
        >
          There is no inventory record at this address. It may have been removed, or the link may
          be wrong.
        </EmptyState>
      </div>
    );
  }

  return <DeviceDetail detail={detail} statuses={statuses} catalog={catalog} />;
}
