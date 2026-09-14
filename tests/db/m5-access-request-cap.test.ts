/**
 * The bound on outstanding access requests (Ruling 31).
 *
 * `app_trusted_link_identity` creates a `pending_approval` account for any
 * verified Google address nobody invited, and tells every administrator. Without
 * a bound, a supply of Google accounts fills the accounts table and buries the
 * real waiting list under one notification each.
 *
 * Fifty is the cap. This file proves the three things that matter about it
 * through the same surface the OAuth callback uses — the trusted function called
 * with the service role, against real Auth users:
 *
 *   1. Below the cap nothing changes: the request is taken as before.
 *   2. At the cap the function refuses with `access_requests_full` (P9003) and
 *      writes NOTHING — no account row, no notification — so the identity is
 *      left unlinked and can try again.
 *   3. An administrator answering one request frees the slot immediately.
 *
 * Everything this file creates is removed afterwards: the accounts, their audit
 * rows, the notifications they raised and the Auth users behind them. A later
 * file must not find fifty strangers waiting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { adminServiceClient, rpcOk, signIn } from './support/harness';

/** The cap in 20260912101400_m5_access_request_cap.sql. */
const CAP = 50;
const REQUESTS_FULL = 'P9003';

/** Marks every address this file invents, so the teardown can find them all. */
const MARK = 'capseed-';

let service: SupabaseClient;
let admin: SupabaseClient;

/** Auth users created here, oldest first. */
const created: string[] = [];
/** The accounts this file put into pending_approval, oldest first. */
const waiting: string[] = [];

interface LinkResult {
  outcome: string;
  account_id: string | null;
  status: string | null;
}

/**
 * An Auth user with a verified address and no password: the linking function
 * looks at `email_confirmed_at` and the identities, never at a credential, and
 * skipping the password hash keeps fifty of these to a few seconds.
 */
async function verifiedUser(): Promise<string> {
  const email = `${MARK}${randomUUID().slice(0, 8)}@edison.example`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { provider: 'google', providers: ['google'] },
  });
  if (error || !data.user) throw new Error(`Could not create an Auth user: ${error?.message}`);
  created.push(data.user.id);
  return data.user.id;
}

/** Exactly what /auth/callback does once the provider hands back a session. */
async function link(userId: string): Promise<LinkResult> {
  const rows = await rpcOk<LinkResult[]>(service, 'app_trusted_link_identity', { p_user: userId });
  if (rows.length !== 1) throw new Error(`Expected one linking result, got ${rows.length}.`);
  return rows[0];
}

async function linkFails(userId: string): Promise<{ code: string; message: string }> {
  const { error } = await service.rpc('app_trusted_link_identity', { p_user: userId });
  if (!error) throw new Error('Expected the link to be refused, but it succeeded.');
  return { code: error.code ?? '', message: error.message };
}

async function pendingCount(): Promise<number> {
  const { count, error } = await service
    .from('app_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_approval');
  if (error) throw new Error(`Could not count waiting accounts: ${error.message}`);
  return count ?? 0;
}

async function accountExists(userId: string): Promise<boolean> {
  const { data, error } = await service.from('app_accounts').select('id').eq('id', userId);
  if (error) throw new Error(`Could not look for an account: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Notifications this file's requests raised, however many administrators saw them. */
async function requestNotifications(): Promise<number> {
  const { count, error } = await service
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'access_requested')
    .like('body', `%${MARK}%`);
  if (error) throw new Error(`Could not count notifications: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  service = adminServiceClient();
  admin = await signIn('admin');

  // Fill the waiting list to exactly the cap. The seed already leaves one
  // account waiting, so this adds however many the cap is short of.
  while ((await pendingCount()) < CAP) {
    const user = await verifiedUser();
    const result = await link(user);
    expect(result.outcome).toBe('requested');
    expect(result.status).toBe('pending_approval');
    waiting.push(user);
  }
  expect(await pendingCount()).toBe(CAP);
});

afterAll(async () => {
  // Denied rather than left waiting, so the deletes below are not racing the
  // cap, and so a failure part-way through this teardown still leaves the next
  // file a list it can add to.
  for (const id of waiting) {
    if (await accountExists(id)) {
      await service.from('app_accounts').update({ status: 'denied' }).eq('id', id);
    }
  }
  await service.from('notifications').delete().eq('kind', 'access_requested').like('body', `%${MARK}%`);
  await service.from('account_events').delete().in('account_id', created);
  await service.from('app_accounts').delete().in('id', created);
  for (const id of created) await service.auth.admin.deleteUser(id);
});

describe('the cap on outstanding access requests', () => {
  it('refuses the request after the fiftieth, and links nothing', async () => {
    const before = await requestNotifications();
    const user = await verifiedUser();

    const failure = await linkFails(user);
    expect(failure.code).toBe(REQUESTS_FULL);
    expect(failure.message).toMatch(/access_requests_full/);

    // Nothing was written: no account, no audit row, no administrator told.
    expect(await accountExists(user)).toBe(false);
    expect(await pendingCount()).toBe(CAP);
    expect(await requestNotifications()).toBe(before);
  });

  it('takes the next request as soon as an administrator answers one', async () => {
    const answered = waiting[0];
    await rpcOk(admin, 'app_admin_review_access_request', {
      p_account: answered,
      p_decision: 'deny',
    });
    expect(await pendingCount()).toBe(CAP - 1);

    const user = await verifiedUser();
    const result = await link(user);
    expect(result.outcome).toBe('requested');
    expect(result.status).toBe('pending_approval');
    waiting.push(user);
    expect(await pendingCount()).toBe(CAP);
  });
});
