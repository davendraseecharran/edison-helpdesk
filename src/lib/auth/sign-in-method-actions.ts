'use server';

/**
 * The two things an account may do to its own ways in.
 *
 * Both start from a session the database already accepts, which is what makes
 * them different from everything in `credential-actions.ts`: that file is the
 * administrator-issued link flow, where the person arriving has proved nothing
 * yet and every earlier session has to be thrown away. Here they are already
 * signed in and at their own settings screen, so nothing is revoked.
 *
 * Neither action decides access. Adding Google hands the browser to the
 * provider and the callback's `app_trusted_link_identity` decides what the
 * verified address is worth; setting a password changes it through the
 * provider's own primitive and then asks the database to approve the digest.
 * The application never hashes or stores a password, and never logs one.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/supabase/config';
import { loadActor } from '@/lib/auth/session';
import { LINK_RETURN_COOKIE } from '@/lib/auth/link-return';
import { passwordProblem } from '@/lib/domain/password';

export interface PasswordResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Sends the browser to Google to attach a second identity to this account.
 *
 * Mirrors `signInWithGoogleAction`: the callback URL is built from this
 * application's own configured origin, never from anything the request carried,
 * and the account chooser is always shown because a shared machine is the
 * normal case. The difference is `linkIdentity`, which asks the auth server to
 * attach the identity to the CURRENT user rather than to sign somebody in, and
 * which the auth server refuses outright unless manual linking is switched on
 * for the project. That refusal is a configuration fact rather than a failed
 * sign-in, so it gets its own message on the way back.
 */
export async function addGoogleIdentityAction(): Promise<never> {
  // Linking is an account changing itself. A restricted session has nothing to
  // add an identity to, and the database would refuse it anyway.
  const actor = await loadActor();
  if (actor.kind !== 'active') redirect('/login');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: {
      redirectTo: new URL('/auth/callback', appOrigin()).toString(),
      // No browser to redirect: this runs on the server, so the auth server is
      // asked for the URL as JSON and this action does the redirecting.
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    },
  });

  if (error || !data?.url) {
    // The one refusal worth its own sentence, because nobody at the desk can
    // act on it and an administrator can fix it in a minute. The error code is
    // what the auth server actually sends; the message is checked as well so a
    // build that stops setting the code still says the useful thing.
    const refused =
      (error as { code?: string } | null)?.code === 'manual_linking_disabled' ||
      /manual linking/i.test(error?.message ?? '');
    redirect(refused ? '/settings?linkError=off' : '/settings?linkError=1');
  }

  // Why the callback should return them to Settings rather than to the queue.
  // One use, this origin, httpOnly; see `link-return.ts`.
  const jar = await cookies();
  jar.set(LINK_RETURN_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: appOrigin().startsWith('https://'),
    path: '/',
    maxAge: 600,
  });

  redirect(data.url);
}

/**
 * Sets or replaces the password of the account making the request.
 *
 * Two steps, in this order and for the same reason the link flow uses it:
 *
 *   1. `updateUser` through the CALLER'S OWN session. The provider owns the
 *      hash; the application never computes one.
 *   2. `app_trusted_approve_own_credential`, which makes the new hash the one
 *      the helpdesk accepts. It deliberately does NOT move the account's
 *      session cutoff — the person changed their own password while holding a
 *      current session, so signing them out would be the wrong answer.
 *
 * The helpdesk revokes nothing here. The provider still applies its own rule —
 * a password change ends this account's OTHER sessions and keeps the one that
 * made it — so somebody who was signed in on a second machine signs in again
 * there, with either method. That is GoTrue's decision, not a gate of ours.
 *
 * If the second step fails, the provider holds a password the helpdesk has not
 * approved. That fails CLOSED: `app_token_is_current` compares the two, so this
 * session stops reaching helpdesk records at its next request and an
 * administrator's recovery link is what repairs it. The message says so rather
 * than reporting a save that did not happen.
 */
export async function setOwnPasswordAction(password: string): Promise<PasswordResult> {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };

  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  const supabase = await createClient();
  const { error: passwordError } = await supabase.auth.updateUser({ password });
  if (passwordError) {
    // The provider's own refusals are worth repeating: the same password again,
    // or one it considers weak, are both things the reader can act on.
    return { ok: false, error: passwordError.message };
  }

  const { error: approveError } = await adminClient().rpc('app_trusted_approve_own_credential', {
    p_user: actor.account.id,
  });
  if (approveError) {
    return {
      ok: false,
      error:
        'The password changed but the helpdesk did not approve it. Ask an administrator for a recovery link.',
    };
  }

  return { ok: true, message: 'Password saved.' };
}
