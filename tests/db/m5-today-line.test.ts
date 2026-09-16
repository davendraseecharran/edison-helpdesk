/**
 * Where the assistant's line under the Today greeting is kept.
 *
 * `20260914180000_m5_today_line.sql` adds one jsonb column to the row an
 * account already has and one RPC that writes it. Four things about that column
 * are load-bearing, and the application would be quietly wrong about each:
 *
 * 1. THE THREE FIELDS TRAVEL TOGETHER. A line without the hash of the briefing
 *    it was written from is a line nobody can tell is stale, and the whole
 *    reason for the cache is that a sentence about a queue that has changed is
 *    worse than no sentence.
 * 2. THE DATABASE STAMPS THE TIME. Freshness is measured in ten minutes; a
 *    clock the caller could set is not one to measure it with.
 * 3. IT IS A CACHE, NOT A SETTING. Writing it must not move `updated_at`, or a
 *    greeting rewritten in the background would make the settings row look as
 *    though somebody had changed something.
 * 4. IT IS THE CALLER'S OWN. Every write lands on the row of whoever called,
 *    which is what `app_require_actor()` is for.
 *
 * Exercised through real signed-in sessions, because the actor is derived
 * inside the function body and a test that called it any other way would prove
 * nothing about the application.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, rpcFails, rpcOk, signIn } from './support/harness';

interface Preferences {
  account_id: string;
  updated_at: string;
  today_line: { line?: string; hash?: string; generated_at?: string } | null;
}

/*
 * A collaborator and a skills officer, and neither by accident: `m5-ai.test.ts`
 * proves that the preferences row is created on first ask, and it proves it
 * with `owner` and `unrelated`. A file that wrote those rows first would make
 * that test's precondition false depending on the order two files happened to
 * run in.
 */
let worker: SupabaseClient;
let officer: SupabaseClient;

async function preferences(client: SupabaseClient): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_my_preferences');
}

async function setLine(
  client: SupabaseClient,
  line: string,
  hash: string,
): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_set_today_line', { p_line: line, p_hash: hash });
}

beforeAll(async () => {
  worker = await signIn('collaborator');
  officer = await signIn('skillsOfficer');
});

describe('app_set_today_line', () => {
  it('stores the line, the fingerprint it was written from and when', async () => {
    const before = Date.now();
    const row = await setLine(
      worker,
      'Two projector tickets in 118 look like one fault.',
      'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
    );

    expect(row.today_line?.line).toBe('Two projector tickets in 118 look like one fault.');
    expect(row.today_line?.hash).toBe('a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4');

    // Stamped by the database, in a form the application can parse.
    const at = Date.parse(row.today_line?.generated_at ?? '');
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);

    // And it is there on the next ordinary read of this account's settings.
    const read = await preferences(worker);
    expect(read.today_line?.line).toBe('Two projector tickets in 118 look like one fault.');
  });

  it('replaces the whole value rather than merging into it', async () => {
    await setLine(worker, 'The queue is clear.', 'first');
    const row = await setLine(worker, 'Three machines are due back.', 'second');

    expect(row.today_line?.line).toBe('Three machines are due back.');
    expect(row.today_line?.hash).toBe('second');
  });

  it('clamps a line longer than the screen gives it rather than raising', async () => {
    const long =
      'Every projector in the building has failed at once, and so has the network in the west wing.';
    expect(long.length).toBeGreaterThan(90);

    const row = await setLine(worker, long, 'clamped');
    expect(row.today_line?.line).toHaveLength(90);
    expect(long.startsWith(row.today_line?.line ?? '')).toBe(true);
  });

  it('refuses a line or a fingerprint that says nothing', async () => {
    const empty = await rpcFails(worker, 'app_set_today_line', { p_line: '   ', p_hash: 'abc' });
    expect(empty.message).toContain('Send the line and the hash');

    const unkeyed = await rpcFails(worker, 'app_set_today_line', {
      p_line: 'The queue is clear.',
      p_hash: '',
    });
    expect(unkeyed.message).toContain('Send the line and the hash');
  });

  it('does not make the settings row look changed', async () => {
    const before = await preferences(worker);
    const after = await setLine(worker, 'One ticket is waiting on a reply.', 'untouched');
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('writes the caller’s own row and nobody else’s', async () => {
    await setLine(worker, 'Two projectors look like one fault.', 'worker-hash');
    await setLine(officer, 'One person is waiting for access.', 'officer-hash');

    const mine = await preferences(worker);
    const theirs = await preferences(officer);

    expect(mine.today_line?.line).toBe('Two projectors look like one fault.');
    expect(theirs.today_line?.line).toBe('One person is waiting for access.');
    expect(mine.account_id).not.toBe(theirs.account_id);
  });

  it('is closed to a session that is not signed in', async () => {
    const refused = await rpcFails(anonClient(), 'app_set_today_line', {
      p_line: 'The queue is clear.',
      p_hash: 'anon',
    });
    expect(refused.message).not.toBe('');
  });
});
