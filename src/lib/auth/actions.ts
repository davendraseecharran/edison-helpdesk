'use server';

/** Sign-in and sign-out. */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
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
 * `/queue` for everybody, except a phone that was sent here by the scanner
 * page: that one has to come back to the pairing it was opening, or the
 * technician has to walk back to the desktop and start again.
 *
 * The allow-list is `isScanPath` and nothing else, and the decision is made
 * HERE, on the server, from the value the caller supplied. A destination the
 * caller chose is only ever a request; this is the answer.
 */
function destination(next: unknown): string {
  return isScanPath(next) ? next : '/queue';
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

  return { ok: true, next: destination(next) };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
