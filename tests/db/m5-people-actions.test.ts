/**
 * Getting people out of the directory: the preference, the read and the record.
 *
 * `20260916130000_m5_people_actions.sql` adds one column, one read and one
 * writer, and each of the three is load-bearing in a different way:
 *
 * 1. `gmail_mode` IS AN ORDINARY PREFERENCE. It goes through the same patch
 *    every other setting does, so what it has to prove is that the seventh key
 *    behaves like the other six: it round-trips, it is private, a value outside
 *    its two words is refused by name, and a save of it leaves the rest alone.
 * 2. `app_people_addressees` IS A BULK READ OF REAL PEOPLE. So the two things
 *    that matter are the CAP — five hundred, stated in the envelope, with the
 *    filter's true total beside it — and the GATE, which is the same
 *    active-account gate every directory read stands behind.
 * 3. `app_log_people_export` IS THE ONLY DOOR TO AN EXPORT. It refuses anybody
 *    who is not an administrator or a skills officer, and what it records is
 *    the count and the list, never a name, an address or a phone number. An
 *    export that cannot be recorded does not happen, so this function refusing
 *    is what stops the file.
 *
 * Exercised through real signed-in sessions, because every gate here is derived
 * inside the function body from the caller's own session. Every person seeded
 * below is invented and every address is on edison.example.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  seedRequester,
  signIn,
} from './support/harness';

interface Preferences {
  account_id: string;
  gmail_mode: string;
  theme: string;
  assistant_notes: string;
}

interface Addressee {
  id: string;
  kind: string;
  displayName: string;
  email: string;
  externalId: string;
  officialClass: string;
  department: string;
  guardianName: string;
  guardianPhone: string;
}

interface AddresseePage {
  rows: Addressee[];
  total: number;
  cap: number;
  capped: boolean;
}

interface AuditRow {
  kind: string;
  summary: string;
  detail: string | null;
  entity_type: string;
  actor_id: string;
  actor_name: string;
  performed_via: string;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

/** A token nothing else in the directory carries, so a search finds only these. */
const CROWD = 'zzcrowdtoken';
const CROWD_SIZE = 505;

async function preferences(client: SupabaseClient): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_my_preferences');
}

async function addressees(
  client: SupabaseClient,
  args: Record<string, unknown>,
): Promise<AddresseePage> {
  return rpcOk<AddresseePage>(client, 'app_people_addressees', args);
}

/**
 * More students than the cap, in one insert.
 *
 * Arranged with the service role rather than through app_save_person, for the
 * reason every fixture in this suite is: a fixture is setup, not the thing
 * under test, and five hundred round trips through a writer would be testing
 * the writer.
 */
async function seedCrowd(): Promise<void> {
  const rows = Array.from({ length: CROWD_SIZE }, (_, at) => {
    const serial = String(at).padStart(4, '0');
    return {
      display_name: `${CROWD} Student ${serial}`,
      kind: 'student',
      external_id: `7700${serial}`,
      source_external_id: `7700${serial}`,
      email: at % 5 === 0 ? null : `${CROWD}${serial}@edison.example`,
      official_class: '9A',
      guardian_name: `${CROWD} Guardian ${serial}`,
      guardian_phone: at % 3 === 0 ? null : `555 ${serial}`,
      created_by: identity('admin').id,
    };
  });

  const { error } = await adminServiceClient().from('requesters').insert(rows);
  if (error) throw new Error(`Could not seed the crowd: ${error.message}`);
}

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('collaborator');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
  await seedCrowd();
});

describe('the Gmail mode preference', () => {
  it('starts as CC, which is what a chapter mailing is', async () => {
    const mine = await preferences(officer);
    expect(mine.gmail_mode).toBe('cc');
  });

  it('round-trips, and takes the word however it was capitalised', async () => {
    const saved = await rpcOk<Preferences>(officer, 'app_update_preferences', {
      p_patch: { gmail_mode: 'bcc' },
    });
    expect(saved.gmail_mode).toBe('bcc');
    expect((await preferences(officer)).gmail_mode).toBe('bcc');

    const shouted = await rpcOk<Preferences>(officer, 'app_update_preferences', {
      p_patch: { gmail_mode: '  CC  ' },
    });
    expect(shouted.gmail_mode).toBe('cc');
  });

  it('refuses a third answer by name, and changes nothing when it does', async () => {
    await rpcOk(officer, 'app_update_preferences', { p_patch: { gmail_mode: 'bcc' } });

    for (const wrong of ['to', '', 'Bcc mode']) {
      const refused = await rpcFails(officer, 'app_update_preferences', {
        p_patch: { gmail_mode: wrong },
      });
      expect(refused.message).toContain('Choose cc or bcc for a Gmail link.');
    }

    expect((await preferences(officer)).gmail_mode).toBe('bcc');
  });

  it('leaves the settings beside it alone', async () => {
    await rpcOk(officer, 'app_update_preferences', {
      p_patch: { theme: 'light', assistant_notes: 'The directory is what I work.' },
    });
    const after = await rpcOk<Preferences>(officer, 'app_update_preferences', {
      p_patch: { gmail_mode: 'cc' },
    });
    expect(after.theme).toBe('light');
    expect(after.assistant_notes).toBe('The directory is what I work.');
  });

  it('is nobody else’s to read', async () => {
    await rpcOk(officer, 'app_update_preferences', { p_patch: { gmail_mode: 'bcc' } });
    await rpcOk(netrider, 'app_update_preferences', { p_patch: { gmail_mode: 'cc' } });

    expect((await preferences(officer)).gmail_mode).toBe('bcc');
    expect((await preferences(netrider)).gmail_mode).toBe('cc');
  });

  it('is closed to an account that is not active', async () => {
    const refused = await rpcFails(inactive, 'app_update_preferences', {
      p_patch: { gmail_mode: 'bcc' },
    });
    expect(refused.message).toContain('cannot access helpdesk records');
  });

  it('cannot be written around the function', async () => {
    const written = await officer
      .from('account_preferences')
      .update({ gmail_mode: 'to' })
      .eq('account_id', identity('skillsOfficer').id);
    expect(written.error).not.toBeNull();
  });
});

describe('the addressee read', () => {
  it('answers the same filter the list ran, with only the fields a mailing needs', async () => {
    const person = await seedRequester('student', {
      display_name: 'Addressee Probe Okonkwo',
      email: 'probe.okonkwo@edison.example',
      official_class: '11B',
      guardian_name: 'Adaeze Okonkwo',
      guardian_phone: '555 0100',
      notes: 'A note that must not travel with a mailing.',
      address: '1 Example Road',
      home_phone: '555 0111',
    });

    const page = await addressees(officer, { p_kind: 'student', p_query: 'Addressee Probe' });
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);

    const row = page.rows[0];
    expect(row.id).toBe(person.id);
    expect(row.displayName).toBe('Addressee Probe Okonkwo');
    expect(row.email).toBe('probe.okonkwo@edison.example');
    expect(row.officialClass).toBe('11B');
    expect(row.guardianName).toBe('Adaeze Okonkwo');
    expect(row.guardianPhone).toBe('555 0100');

    // The narrow shape is the point: notes, home address and home phone stay on
    // the person's own page, where one person's record is opened one at a time.
    expect(Object.keys(row).sort()).toEqual([
      'department',
      'displayName',
      'email',
      'externalId',
      'guardianName',
      'guardianPhone',
      'id',
      'kind',
      'officialClass',
    ]);
  });

  it('is two lists, and a staff search never answers with a student', async () => {
    const crowd = await addressees(officer, { p_kind: 'staff', p_query: CROWD });
    expect(crowd.total).toBe(0);
    expect(crowd.rows).toEqual([]);
  });

  it('caps at five hundred and says what the filter really holds', async () => {
    const page = await addressees(officer, { p_kind: 'student', p_query: CROWD });
    expect(page.cap).toBe(500);
    expect(page.rows).toHaveLength(500);
    expect(page.total).toBe(CROWD_SIZE);
    expect(page.capped).toBe(true);
    // Ordered by name, like the list, so the five hundred are the first five
    // hundred of the roster rather than an arbitrary five hundred.
    expect(page.rows[0].displayName).toBe(`${CROWD} Student 0000`);
  });

  it('says plainly when a filter was not cut', async () => {
    const page = await addressees(officer, { p_kind: 'student', p_query: `${CROWD} Student 0001` });
    expect(page.capped).toBe(false);
    expect(page.total).toBe(1);
  });

  it('narrows to a selection, and the list still decides which list', async () => {
    const page = await addressees(officer, { p_kind: 'student', p_query: CROWD });
    const three = page.rows.slice(0, 3).map((row) => row.id);

    const picked = await addressees(officer, { p_kind: 'student', p_ids: three });
    expect(picked.total).toBe(3);
    expect(picked.rows.map((row) => row.id).sort()).toEqual([...three].sort());

    // The same ids asked for as staff are nobody: a selection is made inside one
    // of the two lists and cannot be carried into the other.
    const wrongList = await addressees(officer, { p_kind: 'staff', p_ids: three });
    expect(wrongList.total).toBe(0);
  });

  it('is open to every role that may read the roster', async () => {
    for (const reader of [admin, netrider, officer]) {
      const page = await addressees(reader, { p_kind: 'student', p_query: CROWD });
      expect(page.total).toBe(CROWD_SIZE);
    }
  });

  it('refuses a list that is not one of the two', async () => {
    const refused = await rpcFails(officer, 'app_people_addressees', { p_kind: 'everybody' });
    expect(refused.message).toContain('Choose students or staff.');
  });

  it('is closed to an account that is not active, and to one that never signed in', async () => {
    const refused = await rpcFails(inactive, 'app_people_addressees', { p_kind: 'student' });
    expect(refused.message).toContain('cannot access helpdesk records');

    const anon = anonClient();
    expect((await rpcFails(anon, 'app_people_addressees', { p_kind: 'student' })).message).not.toBe(
      '',
    );
  });
});

describe('recording an export', () => {
  async function exportLog(): Promise<AuditRow[]> {
    return rpcOk<AuditRow[]>(admin, 'app_audit_log', { p_kind: 'people_export', p_limit: 50 });
  }

  it('is written by a skills officer, with the count and the list', async () => {
    await rpcOk(officer, 'app_log_people_export', { p_kind: 'student', p_count: 312 });

    const log = await exportLog();
    expect(log.length).toBeGreaterThan(0);
    const latest = log[0];
    expect(latest.entity_type).toBe('account');
    expect(latest.summary).toBe('Exported 312 student records from the directory.');
    expect(latest.actor_id).toBe(identity('skillsOfficer').id);
    expect(latest.actor_name).toBe(identity('skillsOfficer').displayName);
    expect(latest.performed_via).toBe('user');
  });

  it('records nothing about who was in the file', async () => {
    await rpcOk(officer, 'app_log_people_export', { p_kind: 'student', p_count: CROWD_SIZE });

    const [latest] = await exportLog();
    // record_events is append-only and every administrator reads it, so the one
    // thing the entry must never hold is a second copy of the export.
    expect(latest.summary).not.toContain(CROWD);
    expect(latest.summary).not.toContain('@edison.example');
    expect(latest.detail ?? '').toBe('');
  });

  it('names the list it was, so two exports are told apart', async () => {
    await rpcOk(admin, 'app_log_people_export', { p_kind: 'staff', p_count: 261 });
    const [latest] = await exportLog();
    expect(latest.summary).toBe('Exported 261 staff records from the directory.');
    expect(latest.actor_id).toBe(identity('admin').id);
  });

  it('refuses a NetRider, who reads the roster but does not carry it away', async () => {
    const refused = await rpcFails(netrider, 'app_log_people_export', {
      p_kind: 'student',
      p_count: 40,
    });
    expect(refused.message).toContain(
      'Only an administrator or a skills officer can export the directory.',
    );

    // And the refusal really is a refusal: nothing was recorded on their behalf.
    const log = await exportLog();
    expect(log.some((row) => row.actor_id === identity('collaborator').id)).toBe(false);
  });

  it('refuses an account that is not active, and one that never signed in', async () => {
    const refused = await rpcFails(inactive, 'app_log_people_export', {
      p_kind: 'student',
      p_count: 1,
    });
    expect(refused.message).toContain('cannot access helpdesk records');

    const anon = anonClient();
    expect(
      (await rpcFails(anon, 'app_log_people_export', { p_kind: 'student', p_count: 1 })).message,
    ).not.toBe('');
  });

  it('refuses a list that is not one of the two', async () => {
    const refused = await rpcFails(officer, 'app_log_people_export', {
      p_kind: 'everybody',
      p_count: 1,
    });
    expect(refused.message).toContain('Choose students or staff.');
  });

  it('cannot be reached around, because the history writer is nobody’s to call', async () => {
    const refused = await rpcFails(officer, 'app_log_record_event', {
      p_entity_type: 'account',
      p_entity_id: identity('skillsOfficer').id,
      p_kind: 'people_export',
      p_actor: identity('skillsOfficer').id,
      p_summary: 'Exported 0 student records from the directory.',
    });
    expect(refused.message).not.toBe('');

    const written = await officer.from('record_events').insert({
      entity_type: 'account',
      entity_id: identity('skillsOfficer').id,
      kind: 'people_export',
      summary: 'Straight in.',
    });
    expect(written.error).not.toBeNull();
  });
});
