'use server';

/**
 * Access decisions.
 *
 * Both entry points are thin: the database owns the rules, and deliberately so.
 * `app_admin_review_access_request` takes an exclusive lock, refuses a reviewer
 * acting on their own request, sets status and roles together, writes the
 * account event and notifies the requester — all in one transaction. Splitting
 * any of that into TypeScript would let a crash between two steps leave
 * somebody approved with no role, or a role with no record of who granted it.
 *
 * The checks here are a fast fail for an obviously unusable session only.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { canonicalRoles, rolesLabel, type AccountRole } from '@/lib/auth/roles';

export interface AccessActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function requireAdminSession(action: string): Promise<AccessActionResult | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { ok: false, error: `Only a signed-in administrator can ${action}.` };
  }
  return null;
}

export async function reviewAccessRequestAction(
  accountId: string,
  decision: 'approve' | 'deny',
  roles: readonly AccountRole[] = ['netrider'],
): Promise<AccessActionResult> {
  const gate = await requireAdminSession('review an access request');
  if (gate) return gate;

  const chosen = canonicalRoles(roles);
  if (decision === 'approve' && chosen.length === 0) {
    return { ok: false, error: 'Choose at least one role before approving.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_admin_review_access_request', {
    p_account: accountId,
    p_decision: decision,
    p_roles: chosen,
  });
  if (error) return { ok: false, error: error.message };

  // Status and roles both changed, and the person's own session reads them on
  // every request, so refresh the whole tree rather than the admin page alone.
  revalidatePath('/', 'layout');
  return {
    ok: true,
    message:
      decision === 'approve'
        ? `Approved as ${rolesLabel(chosen)}.`
        : 'Access declined. They can see why and who to contact.',
  };
}

export async function setRolesAction(
  accountId: string,
  roles: readonly AccountRole[],
): Promise<AccessActionResult> {
  const gate = await requireAdminSession('change a role');
  if (gate) return gate;

  const chosen = canonicalRoles(roles);
  if (chosen.length === 0) {
    return { ok: false, error: 'An account needs at least one role.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_set_account_roles', {
    p_account: accountId,
    p_roles: chosen,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true, message: `Roles set to ${rolesLabel(chosen)}.` };
}
