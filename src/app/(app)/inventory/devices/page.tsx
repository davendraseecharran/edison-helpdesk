import { InventoryManager } from '@/components/inventory/InventoryManager';

export const metadata = { title: 'Master Inventory — Edison Helpdesk' };

export default function DevicesInventoryPage() {
  return <InventoryManager section="devices" />;
}
