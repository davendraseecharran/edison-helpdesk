import { notFound } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadAuditLog } from '@/lib/data/audit';
import { PageHeader } from '@/components/Primitives';
import { AdminTabs } from '@/components/admin/AdministrationScreen';
import { AuditLog } from '@/components/admin/AuditLog';

export const metadata = { title: 'Audit log — Edison Helpdesk' };

export interface AuditSearchParams {
  actor?: string | string[];
  via?: string | string[];
  kind?: string | string[];
  entity?: string | string[];
  from?: string | string[];
  to?: string | string[];
  page?: string | string[];
}

/**
 * Filters carried in the URL.
 *
 * Only the page number is interpreted here; every other value is handed to
 * `loadAuditLog`, which validates it against what the database knows and drops
 * anything else. A repeated parameter takes its first value, the way the rest
 * of the application reads one.
 */
function toAuditFilters(params: AuditSearchParams) {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const page = Number.parseInt(first(params.page) ?? '1', 10);
  return {
    actor: first(params.actor),
    via: first(params.via),
    kind: first(params.kind),
    entity: first(params.entity),
    from: first(params.from),
    to: first(params.to),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1,
  };
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  const actor = await loadActor();
  // Not a redirect: a technician has no business knowing this route exists,
  // and the RPC underneath would refuse them anyway.
  if (actor.kind !== 'active' || actor.account.role !== 'admin') notFound();

  const page = await loadAuditLog(toAuditFilters(await searchParams));

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to a ticket, account, person, device, invite or import, newest first, with who made it and whether their AI made it for them."
      />
      <AdminTabs />
      <AuditLog page={page} />
    </>
  );
}
