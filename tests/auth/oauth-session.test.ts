/**
 * Which kinds of session may reach the helpdesk.
 *
 * `app_token_is_current` is the predicate every access gate consults, and one of
 * the things it insists on is HOW the session was authenticated. That is what
 * stops a setup or recovery link — exchanged for a real, signed session, but a
 * session established only by possessing the link — from reaching tickets before
 * the password has actually been changed. The provider records that fact in
 * `auth.mfa_amr_claims`:
 *
 *   password — signed in with an address and a password.
 *   oauth    — signed in through an external provider, which is what Google
 *              sign-in produces and what M5 has to admit.
 *   otp      — exchanged a one-time link, which must stay restricted.
 *
 * No OAuth provider is configured on a local stack, so a genuine `oauth` session
 * cannot be obtained here. These tests therefore take a real signed-in session
 * and restate the method recorded against it, which exercises the predicate for
 * exactly what it reads. Everything else about the session — the JWT, the
 * session row, the password digest binding — is genuine and untouched.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdmin, serviceClient, sessionId } from './support/harness';

type Method = 'password' | 'oauth' | 'otp';

/** Restates the method recorded for one session; returns the rows it changed. */
async function setSessionMethod(session: string, method: Method): Promise<number> {
  const { data, error } = await serviceClient().rpc('app_test_set_session_amr', {
    p_session: session,
    p_method: method,
  });
  if (error) throw new Error(`Could not restate the session method: ${error.message}`);
  return data as number;
}

async function sessionIsCurrent(client: SupabaseClient): Promise<boolean | undefined> {
  const { data, error } = await client.rpc('app_my_account');
  if (error) throw new Error(`app_my_account failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ session_is_current: boolean }>;
  return rows[0]?.session_is_current;
}

/**
 * A mutating RPC and a read RPC, so both gates are covered: the read path goes
 * through app_active_account_id() and the write path through app_require_actor().
 */
async function reachesTheHelpdesk(
  client: SupabaseClient,
): Promise<{ read: string | null; write: string | null }> {
  const read = await client.rpc('app_directory');
  const write = await client.rpc('app_mark_notifications_read', { p_ids: null });
  return { read: read.error?.message ?? null, write: write.error?.message ?? null };
}

describe('how a session was authenticated', () => {
  it('admits a provider sign-in and keeps a link exchange restricted', async () => {
    const admin = await createAdmin('Morgan Ellis');
    const session = await sessionId(admin.session.client);

    // A password sign-in works, which is the baseline every other M3 test relies
    // on and the state this test restores at the end.
    expect(await sessionIsCurrent(admin.session.client)).toBe(true);
    expect(await reachesTheHelpdesk(admin.session.client)).toEqual({ read: null, write: null });

    // (a) The same session, recorded the way a Google sign-in records it.
    expect(await setSessionMethod(session, 'oauth')).toBe(1);
    expect(
      await sessionIsCurrent(admin.session.client),
      'a provider sign-in is a real authentication and must be accepted',
    ).toBe(true);
    expect(await reachesTheHelpdesk(admin.session.client)).toEqual({ read: null, write: null });

    // (b) The same session, recorded the way a setup or recovery link records
    // it. Possessing a link must never be enough to reach helpdesk records.
    expect(await setSessionMethod(session, 'otp')).toBe(1);
    expect(
      await sessionIsCurrent(admin.session.client),
      'a link exchange is not a sign-in and must stay restricted',
    ).toBe(false);
    const restricted = await reachesTheHelpdesk(admin.session.client);
    expect(restricted.read).toMatch(/cannot access helpdesk records/i);
    expect(restricted.write).toMatch(/signed out|cannot access helpdesk records/i);

    // (c) Back to how it really was, so nothing after this sees a doctored row.
    expect(await setSessionMethod(session, 'password')).toBe(1);
    expect(await sessionIsCurrent(admin.session.client)).toBe(true);
    expect(await reachesTheHelpdesk(admin.session.client)).toEqual({ read: null, write: null });
  });

  it('still refuses a provider session whose account is not active', async () => {
    // Admitting `oauth` widens HOW a session may have been authenticated. It
    // must not widen WHO may use one: every other gate still applies.
    const reviewer = await createAdmin('Priya Raman');
    const subject = await createAdmin('Dev Okafor');
    const session = await sessionId(subject.session.client);
    expect(await setSessionMethod(session, 'oauth')).toBe(1);
    expect(await reachesTheHelpdesk(subject.session.client)).toEqual({ read: null, write: null });

    const { error } = await reviewer.session.client.rpc('app_set_account_status', {
      p_account: subject.id,
      p_status: 'inactive',
    });
    expect(error).toBeNull();

    const refused = await reachesTheHelpdesk(subject.session.client);
    expect(refused.read).toMatch(/cannot access helpdesk records/i);
    expect(refused.write).toMatch(/cannot access helpdesk records/i);
    expect(await sessionIsCurrent(subject.session.client)).toBe(false);
  });

  it('keeps the session helper away from every client role', async () => {
    const admin = await createAdmin();
    const session = await sessionId(admin.session.client);

    const asAdmin = await admin.session.client.rpc('app_test_set_session_amr', {
      p_session: session,
      p_method: 'oauth',
    });
    expect(asAdmin.error?.message).toMatch(/permission denied/i);

    // And it only ever moves a claim between the methods the app recognises.
    const nonsense = await serviceClient().rpc('app_test_set_session_amr', {
      p_session: session,
      p_method: 'totp',
    });
    expect(nonsense.error?.message).toMatch(/password, oauth or otp/i);
  });
});
