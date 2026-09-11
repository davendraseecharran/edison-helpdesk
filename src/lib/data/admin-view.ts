import 'server-only';

/**
 * Administration read model.
 *
 * Read with the admin's own client, so row-level security is what permits the
 * full account list: `app_accounts` is readable in full only by an active admin.
 * A technician reaching this code would see just their own row.
 */

import { createClient } from '@/lib/supabase/server';

export interface AdminAccountView {
  id: string;
  displayName: string;
  email: string;
  role: 'admin' | 'technician';
  status: 'active' | 'inactive' | 'setup_pending';
  credentialActionPending: boolean;
  lastCredentialActionAt: string | null;
  lastCredentialActionKind: 'setup_issued' | 'recovery_issued' | null;
  activeTicketCount: number;
}

export async function adminAccountsView(): Promise<AdminAccountView[]> {
  const supabase = await createClient();

  const { data: accounts, error } = await supabase
    .from('app_accounts')
    .select(
      'id, display_name, email, role, status, credential_action_pending, last_credential_action_at, last_credential_action_kind',
    )
    .order('display_name');
  if (error || !accounts) return [];

  // Live workload per owner, so deactivating someone surfaces what needs
  // reassigning. Still an RLS-filtered read: an admin sees every ticket.
  const { data: live } = await supabase
    .from('tickets')
    .select('owner_id')
    .in('status', ['open', 'assigned', 'in_progress', 'waiting'])
    .not('owner_id', 'is', null);

  const counts = new Map<string, number>();
  for (const row of live ?? []) {
    const ownerId = (row as { owner_id: string }).owner_id;
    counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
  }

  return accounts.map((row) => ({
    id: row.id as string,
    displayName: row.display_name as string,
    email: row.email as string,
    role: row.role as AdminAccountView['role'],
    status: row.status as AdminAccountView['status'],
    credentialActionPending: row.credential_action_pending as boolean,
    lastCredentialActionAt: row.last_credential_action_at as string | null,
    lastCredentialActionKind: row.last_credential_action_kind as AdminAccountView['lastCredentialActionKind'],
    activeTicketCount: counts.get(row.id as string) ?? 0,
  }));
}
