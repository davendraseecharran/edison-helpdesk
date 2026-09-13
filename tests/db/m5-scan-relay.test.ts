/**
 * M5 phone scanner relay: the short-lived channel that lets a technician's phone
 * type a barcode into their own desktop session.
 *
 * The shape of the feature is what makes the rules matter. A session id travels
 * OUT OF THE BROWSER — it is rendered as a QR code, photographed, and opened on a
 * second device — so the id is not a secret in the way a row id normally is. What
 * keeps the channel private is that both ends have to be signed in as the SAME
 * ACCOUNT: the phone opens `/scan/<id>` and has to authenticate before it can
 * record anything, and every RPC here re-derives the actor inside the database
 * and compares it to the session's owner.
 *
 * Four rules are proven below.
 *
 *   1. A session belongs to one account. Another technician holding the id — which
 *      they could have read off a screen — can neither read the session, record
 *      into it, nor end it, and is told exactly what they would be told about an
 *      id that never existed.
 *   2. A session is short-lived twice over: it expires on its own after thirty
 *      minutes, and it can be stopped by hand. Neither state accepts a scan, and
 *      the refusal says how to get going again.
 *   3. An account holds at most five live sessions. Opening a sixth ends the
 *      oldest rather than refusing, because a stale pairing dialog left open on a
 *      forgotten tab must never stop somebody scanning a laptop.
 *   4. Nothing here is writable from a session. Both tables are read-only to
 *      `authenticated`; the four RPCs are the only way in.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, which is also used to age a session artificially — the only way
 * to reach the expiry branch without waiting half an hour.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

/** insufficient_privilege, check_violation and no_data_found, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';
const MISSING = 'P0002';

/** The one message a caller gets for a session that is missing and for one that is not theirs. */
const UNAVAILABLE = 'That scan session is not available to this account.';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let helper: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let denied: SupabaseClient;

interface ScanSession {
  id: string;
  account_id: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
}

interface ScanSessionView {
  id: string;
  label: string | null;
  expires_at: string;
  ended_at: string | null;
  active: boolean;
}

interface ScanEvent {
  id: string;
  session_id: string;
  code: string;
  format: string | null;
  scanned_at: string;
}

async function startSession(
  client: SupabaseClient,
  label: string | null = 'Serial number',
): Promise<ScanSession> {
  return rpcOk<ScanSession>(client, 'app_start_scan_session', { p_label: label });
}

async function sessionView(
  client: SupabaseClient,
  sessionId: string,
): Promise<ScanSessionView[]> {
  return rpcOk<ScanSessionView[]>(client, 'app_scan_session', { p_session: sessionId });
}

async function recordScan(
  client: SupabaseClient,
  sessionId: string,
  code: string,
  format: string | null = 'code_128',
): Promise<string> {
  return rpcOk<string>(client, 'app_record_scan', {
    p_session: sessionId,
    p_code: code,
    p_format: format,
  });
}

async function scanEvents(
  client: SupabaseClient,
  sessionId: string,
  after: string | null = null,
): Promise<ScanEvent[]> {
  return rpcOk<ScanEvent[]>(client, 'app_scan_events', {
    p_session: sessionId,
    p_after: after,
  });
}

/** Ground truth straight from the tables, bypassing every read path under test. */
async function rawSession(id: string): Promise<ScanSession | null> {
  const { data, error } = await service
    .from('scan_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read scan session ${id}: ${error.message}`);
  return (data ?? null) as ScanSession | null;
}

async function rawEvents(sessionId: string): Promise<ScanEvent[]> {
  const { data, error } = await service
    .from('scan_events')
    .select('*')
    .eq('session_id', sessionId)
    .order('scanned_at', { ascending: true });
  if (error) throw new Error(`Could not read scan events: ${error.message}`);
  return (data ?? []) as ScanEvent[];
}

async function activeSessions(accountId: string): Promise<ScanSession[]> {
  const { data, error } = await service
    .from('scan_sessions')
    .select('*')
    .eq('account_id', accountId)
    .is('ended_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read sessions: ${error.message}`);
  return (data ?? []) as ScanSession[];
}

/** Ages a session past its expiry. The only way to reach that branch without waiting. */
async function expire(sessionId: string): Promise<void> {
  const { error } = await service
    .from('scan_sessions')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', sessionId);
  if (error) throw new Error(`Could not age session ${sessionId}: ${error.message}`);
}

/** A uuid that is not any session's id, used to prove the refusals are identical. */
const NO_SUCH_SESSION = '00000000-0000-4000-8000-0000000000ff';

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, helper, unrelated, pending, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('denied'),
  ]);
});

describe('starting a session', () => {
  it('opens a live session belonging to the caller, good for half an hour', async () => {
    const session = await startSession(owner, 'Serial number');

    expect(session.account_id).toBe(identity('owner').id);
    expect(session.label).toBe('Serial number');
    expect(session.ended_at).toBeNull();

    const lifetime = new Date(session.expires_at).getTime() - new Date(session.created_at).getTime();
    expect(lifetime).toBe(30 * 60 * 1000);

    const stored = await rawSession(session.id);
    expect(stored?.account_id).toBe(identity('owner').id);
  });

  it('trims the label and treats a blank one as no label at all', async () => {
    const trimmed = await startSession(owner, '   Asset tag   ');
    expect(trimmed.label).toBe('Asset tag');

    const blank = await startSession(owner, '   ');
    expect(blank.label).toBeNull();

    const absent = await rpcOk<ScanSession>(owner, 'app_start_scan_session', {});
    expect(absent.label).toBeNull();
  });

  it('refuses a label too long to render beside the QR code', async () => {
    const failure = await rpcFails(owner, 'app_start_scan_session', { p_label: 'q'.repeat(81) });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/80 characters/i);
  });

  it('refuses an account that cannot reach helpdesk records', async () => {
    const notSetUp = await rpcFails(pending, 'app_start_scan_session', { p_label: null });
    expect(notSetUp.code).toBe(REFUSED);
    expect(notSetUp.message).toMatch(/cannot access helpdesk records/i);

    const refused = await rpcFails(denied, 'app_start_scan_session', { p_label: null });
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toMatch(/cannot access helpdesk records/i);

    const anonymous = await rpcFails(anonClient(), 'app_start_scan_session', { p_label: null });
    expect(anonymous.message).toMatch(/permission denied|function|schema cache/i);
  });

  it('keeps five live sessions at most, ending the oldest rather than refusing a sixth', async () => {
    const account = identity('collaborator').id;
    expect(await activeSessions(account)).toHaveLength(0);

    const started: ScanSession[] = [];
    for (let index = 0; index < 6; index += 1) {
      started.push(await startSession(helper, `Pairing ${index + 1}`));
    }

    const live = await activeSessions(account);
    expect(live).toHaveLength(5);
    // The first one opened is the one that gave way; the other five are untouched.
    expect(live.map((row) => row.id).sort()).toEqual(
      started.slice(1).map((row) => row.id).sort(),
    );
    expect((await rawSession(started[0].id))?.ended_at).not.toBeNull();

    // And the one that gave way is genuinely closed, not merely hidden.
    const stale = await rpcFails(helper, 'app_record_scan', {
      p_session: started[0].id,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });
    expect(stale.code).toBe(REJECTED);
    expect(stale.message).toMatch(/stopped/i);
  });
});

describe('reading a session', () => {
  it('reports a live session to the account that opened it', async () => {
    const session = await startSession(owner, 'Serial number');

    const [view] = await sessionView(owner, session.id);

    expect(view.id).toBe(session.id);
    expect(view.label).toBe('Serial number');
    expect(view.ended_at).toBeNull();
    expect(view.active).toBe(true);
    // The account it belongs to is not part of the answer; the caller already is it.
    expect(Object.keys(view).sort()).toEqual([
      'active',
      'ended_at',
      'expires_at',
      'id',
      'label',
    ]);
  });

  it('turns inactive when the session is stopped, and when it simply runs out', async () => {
    const stopped = await startSession(owner, 'Stopped');
    await rpcOk(owner, 'app_end_scan_session', { p_session: stopped.id });
    const [stoppedView] = await sessionView(owner, stopped.id);
    expect(stoppedView.active).toBe(false);
    expect(stoppedView.ended_at).not.toBeNull();

    const lapsed = await startSession(owner, 'Lapsed');
    await expire(lapsed.id);
    const [lapsedView] = await sessionView(owner, lapsed.id);
    expect(lapsedView.active).toBe(false);
    // Expiry is not the same as being stopped, and the row still says so.
    expect(lapsedView.ended_at).toBeNull();
  });

  it('says nothing at all about a session belonging to somebody else', async () => {
    const session = await startSession(owner, 'Private');

    expect(await sessionView(unrelated, session.id)).toHaveLength(0);
    // Not an administrator's business either: this is one technician's phone.
    expect(await sessionView(admin, session.id)).toHaveLength(0);
    expect(await sessionView(owner, NO_SUCH_SESSION)).toHaveLength(0);
  });
});

describe('recording a scan', () => {
  it('records a code and hands it straight back to the session that owns it', async () => {
    const session = await startSession(owner, 'Serial number');

    const eventId = await recordScan(owner, session.id, 'DOE-LN1221779', 'code_128');

    const [stored] = await rawEvents(session.id);
    expect(stored.id).toBe(eventId);
    expect(stored.code).toBe('DOE-LN1221779');
    expect(stored.format).toBe('code_128');

    const read = await scanEvents(owner, session.id);
    expect(read.map((event) => event.code)).toEqual(['DOE-LN1221779']);
  });

  it('trims the code, drops a blank format, and cuts an absurd code down to size', async () => {
    const session = await startSession(owner, 'Trimming');

    await recordScan(owner, session.id, '   PW0FYJ9B-WIN   ', '   ');
    await recordScan(owner, session.id, 'x'.repeat(250), null);

    const stored = await rawEvents(session.id);
    expect(stored[0].code).toBe('PW0FYJ9B-WIN');
    expect(stored[0].format).toBeNull();
    expect(stored[1].code).toHaveLength(200);
  });

  it('refuses a code that is nothing but whitespace', async () => {
    const session = await startSession(owner, 'Empty');

    const failure = await rpcFails(owner, 'app_record_scan', {
      p_session: session.id,
      p_code: '   ',
      p_format: null,
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/scan a code/i);
    expect(await rawEvents(session.id)).toHaveLength(0);
  });

  it('refuses a session that has been stopped, and says how to get going again', async () => {
    const session = await startSession(owner, 'Stopped');
    await rpcOk(owner, 'app_end_scan_session', { p_session: session.id });

    const failure = await rpcFails(owner, 'app_record_scan', {
      p_session: session.id,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/stopped/i);
    expect(failure.message).toMatch(/start a new one/i);
    expect(await rawEvents(session.id)).toHaveLength(0);
  });

  it('refuses a session that has run out', async () => {
    const session = await startSession(owner, 'Lapsed');
    await expire(session.id);

    const failure = await rpcFails(owner, 'app_record_scan', {
      p_session: session.id,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/expired|run out/i);
    expect(failure.message).toMatch(/start a new one/i);
  });

  it("tells a technician holding somebody else's session id exactly what it tells a stranger", async () => {
    const session = await startSession(owner, 'Private');

    const foreign = await rpcFails(unrelated, 'app_record_scan', {
      p_session: session.id,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });
    const nonexistent = await rpcFails(unrelated, 'app_record_scan', {
      p_session: NO_SUCH_SESSION,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });

    expect(foreign.code).toBe(MISSING);
    expect(foreign.message).toBe(UNAVAILABLE);
    // Word for word the same, so holding a real id tells the caller nothing.
    expect(nonexistent.message).toBe(foreign.message);
    expect(nonexistent.code).toBe(foreign.code);

    // An administrator is no more entitled to it than anyone else.
    const asAdmin = await rpcFails(admin, 'app_record_scan', {
      p_session: session.id,
      p_code: 'DOE-LN1221779',
      p_format: null,
    });
    expect(asAdmin.message).toBe(UNAVAILABLE);

    expect(await rawEvents(session.id)).toHaveLength(0);
  });
});

describe('reading the scans', () => {
  it('returns them oldest first, and only the ones after a given instant', async () => {
    const session = await startSession(owner, 'Paging');
    await recordScan(owner, session.id, 'FIRST-CODE', 'code_39');
    const [first] = await rawEvents(session.id);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await recordScan(owner, session.id, 'SECOND-CODE', 'code_39');
    await recordScan(owner, session.id, 'THIRD-CODE', 'code_39');

    const all = await scanEvents(owner, session.id);
    expect(all.map((event) => event.code)).toEqual(['FIRST-CODE', 'SECOND-CODE', 'THIRD-CODE']);

    const since = await scanEvents(owner, session.id, first.scanned_at);
    expect(since.map((event) => event.code)).toEqual(['SECOND-CODE', 'THIRD-CODE']);
  });

  it('keeps reading a session that has been stopped, so the last code is not lost', async () => {
    const session = await startSession(owner, 'Stopped but readable');
    await recordScan(owner, session.id, 'LAST-CODE', null);
    await rpcOk(owner, 'app_end_scan_session', { p_session: session.id });

    expect((await scanEvents(owner, session.id)).map((event) => event.code)).toEqual(['LAST-CODE']);
  });

  it('shows nothing to anybody else, through the RPC or straight from the table', async () => {
    const session = await startSession(owner, 'Private');
    await recordScan(owner, session.id, 'DOE-LN1221779', null);

    expect(await scanEvents(unrelated, session.id)).toHaveLength(0);
    expect(await scanEvents(admin, session.id)).toHaveLength(0);
    expect(await scanEvents(pending, session.id)).toHaveLength(0);

    const direct = await unrelated.from('scan_events').select('id').eq('session_id', session.id);
    expect(direct.data ?? []).toHaveLength(0);

    const sessions = await unrelated.from('scan_sessions').select('id').eq('id', session.id);
    expect(sessions.data ?? []).toHaveLength(0);
  });
});

describe('ending a session', () => {
  it('stops the session and can be asked twice without complaining', async () => {
    const session = await startSession(owner, 'Ending');

    await rpcOk(owner, 'app_end_scan_session', { p_session: session.id });
    const ended = await rawSession(session.id);
    expect(ended?.ended_at).not.toBeNull();

    // The phone and the desktop can both press Stop; the second one is not an error.
    await rpcOk(owner, 'app_end_scan_session', { p_session: session.id });
    expect((await rawSession(session.id))?.ended_at).toBe(ended?.ended_at);
  });

  it("refuses somebody else's session with the same words as a missing one", async () => {
    const session = await startSession(owner, 'Private');

    const foreign = await rpcFails(unrelated, 'app_end_scan_session', { p_session: session.id });
    const nonexistent = await rpcFails(unrelated, 'app_end_scan_session', {
      p_session: NO_SUCH_SESSION,
    });

    expect(foreign.code).toBe(MISSING);
    expect(foreign.message).toBe(UNAVAILABLE);
    expect(nonexistent.message).toBe(foreign.message);
    expect((await rawSession(session.id))?.ended_at).toBeNull();
  });
});

describe('the relay is not writable from a session', () => {
  it('refuses INSERT, UPDATE and DELETE straight to either table, even for an admin', async () => {
    const session = await startSession(owner, 'Read only');
    await recordScan(owner, session.id, 'DOE-LN1221779', null);
    const [event] = await rawEvents(session.id);

    const forgedSession = await admin
      .from('scan_sessions')
      .insert({ account_id: identity('owner').id, label: 'Forged' });
    expect(forgedSession.error?.message).toMatch(/permission denied|violates row-level security/i);

    const forgedEvent = await owner
      .from('scan_events')
      .insert({ session_id: session.id, code: 'FORGED' });
    expect(forgedEvent.error?.message).toMatch(/permission denied|violates row-level security/i);

    const rewrite = await owner
      .from('scan_events')
      .update({ code: 'REWRITTEN' })
      .eq('id', event.id);
    expect(rewrite.error?.message).toMatch(/permission denied/i);

    const stop = await owner
      .from('scan_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', session.id);
    expect(stop.error?.message).toMatch(/permission denied/i);

    const erase = await owner.from('scan_events').delete().eq('id', event.id);
    expect(erase.error?.message).toMatch(/permission denied/i);

    expect((await rawEvents(session.id))[0].code).toBe('DOE-LN1221779');
    expect((await rawSession(session.id))?.ended_at).toBeNull();
  });

  it('shows an anonymous caller nothing', async () => {
    const sessions = await anonClient().from('scan_sessions').select('id');
    expect(sessions.error?.message).toMatch(/permission denied/i);

    const events = await anonClient().from('scan_events').select('id');
    expect(events.error?.message).toMatch(/permission denied/i);
  });
});

/**
 * Hardening round. None of these are new behaviour the feature needs; they are
 * the bounds and the housekeeping a channel published to Realtime has to have
 * before it is left running unattended.
 */

/** Ages a session two days, past the sweeper's day of grace. */
async function makeStale(sessionId: string, ended: boolean): Promise<void> {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await service
    .from('scan_sessions')
    .update({ expires_at: twoDaysAgo, ended_at: ended ? twoDaysAgo : null })
    .eq('id', sessionId);
  if (error) throw new Error(`Could not age session ${sessionId}: ${error.message}`);
}

describe('a session fills up', () => {
  it('takes the five hundredth scan and refuses the five hundred and first', async () => {
    const session = await startSession(owner, 'Filling up');

    // 499 through the service role in one statement, which is arrangement: there
    // is no insert grant for a session, so app_record_scan is still the only way
    // a technician's row ever appears.
    const filler = await service.from('scan_events').insert(
      Array.from({ length: 499 }, (_, index) => ({
        session_id: session.id,
        code: `FILL-${String(index + 1).padStart(4, '0')}`,
        format: 'code_128',
      })),
    );
    expect(filler.error).toBeNull();

    const lastAccepted = await recordScan(owner, session.id, 'THE-FIVE-HUNDREDTH');
    expect(lastAccepted).toBeTruthy();
    expect(await rawEvents(session.id)).toHaveLength(500);

    const overflow = await rpcFails(owner, 'app_record_scan', {
      p_session: session.id,
      p_code: 'ONE-TOO-MANY',
      p_format: null,
    });
    expect(overflow.code).toBe(REJECTED);
    expect(overflow.message).toBe('This scanner session is full. Stop it and start a new one.');
    expect(await rawEvents(session.id)).toHaveLength(500);
  });

  it('still hands back every scan it holds, because the read limit is the same number', async () => {
    const session = await startSession(owner, 'Reading a full session');
    // Explicit, increasing instants: one INSERT statement gives every row the
    // same transaction timestamp, and the order would then fall to the uuid
    // tiebreak — which is exactly what this test is checking is not happening.
    const base = Date.now() - 600_000;
    const filler = await service.from('scan_events').insert(
      Array.from({ length: 500 }, (_, index) => ({
        session_id: session.id,
        code: `FULL-${String(index + 1).padStart(4, '0')}`,
        format: null,
        scanned_at: new Date(base + index).toISOString(),
      })),
    );
    expect(filler.error).toBeNull();

    // 500 stored, 500 returned: app_scan_events cannot silently drop a scan a
    // session was allowed to accept.
    const read = await scanEvents(owner, session.id);
    expect(read).toHaveLength(500);
    expect(read[0].code).toBe('FULL-0001');
    expect(read[499].code).toBe('FULL-0500');
  });
});

describe('clearing out finished sessions', () => {
  it('removes what has been finished for over a day and nothing else', async () => {
    const live = await startSession(owner, 'Still going');
    const justStopped = await startSession(owner, 'Stopped a moment ago');
    await rpcOk(owner, 'app_end_scan_session', { p_session: justStopped.id });
    const justLapsed = await startSession(owner, 'Lapsed a moment ago');
    await expire(justLapsed.id);

    const longStopped = await startSession(owner, 'Stopped days ago');
    await recordScan(owner, longStopped.id, 'DOE-LN1221779');
    await makeStale(longStopped.id, true);
    const longLapsed = await startSession(owner, 'Lapsed days ago');
    await makeStale(longLapsed.id, false);

    const removed = await rpcOk<number>(admin, 'app_sweep_scan_sessions');
    expect(removed).toBe(2);

    expect(await rawSession(longStopped.id)).toBeNull();
    expect(await rawSession(longLapsed.id)).toBeNull();
    // The scans went with the session they belonged to.
    expect(await rawEvents(longStopped.id)).toHaveLength(0);

    // A day of grace, so this morning's work is still there this afternoon.
    expect(await rawSession(live.id)).not.toBeNull();
    expect(await rawSession(justStopped.id)).not.toBeNull();
    expect(await rawSession(justLapsed.id)).not.toBeNull();
  });

  it('is open to the service role, for the scheduled job it exists for', async () => {
    const stale = await startSession(owner, 'Swept by the job');
    await makeStale(stale.id, false);

    const removed = await rpcOk<number>(service, 'app_sweep_scan_sessions');

    expect(removed).toBe(1);
    expect(await rawSession(stale.id)).toBeNull();
  });

  it('refuses a technician, an account awaiting setup, and an anonymous caller', async () => {
    const stale = await startSession(owner, 'Not yours to sweep');
    await makeStale(stale.id, false);

    const technician = await rpcFails(owner, 'app_sweep_scan_sessions');
    expect(technician.code).toBe(REFUSED);
    expect(technician.message).toMatch(/only an administrator/i);

    const notSetUp = await rpcFails(pending, 'app_sweep_scan_sessions');
    expect(notSetUp.code).toBe(REFUSED);
    expect(notSetUp.message).toMatch(/cannot access helpdesk records/i);

    const anonymous = await rpcFails(anonClient(), 'app_sweep_scan_sessions');
    expect(anonymous.message).toMatch(/permission denied|function|schema cache/i);

    // Nothing was swept by any of them.
    expect(await rawSession(stale.id)).not.toBeNull();
    await rpcOk<number>(admin, 'app_sweep_scan_sessions');
  });
});

describe('restricted and anonymous callers reach nothing', () => {
  it('closes every scanner function to an anonymous caller', async () => {
    const anon = anonClient();
    for (const [fn, args] of [
      ['app_scan_session', { p_session: NO_SUCH_SESSION }],
      ['app_scan_events', { p_session: NO_SUCH_SESSION, p_after: null }],
      ['app_record_scan', { p_session: NO_SUCH_SESSION, p_code: 'X', p_format: null }],
      ['app_end_scan_session', { p_session: NO_SUCH_SESSION }],
      ['app_start_scan_session', { p_label: null }],
    ] as Array<[string, Record<string, unknown>]>) {
      const failure = await rpcFails(anon, fn, args);
      expect(failure.message, fn).toMatch(/permission denied|function|schema cache/i);
    }
  });

  it('shows a denied account nothing and lets it record nothing', async () => {
    const session = await startSession(owner, 'Private');
    await recordScan(owner, session.id, 'DOE-LN1221779');

    // The reads run under the caller's own privileges, so a denied account is not
    // refused — it simply matches no rows, which is the same answer it would get
    // for an id that does not exist.
    expect(await sessionView(denied, session.id)).toHaveLength(0);
    expect(await scanEvents(denied, session.id)).toHaveLength(0);

    // The write re-derives the actor and refuses outright.
    const write = await rpcFails(denied, 'app_record_scan', {
      p_session: session.id,
      p_code: 'FORGED',
      p_format: null,
    });
    expect(write.code).toBe(REFUSED);
    expect(write.message).toMatch(/cannot access helpdesk records/i);

    expect(await rawEvents(session.id)).toHaveLength(1);
  });
});

describe('stopping a session that already ran out', () => {
  it('succeeds, so the desktop can tidy up after a pairing nobody closed', async () => {
    const session = await startSession(owner, 'Lapsed then stopped');
    await expire(session.id);

    await rpcOk(owner, 'app_end_scan_session', { p_session: session.id });

    const stored = await rawSession(session.id);
    expect(stored?.ended_at).not.toBeNull();
    const [view] = await sessionView(owner, session.id);
    expect(view.active).toBe(false);
  });
});
