import 'server-only';

/**
 * What the signed-in account can sign in with.
 *
 * Neither fact can be read by a client: `auth.identities` is not exposed
 * through the API at all, and `account_credential_state` is revoked from every
 * client role. `app_my_sign_in_methods()` reads both for the caller alone and
 * takes no parameter, so this read runs in the person's own session like every
 * other read on the settings screen.
 */

import { createClient } from '@/lib/supabase/server';

export interface SignInMethods {
  /** The address of this account's Google identity, or null when there is none. */
  googleEmail: string | null;
  /** True only for a password the helpdesk approved, which is the one that works. */
  hasPassword: boolean;
}

export async function loadSignInMethods(): Promise<SignInMethods> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_my_sign_in_methods');

  // A database that predates this migration answers with an error rather than a
  // row. Both methods then read as absent, which offers to add each of them —
  // the shell already says the schema is behind, and neither offer can do harm:
  // the functions behind them do not exist there either.
  if (error || !Array.isArray(data) || data.length === 0) {
    return { googleEmail: null, hasPassword: false };
  }

  const row = data[0] as { google_email: string | null; has_password: boolean };
  return {
    googleEmail: row.google_email ?? null,
    hasPassword: row.has_password === true,
  };
}
