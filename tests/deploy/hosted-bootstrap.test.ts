import { describe, expect, it } from 'vitest';
// @ts-expect-error Operator CLI is deliberately standalone JavaScript.
import { bootstrap, validateConfig } from '../../scripts/bootstrap-hosted-admin.mjs';
import { accountRow, anonClient, completeWithPassword, ephemeralPassword, exchangeLink,
  serviceClient, signIn, syntheticEmail } from '../auth/support/harness';

describe('first-admin deployment bootstrap (local synthetic database only)', () => {
  it('refuses a mismatched project, insecure origin, and missing credentials before any network call', () => {
    const project = 'a'.repeat(20);
    const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic', NEXT_PUBLIC_APP_ORIGIN: 'https://helpdesk.example' };
    const args = [project, 'test@edison.example', 'Test admin'];
    expect(validateConfig(env, args).email).toBe('test@edison.example');
    expect(() => validateConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, args)).toThrow();
    expect(() => validateConfig({ ...env, NEXT_PUBLIC_APP_ORIGIN: 'http://helpdesk.example' }, args)).toThrow();
    expect(() => validateConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: '' }, args)).toThrow();
  });

  it('resumes only its pending identity, binds setup, activates with a chosen password, and refuses rerun', async () => {
    const service = serviceClient();
    const config = { email: syntheticEmail('bootstrap'), name: 'Synthetic first admin', origin: 'https://helpdesk.example' };
    const untrusted = await anonClient().rpc('app_trusted_bootstrap_admin', {
      p_user: '00000000-0000-0000-0000-000000000001', p_email: config.email, p_display_name: config.name,
    });
    expect(untrusted.error?.message).toMatch(/permission denied/i);
    const unrelatedEmail = syntheticEmail('unrelated');
    expect((await service.auth.admin.createUser({ email: unrelatedEmail, email_confirm: true })).error).toBeNull();
    await expect(bootstrap({ ...config, email: unrelatedEmail }, service)).rejects.toThrow(/refusing to adopt/i);
    const firstLink = await bootstrap(config, service);
    const retryLink = await bootstrap(config, service);
    // Never include bearer links in assertion output.
    expect(firstLink !== retryLink).toBe(true);
    const accounts = await service.from('app_accounts').select('id,status,role').eq('email', config.email);
    expect(accounts.data?.length).toBe(1);
    const account = accounts.data![0];
    expect(account.status).toBe('setup_pending');
    expect(account.role).toBe('admin');
    const interrupted = await exchangeLink(new URL(retryLink).searchParams.get('token_hash')!);
    expect(interrupted.ok).toBe(true);
    expect((await interrupted.client!.auth.updateUser({ password: ephemeralPassword() })).error).toBeNull();
    // Provider mutation succeeded but trusted completion never ran: operator can repair.
    const repairLink = await bootstrap(config, service);
    const exchanged = await exchangeLink(new URL(repairLink).searchParams.get('token_hash')!);
    expect(exchanged.ok).toBe(true);
    const password = ephemeralPassword();
    expect((await completeWithPassword(exchanged.client!, account.id, password)).ok).toBe(true);
    expect((await accountRow(account.id)).status).toBe('active');
    const signed = await signIn(config.email, password);
    expect((await signed.client.rpc('app_my_account')).data?.[0]?.session_is_current).toBe(true);
    const denied = await signed.client.rpc('app_trusted_bootstrap_admin', { p_user: account.id, p_email: config.email, p_display_name: config.name });
    expect(denied.error?.message).toMatch(/permission denied/i);
    await expect(bootstrap(config, service)).rejects.toThrow(/administrator already exists/i);
    const direct = await service.rpc('app_trusted_bootstrap_admin', {
      p_user: account.id, p_email: config.email, p_display_name: config.name,
    });
    expect(direct.error).not.toBeNull();
  });
});
