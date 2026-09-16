/**
 * Notes for the assistant: one note per person, and one for the whole school.
 *
 * `20260916100000_m5_assistant_notes.sql` adds a column to the row an account
 * already has, and a one-row table that everybody shares. The second is the
 * unusual one in this schema, and four things about it are load-bearing:
 *
 * 1. EVERY ACTIVE ACCOUNT MAY EDIT IT. Not administrators. The rules of the
 *    house are written by whoever is at the desk when they change, so an
 *    administrator, a NetRider and a skills officer all get the same answer.
 * 2. NOBODY ELSE MAY. An inactive account cannot read it and cannot write it,
 *    and neither can a session that never signed in.
 * 3. THE FUNCTION IS THE ONLY DOOR. The table is readable and nothing more, so
 *    the cap, the attribution and the history entry cannot be walked around by
 *    writing the row directly.
 * 4. AN EDIT IS RECORDED. It is a change to something shared, so it belongs in
 *    the audit log beside every other change somebody made.
 *
 * The personal note is the ordinary preferences path and is tested as one: it
 * round-trips, it is private, and it is cut rather than refused.
 *
 * Exercised through real signed-in sessions, because every gate here is derived
 * inside the function body from the caller's own session.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, identity, rpcFails, rpcOk, signIn } from './support/harness';

interface SharedNotes {
  body: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string;
}

interface SharedRow {
  id: number;
  body: string;
  updated_by: string | null;
  updated_at: string;
}

interface Preferences {
  account_id: string;
  assistant_notes: string;
  theme: string;
}

interface AuditRow {
  kind: string;
  summary: string;
  entity_type: string;
  actor_id: string;
  actor_name: string;
  performed_via: string;
}

let admin: SupabaseClient;
let worker: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

async function readShared(client: SupabaseClient): Promise<SharedNotes[]> {
  return rpcOk<SharedNotes[]>(client, 'app_assistant_notes_shared');
}

async function writeShared(client: SupabaseClient, body: string): Promise<SharedRow> {
  return rpcOk<SharedRow>(client, 'app_set_assistant_notes_shared', { p_body: body });
}

async function preferences(client: SupabaseClient): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_my_preferences');
}

beforeAll(async () => {
  admin = await signIn('admin');
  worker = await signIn('collaborator');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('the school’s shared notes', () => {
  it('starts as one empty row that nobody has edited', async () => {
    const [note] = await readShared(worker);
    expect(note).toBeDefined();
    expect(note.body).toBe('');
    expect(note.updated_by).toBeNull();
    expect(note.updated_by_name).toBeNull();
  });

  it('is written by a NetRider and read by everybody else', async () => {
    const written = await writeShared(worker, 'The desk is in 118. The annex is across the car park.');
    expect(written.body).toBe('The desk is in 118. The annex is across the car park.');
    expect(written.updated_by).toBe(identity('collaborator').id);

    for (const reader of [admin, worker, officer]) {
      const [note] = await readShared(reader);
      expect(note.body).toBe('The desk is in 118. The annex is across the car park.');
      // Who last edited it, by name, to a reader who cannot read that account
      // row for themselves.
      expect(note.updated_by_name).toBe(identity('collaborator').displayName);
    }
  });

  it('is edited by a skills officer and by an administrator just the same', async () => {
    const byOfficer = await writeShared(officer, 'Chromebook carts live in 118 and 204.');
    expect(byOfficer.updated_by).toBe(identity('skillsOfficer').id);

    const byAdmin = await writeShared(admin, 'Carts live in 118 and 204. Loans are signed out.');
    expect(byAdmin.updated_by).toBe(identity('admin').id);

    const [note] = await readShared(officer);
    expect(note.body).toBe('Carts live in 118 and 204. Loans are signed out.');
    expect(note.updated_by_name).toBe(identity('admin').displayName);
  });

  it('trims what it is given and cuts it at 600 rather than refusing', async () => {
    const padded = await writeShared(worker, '   Room 118 is the desk.   ');
    expect(padded.body).toBe('Room 118 is the desk.');

    const long = 'x'.repeat(900);
    const cut = await writeShared(worker, long);
    expect(cut.body).toHaveLength(600);
    expect(long.startsWith(cut.body)).toBe(true);
  });

  it('records one entry in the audit log, naming who changed it', async () => {
    await writeShared(officer, 'The printer in the library is out of service.');

    const log = await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
      p_kind: 'assistant_notes_shared',
      p_limit: 50,
    });

    expect(log.length).toBeGreaterThan(0);
    const latest = log[0];
    expect(latest.entity_type).toBe('account');
    expect(latest.summary).toBe('Shared notes for the assistant edited.');
    expect(latest.actor_id).toBe(identity('skillsOfficer').id);
    expect(latest.actor_name).toBe(identity('skillsOfficer').displayName);
    expect(latest.performed_via).toBe('user');
  });

  it('records a clearing as a clearing', async () => {
    await writeShared(worker, '   ');
    const [note] = await readShared(worker);
    expect(note.body).toBe('');

    const log = await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
      p_kind: 'assistant_notes_shared',
      p_limit: 50,
    });
    expect(log[0].summary).toBe('Shared notes for the assistant cleared.');
  });

  it('writes nothing when the note that is saved is the one already there', async () => {
    await writeShared(admin, 'Loans are signed out at the desk.');
    const before = await readShared(admin);
    const countBefore = (
      await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
        p_kind: 'assistant_notes_shared',
        p_limit: 200,
      })
    ).length;

    // Saved again by somebody else: neither the attribution nor the history
    // should move, because nothing changed.
    await writeShared(worker, 'Loans are signed out at the desk.');

    const after = await readShared(admin);
    expect(after[0].updated_at).toBe(before[0].updated_at);
    expect(after[0].updated_by).toBe(identity('admin').id);

    const countAfter = (
      await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
        p_kind: 'assistant_notes_shared',
        p_limit: 200,
      })
    ).length;
    expect(countAfter).toBe(countBefore);
  });

  it('is closed to an account that is not active', async () => {
    // The read answers nothing at all: they are not told the question has an
    // answer, which is what app_my_ai_connection() does too.
    const notes = await readShared(inactive);
    expect(notes).toEqual([]);

    const refused = await rpcFails(inactive, 'app_set_assistant_notes_shared', {
      p_body: 'Let me in.',
    });
    expect(refused.message).toContain('cannot access helpdesk records');
  });

  it('is closed to a session that never signed in', async () => {
    const anon = anonClient();
    // anon has EXECUTE on neither function, so it is refused before either body
    // runs rather than answered with nothing.
    expect((await rpcFails(anon, 'app_assistant_notes_shared')).message).not.toBe('');
    expect(
      (await rpcFails(anon, 'app_set_assistant_notes_shared', { p_body: 'Let me in.' })).message,
    ).not.toBe('');

    const read = await anon.from('assistant_notes_shared').select('id');
    expect(read.error).not.toBeNull();
  });

  it('is readable as a row but not writable as one', async () => {
    const read = await worker.from('assistant_notes_shared').select('id, body').eq('id', 1);
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(1);

    // The function is the one door. A direct write has no grant behind it, so
    // the cap, the attribution and the history entry cannot be walked around.
    const written = await worker
      .from('assistant_notes_shared')
      .update({ body: 'Straight in.' })
      .eq('id', 1);
    expect(written.error).not.toBeNull();

    const inserted = await worker.from('assistant_notes_shared').insert({ id: 1, body: 'Two.' });
    expect(inserted.error).not.toBeNull();

    const deleted = await worker.from('assistant_notes_shared').delete().eq('id', 1);
    expect(deleted.error).not.toBeNull();

    // And an inactive account sees no row at all, grant or no grant.
    const hidden = await inactive.from('assistant_notes_shared').select('id');
    expect(hidden.error).toBeNull();
    expect(hidden.data).toHaveLength(0);
  });
});

describe('a person’s own notes', () => {
  it('round-trips through app_update_preferences, trimmed', async () => {
    const saved = await rpcOk<Preferences>(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: '  I work Tuesdays and Thursdays.  ' },
    });
    expect(saved.assistant_notes).toBe('I work Tuesdays and Thursdays.');

    const read = await preferences(worker);
    expect(read.assistant_notes).toBe('I work Tuesdays and Thursdays.');
  });

  it('is nobody else’s to read', async () => {
    await rpcOk(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: 'Mine, and only mine.' },
    });
    await rpcOk(officer, 'app_update_preferences', {
      p_patch: { assistant_notes: 'The directory is what I work.' },
    });

    const mine = await preferences(worker);
    const theirs = await preferences(officer);
    expect(mine.assistant_notes).toBe('Mine, and only mine.');
    expect(theirs.assistant_notes).toBe('The directory is what I work.');
    expect(mine.account_id).not.toBe(theirs.account_id);
  });

  it('is cut at 600 rather than refused', async () => {
    const long = 'y'.repeat(900);
    const saved = await rpcOk<Preferences>(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: long },
    });
    expect(saved.assistant_notes).toHaveLength(600);
  });

  it('is cleared by an empty note and by a null', async () => {
    const emptied = await rpcOk<Preferences>(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: '   ' },
    });
    expect(emptied.assistant_notes).toBe('');

    await rpcOk(worker, 'app_update_preferences', { p_patch: { assistant_notes: 'Back again.' } });
    const nulled = await rpcOk<Preferences>(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: null },
    });
    expect(nulled.assistant_notes).toBe('');
  });

  it('refuses a note that is not text, and changes nothing when it does', async () => {
    await rpcOk(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: 'Tuesdays and Thursdays.' },
    });

    const refused = await rpcFails(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: { a: 1 } },
    });
    expect(refused.message).toContain('as text');

    const read = await preferences(worker);
    expect(read.assistant_notes).toBe('Tuesdays and Thursdays.');
  });

  it('leaves the settings beside it alone', async () => {
    const before = await preferences(worker);
    const after = await rpcOk<Preferences>(worker, 'app_update_preferences', {
      p_patch: { assistant_notes: 'One line about how I work.' },
    });
    expect(after.theme).toBe(before.theme);
  });

  it('is closed to an account that is not active', async () => {
    const refused = await rpcFails(inactive, 'app_update_preferences', {
      p_patch: { assistant_notes: 'Let me in.' },
    });
    expect(refused.message).toContain('cannot access helpdesk records');
  });
});
