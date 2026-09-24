import type { ReactNode } from 'react';
import { requireTicketWorker } from '@/lib/auth/session';
import '@/styles/workflows.css';

/**
 * Workflows change the inventory, which is a NetRider's or an administrator's
 * job. A skills officer is sent to People like every other ticket-worker page;
 * the database refuses them every workflow function independently.
 */
export default async function WorkflowsLayout({ children }: { children: ReactNode }) {
  await requireTicketWorker();
  return <>{children}</>;
}
