/**
 * A Google-only administrator counts as a usable administrator.
 *
 * `app_set_account_roles` refuses to leave the helpdesk without one, and until
 * 20260915010100 "usable" meant "has the password digest the helpdesk
 * approved". Google sign-in is the primary door in M5, so an administrator who
 * has only ever pressed "Continue with Google" has no password at all and was
 * invisible to the count — with one password administrator and any number of
 * Google-only ones, the count was 1 and nobody could be demoted.
 *
 * The test builds exactly that shape out of the seeded accounts: a second
 * administrator whose approved digest no longer matches, so the password branch
 * cannot count it, and then gives it a Google identity and asks again. Before
 * the fix the second call refuses; after it, it succeeds.
 *
 * Everything is restored in a `finally` — the borrowed account's roles, its
 * approved digest and the synthetic identity — so a failed assertion half way
 * through cannot leave the next file in the suite a second administrator.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { adminServiceClient, identity, rpcFails, rpcOk, signIn, forgetSessions } from './support/harness';
import { localDatabaseContainer } from './support/local-only';

function psql(sql: string): string {
  const docker = existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker';
  return execFileSync(
    docker,
    ['exec', '-i', localDatabaseContainer(), 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

describe('who counts as a usable administrator', () => {
  it('counts a Google identity, and still refuses when nobody else can sign in', async () => {
    const service = adminServiceClient();
    const borrowed = identity('owner').id;

    const digest = await service
      .from('account_credential_state')
      .select('approved_digest')
      .eq('account_id', borrowed)
      .single();
    if (digest.error || !digest.data) throw new Error('Could not read synthetic credential state.');

    try {
      // A second administrator who cannot sign in with a password: promoted,
      // active, and carrying a digest the helpdesk never approved.
      const promoted = await service
        .from('app_accounts')
        .update({ role: 'admin', roles: ['admin'] })
        .eq('id', borrowed);
      expect(promoted.error).toBeNull();

      const invalidated = await service
        .from('account_credential_state')
        .update({ approved_digest: 'synthetic-unapproved' })
        .eq('account_id', borrowed);
      expect(invalidated.error).toBeNull();

      // Only the seeded administrator can actually sign in, so demoting the
      // borrowed one would leave one usable administrator, and it is refused.
      const refused = await rpcFails(await signIn('admin'), 'app_set_account_roles', {
        p_account: borrowed,
        p_roles: ['netrider'],
      });
      expect(refused.message).toMatch(/last active administrator/i);

      // Now it can sign in — the way nearly everybody in this school does.
      psql(`insert into auth.identities (provider_id, user_id, identity_data, provider)
            values ('synthetic-google-${borrowed}', '${borrowed}',
                    jsonb_build_object('sub', 'synthetic-google-${borrowed}', 'email', 'synthetic@edison.example'),
                    'google')
            on conflict do nothing;`);

      const demoted = await rpcOk<string>(await signIn('admin'), 'app_set_account_roles', {
        p_account: borrowed,
        p_roles: ['netrider'],
      });
      expect(demoted).toBe(borrowed);

      const after = await service
        .from('app_accounts')
        .select('role, roles, status')
        .eq('id', borrowed)
        .single();
      expect(after.data).toEqual({ role: 'technician', roles: ['netrider'], status: 'active' });
    } finally {
      psql(`delete from auth.identities where user_id = '${borrowed}' and provider = 'google';`);
      // Put the borrowed account back where it was found, by the same door it
      // was moved through, whatever happened above: an assertion that fails
      // half way must not leave the next file a second administrator.
      const roles = await service
        .from('app_accounts')
        .update({ role: 'technician', roles: ['netrider'] })
        .eq('id', borrowed);
      if (roles.error) throw new Error('Could not restore the borrowed account.');
      const restored = await service
        .from('account_credential_state')
        .update({ approved_digest: digest.data.approved_digest })
        .eq('account_id', borrowed);
      if (restored.error) throw new Error('Could not restore synthetic credential state.');
      // The role change moved `sessions_valid_from`, so any cached session for
      // the borrowed account is now older than the account allows.
      forgetSessions();
    }
  });
});
