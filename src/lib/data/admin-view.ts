import 'server-only';

/**
 * Administration read model.
 *
 * Read with the admin's own client, so row-level security is what permits the
 * full account list: `app_accounts` is readable in full only by an active admin.
 * A technician reaching this code would see just their own row, and the invite
 * RPC would refuse them outright rather than quietly returning nothing.
 */

import { createClient } from '@/lib/supabase/server';
import type { AccountRole, AccountStatus } from '@/lib/auth/session';

export interface AdminAccountView {
  id: string;
  displayName: string;
  email: string;
  role: AccountRole;
  status: AccountStatus;
  credentialActionPending: boolean;
  lastCredentialActionAt: string | null;
  lastCredentialActionKind: 'setup_issued' | 'recovery_issued' | null;
  createdAt: string;
  activeTicketCount: number;
}

export type InviteState = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface InviteView {
  id: string;
  email: string;
  role: AccountRole;
  displayName: string | null;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  /** Derived from the clock at read time, so it must not be cached. */
  state: InviteState;
}

/**
 * Every account, including the two states a Google sign-in can create:
 * `pending_approval` (waiting for a decision) and `denied` (already refused).
 * Both are ordinary rows here — the administration screen is the one place
 * they are meant to be visible.
 */
export async function loadAdminAccounts(): Promise<AdminAccountView[]> {
  const supabase = await createClient();

  const { data: accounts, error } = await supabase
    .from('app_accounts')
    .select(
      'id, display_name, email, role, status, credential_action_pending, last_credential_action_at, last_credential_action_kind, created_at',
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
    role: row.role as AccountRole,
    status: row.status as AccountStatus,
    credentialActionPending: row.credential_action_pending as boolean,
    lastCredentialActionAt: row.last_credential_action_at as string | null,
    lastCredentialActionKind: row.last_credential_action_kind as AdminAccountView['lastCredentialActionKind'],
    createdAt: row.created_at as string,
    activeTicketCount: counts.get(row.id as string) ?? 0,
  }));
}

export interface InvitesResult {
  invites: InviteView[];
  /** Set when the list could not be read at all. Never the same as "no invites". */
  error: string | null;
}

/**
 * Every invite ever issued, newest first, with its derived state.
 *
 * The error is carried rather than swallowed. An empty list and a failed read
 * look identical on screen, and the difference matters here: "nobody is
 * invited" invites an administrator to send one, while "this could not be
 * read" means a second invite for an address that already has one is about to
 * be created. The RPC raises for anyone who is not an active administrator, so
 * a technician who somehow reached this code sees the refusal, not a blank.
 */
export async function loadInvites(): Promise<InvitesResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_admin_list_invites');
  if (error) {
    return { invites: [], error: `Invites could not be read: ${error.message}. Reload the page.` };
  }
  if (!Array.isArray(data)) {
    return { invites: [], error: 'Invites could not be read. Reload the page.' };
  }

  const invites = (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    email: row.email as string,
    role: row.role as AccountRole,
    displayName: (row.display_name as string | null) ?? null,
    invitedByName: (row.invited_by_name as string | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    acceptedAt: (row.accepted_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    state: row.state as InviteState,
  }));

  return { invites, error: null };
}
