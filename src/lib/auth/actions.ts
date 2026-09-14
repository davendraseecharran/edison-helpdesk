'use server';

/** Sign-in and sign-out. */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { landingPath, normalizeRoles } from '@/lib/auth/roles';
import { isScanPath } from '@/lib/scan/relay';

export interface SignInResult {
  ok: boolean;
  error?: string;
  /** Where to go now. Always this application's own path, decided here. */
  next?: string;
}

/**
 * Where a successful sign-in lands.
 *
 * The queue for anybody who works tickets and the directory for a skills
 * officer who does not, except a phone that was sent here by the scanner page:
 * that one has to come back to the pairing it was opening, or the NetRider has
 * to walk back to the desktop and start again.
 *
 * The role set is read back from the database with the session that was just
 * created, never from anything the browser sent.
 *
 * The allow-list is `isScanPath` and nothing else, and the decision is made
 * HERE, on the server, from the value the caller supplied. A destination the
 * caller chose is only ever a request; this is the answer.
 */
async function destination(
  supabase: Awaited<ReturnType<typeof createClient>>,
  next: unknown,
): Promise<string> {
  if (isScanPath(next)) return next;
  const { data } = await supabase.rpc('app_my_account');
  const row = Array.isArray(data) ? (data[0] as { roles?: unknown } | undefined) : undefined;
  return landingPath(normalizeRoles(row?.roles));
}

export async function signInAction(
  email: string,
  password: string,
  next?: string,
): Promise<SignInResult> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    // One message for every failure mode. A wrong password, an unknown address,
    // a deactivated account and an account still awaiting setup are
    // indistinguishable to an unauthenticated prober.
    return { ok: false, error: 'That email address and password did not match an active account.' };
  }

  return { ok: true, next: await destination(supabase, next) };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
