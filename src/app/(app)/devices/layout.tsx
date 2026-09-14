import type { ReactNode } from 'react';
import { requireTicketWorker } from '@/lib/auth/session';

/**
 * The M5 device pages can edit a machine and link it to a ticket, so they are
 * ticket work. A skills officer reads the master inventory instead.
 */
export default async function DevicesLayout({ children }: { children: ReactNode }) {
  await requireTicketWorker();
  return <>{children}</>;
}
