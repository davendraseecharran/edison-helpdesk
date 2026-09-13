import { loadDeviceFacets } from '@/lib/data/devices';
import { PageHeader } from '@/components/Primitives';
import { NewDeviceForm } from '@/components/devices/NewDeviceForm';

export const metadata = { title: 'Add device — Edison Helpdesk' };

export default async function NewDevicePage() {
  const facets = await loadDeviceFacets();
  return (
    <div className="record-form-page">
      <PageHeader
        title="Add device"
        description="A machine that is not in the inventory yet. One identifier is enough to start; the rest can be filled in from its page."
      />
      <div className="panel">
        <div className="panel-body">
          <NewDeviceForm types={facets.types} locations={facets.locations} />
        </div>
      </div>
    </div>
  );
}
