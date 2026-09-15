/**
 * A saved view's path cannot leave the application.
 *
 * The chips above the filter bar render as anchors, so `path` is the one field
 * in `account_preferences` that becomes a link. `app_set_saved_views` rebuilds
 * every element it stores and drops any whose path is not in-app; this file
 * proves the rule at the database, which is where it has to hold — the browser
 * that posts the list is the thing being defended against.
 *
 * `//evil.com` was always refused. `/\evil.com` was not, and every browser
 * normalises a leading `/\` into `//`, which made it the same off-site link
 * spelled differently (20260914150300).
 *
 * Every case is asserted through the round trip — set, then read back with
 * `app_my_preferences` — because what is stored is what a later render trusts.
 *
 * The account is this file's own rather than a seeded one: it writes preferences
 * for whoever is signed in, and a shared identity would leave another file's
 * saved views replaced. It is created, used and deleted here, and it authors
 * nothing, so nothing in the schema holds a reference to it afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { adminServiceClient, anonClient, rpcOk, stack } from './support/harness';

interface StoredView {
  id: string;
  name: string;
  path: string;
  query: string;
}

function view(id: string, path: string): StoredView {
  return { id, name: `View ${id}`, path, query: 'status=open' };
}

let service: SupabaseClient;
let viewer: SupabaseClient;
let accountId = '';

/** The paths stored after one `app_set_saved_views` call. */
async function store(views: StoredView[]): Promise<string[]> {
  await rpcOk(viewer, 'app_set_saved_views', { p_views: views });
  const row = await rpcOk<Record<string, unknown>>(viewer, 'app_my_preferences');
  const raw = row?.saved_views;
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (Array.isArray(parsed) ? parsed : []).map((entry) => String((entry as StoredView).path));
}

beforeAll(async () => {
  service = adminServiceClient();

  // The account row is inserted AFTER the password exists, which is what makes
  // the session current: the credential trigger captures the hash on insert.
  const mark = randomUUID().slice(0, 8);
  const email = `viewseed-${mark}@edison.example`;
  const password = `Ed-${randomUUID()}`;

  const { data: created, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw new Error(`Could not create the viewer: ${error?.message}`);
  accountId = created.user.id;

  const { error: accountError } = await service.from('app_accounts').insert({
    id: accountId,
    display_name: `View Seed ${mark}`,
    email,
    roles: ['netrider'],
    status: 'active',
  });
  if (accountError) throw new Error(`Could not seed the viewer: ${accountError.message}`);

  viewer = anonClient();
  const { error: signInError } = await viewer.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Could not sign in the viewer: ${signInError.message}`);
});

afterAll(async () => {
  if (accountId === '') return;
  await service.from('account_preferences').delete().eq('account_id', accountId);
  await service.from('account_events').delete().eq('account_id', accountId);
  await service.from('app_accounts').delete().eq('id', accountId);
  await service.auth.admin.deleteUser(accountId);
});

describe('app_set_saved_views, on the path', () => {
  it('runs against a local stack', () => {
    expect(stack().apiUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  });

  it('keeps an ordinary in-app path', async () => {
    expect(await store([view('a', '/tickets')])).toEqual(['/tickets']);
  });

  it('drops a protocol-relative URL', async () => {
    expect(await store([view('a', '//evil.example')])).toEqual([]);
  });

  it('drops the backslash spelling of one', async () => {
    // The finding. A browser reads `/\evil.example` as `//evil.example`.
    expect(await store([view('a', '/\\evil.example')])).toEqual([]);
  });

  it('drops an absolute URL and a path with no leading slash', async () => {
    expect(await store([view('a', 'https://evil.example')])).toEqual([]);
    expect(await store([view('b', 'tickets')])).toEqual([]);
  });

  it('keeps the good ones out of a mixed list rather than refusing all of it', async () => {
    const stored = await store([
      view('a', '/tickets'),
      view('b', '/\\evil.example'),
      view('c', '/devices'),
    ]);
    expect(stored).toEqual(['/tickets', '/devices']);
  });
});
