import { loadDeviceCatalog, loadDeviceStatuses } from '@/lib/data/devices';
import { PageHeader } from '@/components/Primitives';
import { NewDeviceForm } from '@/components/devices/NewDeviceForm';

export const metadata = { title: 'Add device — Edison Helpdesk' };

export default async function NewDevicePage() {
  const [catalog, statuses] = await Promise.all([loadDeviceCatalog(), loadDeviceStatuses()]);
  return (
    <div className="record-form-page">
      <PageHeader
        title="Add device"
        description="A machine that is not in the inventory yet. Its type, manufacturer, model and serial are all required; the inventory ID is generated on save."
      />
      <div className="panel">
        <div className="panel-body">
          <NewDeviceForm catalog={catalog} statuses={statuses} />
        </div>
      </div>
    </div>
  );
}
