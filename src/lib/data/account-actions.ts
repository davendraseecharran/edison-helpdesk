'use server';

/**
 * Account administration.
 *
 * This is the only module that touches provider admin credentials, and every
 * entry point follows the same order:
 *
 *   1. Verify a live session with `getUser()`.
 *   2. Ask the DATABASE, in the admin's own session, whether this caller may do
 *      the thing. `app_admin_request_*` re-derives the actor from auth.uid() and
 *      raises if they are not a live active admin. A technician, an anonymous
 *      caller, a deactivated admin or a forged request body all fail there,
 *      before any service-role credential is used.
 *   3. Only then use the service role for the parts a user genuinely cannot do
 *      themselves: creating an auth user, generating a link, and calling the
 *      `app_trusted_*` functions that are granted to service_role alone.
 *
 * The generated link is returned to the authorized caller once and never
 * stored, logged, or written to the audit trail.
 */

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/supabase/config';
import { loadActor } from '@/lib/auth/session';

export interface AccountActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  /**
   * Present only on a successful link issue. Shown once in the result flow and
   * never persisted — treat it as a credential.
   */
  link?: string;
  expiresInSeconds?: number;
}

const LINK_TTL_SECONDS = 3600;

/** Fast fail for an obviously unusable session. The database decides for real. */
async function requireAdminSession(): Promise<{ ok: true } | AccountActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { ok: false, error: 'Only a signed-in administrator can manage accounts.' };
  }
  return { ok: true };
}

export async function createTechnicianAccountAction(
  displayName: string,
  email: string,
): Promise<AccountActionResult> {
  const gate = await requireAdminSession();
  if (gate.ok !== true) return gate;

  const supabase = await createClient();
  const normalisedEmail = email.trim().toLowerCase();

  // Authorization + reservation, in the admin's own session. Unique email makes
  // a retry return the same reservation instead of creating a second account.
  const { data: provisionId, error: reserveError } = await supabase.rpc(
    'app_admin_request_account',
    { p_email: normalisedEmail, p_display_name: displayName },
  );
  if (reserveError) return { ok: false, error: reserveError.message };

  const service = adminClient();

  // Create the auth user, or adopt the one a previous failed attempt left
  // behind, so a partial failure is recoverable rather than an orphan.
  let userId: string | null = null;
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: normalisedEmail,
    email_confirm: true,
  });
  if (created?.user) {
    userId = created.user.id;
  } else {
    const alreadyRegistered = /already (been )?registered|already exists/i.test(
      createError?.message ?? '',
    );
    if (!alreadyRegistered) {
      return {
        ok: false,
        error: `The account could not be created: ${createError?.message ?? 'unknown error'}. Try again.`,
      };
    }
    const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
    userId = list?.users.find((user) => user.email === normalisedEmail)?.id ?? null;
    if (!userId) {
      return { ok: false, error: 'An auth user exists for that email but could not be read.' };
    }
  }

  // Idempotent finalize: safe to retry after any failure above.
  const { error: finalizeError } = await service.rpc('app_trusted_finalize_account', {
    p_provision: provisionId,
    p_user: userId,
  });
  if (finalizeError) {
    return {
      ok: false,
      error: `The account was reserved but not finished: ${finalizeError.message}. Run the same request again to complete it.`,
    };
  }

  revalidatePath('/admin');
  return {
    ok: true,
    message: `${displayName} added with setup pending. Issue a setup link next.`,
  };
}

export async function issueCredentialLinkAction(
  accountId: string,
  purpose: 'setup' | 'recovery',
): Promise<AccountActionResult> {
  const gate = await requireAdminSession();
  if (gate.ok !== true) return gate;

  const supabase = await createClient();

  // The database authorizes, supersedes any earlier live link, and suspends the
  // target's ordinary access until the action completes.
  const { data: grantId, error: grantError } = await supabase.rpc('app_admin_request_credential_grant', {
    p_account: accountId,
    p_purpose: purpose,
    p_ttl_seconds: LINK_TTL_SECONDS,
  });
  if (grantError) return { ok: false, error: grantError.message };

  const service = adminClient();
  const { data: account, error: accountError } = await service
    .from('app_accounts')
    .select('email, display_name')
    .eq('id', accountId)
    .single();
  if (accountError || !account) {
    return { ok: false, error: 'That account could not be read.' };
  }

  // Both flows use the provider's `recovery` token type: an `invite` link
  // cannot be generated for an already-registered user, and every account here
  // is created up front. The app-level purpose lives in the grant row.
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'recovery',
    email: account.email as string,
  });
  if (linkError || !link) {
    return { ok: false, error: `The link could not be generated: ${linkError?.message ?? ''}` };
  }

  const { error: bindingError } = await service.rpc('app_trusted_bind_credential_link', {
    p_grant: grantId,
    p_digest: createHash('sha256').update(link.properties.hashed_token).digest('hex'),
  });
  if (bindingError) return { ok: false, error: 'This link was superseded. Issue a new link.' };

  // Build the callback from OUR origin only. The provider's action_link and any
  // caller-supplied redirect are ignored, so a link can never be pointed at
  // another host. The token travels in the fragment-free path below because the
  // callback is a POST-free exchange handled server-side.
  const callback = new URL('/auth/confirm', appOrigin());
  callback.searchParams.set('token_hash', link.properties.hashed_token);

  revalidatePath('/admin');
  return {
    ok: true,
    link: callback.toString(),
    expiresInSeconds: LINK_TTL_SECONDS,
    message: `Single-use ${purpose} link ready for ${account.display_name}. Hand it over in person; it is shown once.`,
  };
}

export async function cancelCredentialActionAction(
  accountId: string,
): Promise<AccountActionResult> {
  const gate = await requireAdminSession();
  if (gate.ok !== true) return gate;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_admin_cancel_credential_action', {
    p_account: accountId,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin');
  return { ok: true, message: 'Outstanding link cancelled.' };
}

export async function setAccountStatusAction(
  accountId: string,
  status: 'active' | 'inactive',
): Promise<AccountActionResult> {
  const gate = await requireAdminSession();
  if (gate.ok !== true) return gate;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_set_account_status', {
    p_account: accountId,
    p_status: status,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true, message: `Account is now ${status}.` };
}

