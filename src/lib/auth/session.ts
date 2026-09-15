import 'server-only';

/**
 * The Data Access Layer for identity.
 *
 * Sessions are verified with `supabase.auth.getUser()`, which validates the
 * token against the auth server, rather than trusting cookie contents or
 * `getSession()`. Next.js documents this pattern (a DAL memoised with React
 * `cache()`, with proxy checks treated as optimistic only), and Supabase
 * documents `getUser()` as the server-side verification call.
 *
 * `loadActor()` then asks the DATABASE what this identity may do. Role, status,
 * outstanding credential actions and session currency all come from
 * `app_my_account()`, never from JWT metadata a client could influence.
 */

import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { canWorkTickets, normalizeRoles } from '@/lib/auth/roles';
import type { AccountRole, DerivedRole } from '@/lib/auth/roles';

export type { AccountRole, DerivedRole };

export type AccountStatus =
  | 'active'
  | 'inactive'
  | 'setup_pending'
  /** Signed in with a verified provider address that held no invite. */
  | 'pending_approval'
  /** An administrator reviewed that request and said no. */
  | 'denied';

export interface ActorAccount {
  id: string;
  displayName: string;
  email: string;
  /**
   * The derived single-value column. Kept because every gate written before
   * roles became a set reads it, and it still means exactly what it meant:
   * `admin` when the set holds admin. Prefer `roles` for anything new.
   */
  role: DerivedRole;
  /** What this account may do. Never empty. */
  roles: AccountRole[];
  status: AccountStatus;
  credentialActionPending: boolean;
  sessionIsCurrent: boolean;
}

export type ActorState =
  | { kind: 'anonymous' }
  /** Signed in, but no helpdesk account row exists for the identity. */
  | { kind: 'unlinked'; user: User }
  /** Signed in with an account that may not use the helpdesk yet. */
  | { kind: 'restricted'; user: User; account: ActorAccount; reason: RestrictionReason }
  | { kind: 'active'; user: User; account: ActorAccount };

export type RestrictionReason =
  | 'setup_pending'
  | 'inactive'
  | 'credential_action_pending'
  | 'session_superseded'
  | 'pending_approval'
  | 'denied';

/** Verified auth user for this request, memoised for the render pass. */
const currentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

/**
 * Resolves the full actor state from the database.
 *
 * Note the ordering: a suspended credential action is reported before an
 * inactive status, because an account mid-recovery must be sent to the password
 * screen rather than told it is disabled.
 */
export const loadActor = cache(async (): Promise<ActorState> => {
  const user = await currentUser();
  if (!user) return { kind: 'anonymous' };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_my_account');
  if (error || !Array.isArray(data) || data.length === 0) {
    return { kind: 'unlinked', user };
  }

  const row = data[0] as {
    id: string;
    display_name: string;
    email: string;
    role: DerivedRole;
    roles: string[] | null;
    status: AccountStatus;
    credential_action_pending: boolean;
    session_is_current: boolean;
  };

  const account: ActorAccount = {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    roles: normalizeRoles(row.roles),
    status: row.status,
    credentialActionPending: row.credential_action_pending,
    sessionIsCurrent: row.session_is_current,
  };

  if (account.credentialActionPending) {
    return { kind: 'restricted', user, account, reason: 'credential_action_pending' };
  }
  // Checked before status and session currency, but after a suspended credential
  // action: an account that has never been approved has never had a password, so
  // its session is not current either, and "sign in again" would be the wrong
  // thing to say to somebody nobody has answered yet.
  if (account.status === 'pending_approval') {
    return { kind: 'restricted', user, account, reason: 'pending_approval' };
  }
  if (account.status === 'denied') {
    return { kind: 'restricted', user, account, reason: 'denied' };
  }
  if (account.status === 'setup_pending') {
    return { kind: 'restricted', user, account, reason: 'setup_pending' };
  }
  if (account.status === 'inactive') {
    return { kind: 'restricted', user, account, reason: 'inactive' };
  }
  if (!account.sessionIsCurrent) {
    return { kind: 'restricted', user, account, reason: 'session_superseded' };
  }
  return { kind: 'active', user, account };
});

/** The account for a fully authorized caller, or null. */
export async function activeAccount(): Promise<ActorAccount | null> {
  const state = await loadActor();
  return state.kind === 'active' ? state.account : null;
}

export async function isAdmin(): Promise<boolean> {
  const account = await activeAccount();
  return account?.role === 'admin';
}

/**
 * The gate every ticket route stands behind.
 *
 * A skills officer has no queue, so a ticket route is not a refusal to explain
 * — it is a page that does not exist for them. They are sent to the directory,
 * which is their landing page anyway, with a notice saying why they moved.
 * The database refuses them the same records independently; this only decides
 * what a person sees instead of an error.
 */
export async function requireTicketWorker(): Promise<ActorAccount> {
  const account = await activeAccount();
  if (!account) redirect('/login');
  if (!canWorkTickets(account.roles)) redirect('/people?moved=tickets');
  return account;
}
