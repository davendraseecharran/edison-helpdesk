'use server';

/**
 * Completing a setup or recovery.
 *
 * Ordering matters and is deliberately fail-closed:
 *
 *   1. Verify the session with `getUser()`.
 *   2. Reserve the exact live grant bound to the verified provider session.
 *   3. Change the password through the USER'S OWN session. This is the
 *      provider's primitive; the application never hashes or stores a password.
 *   4. Verify that the provider's current password matches this request and
 *      consume that same grant/session pair. Store only a fingerprint of the
 *      provider's hash; direct provider changes then fail closed in the app.
 *   5. Sign the browser out so the next sign-in uses the new password.
 *
 * If completion fails after the provider update, the new credential is not
 * approved for helpdesk access. A new administrator-issued link repairs the
 * account. Passwords are transient provider/RPC inputs, never stored or logged
 * by the application. The completion lease prevents overlapping submissions.
 */

import { createClient } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';

export interface CredentialCompletionResult {
  ok: boolean;
  error?: string;
  purpose?: 'setup' | 'recovery';
}

const MIN_PASSWORD_LENGTH = 12;

export async function completeCredentialAction(
  password: string,
  confirmation: string,
): Promise<CredentialCompletionResult> {
  if (password !== confirmation) {
    return { ok: false, error: 'The two entries do not match.' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return { ok: false, error: 'This link is no longer valid. Ask an administrator for a new one.' };
  }

  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const sessionId = claims?.claims.session_id;
  if (claimsError || typeof sessionId !== 'string' || claims?.claims.sub !== userData.user.id) {
    return { ok: false, error: 'This link is no longer valid. Request a new link.' };
  }
  const { data: grantId, error: beginError } = await adminClient().rpc('app_trusted_begin_credential_action', {
    p_account: userData.user.id,
    p_session: sessionId,
  });
  if (beginError || typeof grantId !== 'string') {
    return { ok: false, error: 'This link is no longer valid, or a password change is already in progress.' };
  }

  const { error: passwordError } = await supabase.auth.updateUser({ password });
  if (passwordError) {
    return { ok: false, error: passwordError.message };
  }

  const { data: completion, error: completionError } = await adminClient().rpc(
    'app_trusted_complete_credential_action',
    { p_account: userData.user.id, p_grant: grantId, p_session: sessionId, p_password: password },
  );

  if (completionError || !Array.isArray(completion) || completion.length === 0) {
    // The password changed but the account was not activated. Fail closed and
    // keep the session out of the helpdesk.
    await supabase.auth.signOut();
    return {
      ok: false,
      error:
        'The password was changed but setup could not be completed. Ask an administrator for a new link.',
    };
  }

  const purpose = (completion[0] as { purpose: string }).purpose as 'setup' | 'recovery';

  // Every token minted before completion is now refused by the database. Sign
  // out so this browser gets a clean session by signing in with the new password.
  await supabase.auth.signOut({ scope: 'global' });

  return { ok: true, purpose };
}
