import type { ReactNode } from 'react';
import { requireTicketWorker } from '@/lib/auth/session';

/**
 * Intake and ticket detail, behind the ticket-worker gate.
 *
 * A layout rather than a check in each page, because the intake screen is a
 * client component and cannot ask the database what the caller may do. The
 * database refuses a skills officer every ticket anyway; this decides what they
 * see instead of a refusal.
 */
export default async function TicketsLayout({ children }: { children: ReactNode }) {
  await requireTicketWorker();
  return <>{children}</>;
}
