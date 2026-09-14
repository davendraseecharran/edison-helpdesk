import { InventoryManager } from '@/components/inventory/InventoryManager';

export const metadata = { title: 'Master inventory — Edison Helpdesk' };

export default function DevicesInventoryPage() {
  return <InventoryManager section="devices" />;
}
