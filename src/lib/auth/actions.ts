'use server';

/** Sign-in and sign-out. */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface SignInResult {
  ok: boolean;
  error?: string;
}

export async function signInAction(email: string, password: string): Promise<SignInResult> {
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

  return { ok: true };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
