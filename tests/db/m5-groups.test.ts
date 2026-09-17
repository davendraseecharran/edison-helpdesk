/**
 * Groups: the rosters, and who may do what to them.
 *
 * Four rules carry the whole feature, and each of them is a decision that
 * would be wrong in a way nobody would notice for a term:
 *
 * 1. EVERY ACTIVE ACCOUNT KEEPS A ROSTER. A skills officer with a chapter to
 *    run is the person most likely to keep one, and a NetRider at the desk is
 *    the person most likely to be asked to add somebody to it. Neither has to
 *    find an administrator, and the database is what says so.
 * 2. ONLY AN ADMINISTRATOR DELETES ONE. It is the one act here that destroys
 *    work: the members go with the row.
 * 3. THE COUNT IS THE TRUTH. `app_add_group_members` returns how many rows it
 *    actually wrote, so somebody already in the group is skipped rather than
 *    counted, and a screen can say "28 of 31" honestly.
 * 4. ONE GROUP CALLED "OFFICERS". However it is capitalised.
 *
 * Exercised through real signed-in sessions, because every one of these
 * functions derives its actor inside the body and a test that called them any
 * other way would prove nothing about the application.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  seedRequester,
  signIn,
} from './support/harness';

interface GroupRow {
  id: string;
  name: string;
  description: string;
  member_count: number;
  updated_at: string;
}

interface MemberRow {
  requester_id: string;
  display_name: string;
  kind: string;
  external_id: string | null;
  email: string | null;
  group_label: string | null;
  note: string;
  added_at: string;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

/** A name no other run of this file can collide with. */
function groupName(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

async function createGroup(
  client: SupabaseClient,
  name: string,
  description = '',
): Promise<string> {
  return rpcOk<string>(client, 'app_create_group', {
    p_name: name,
    p_description: description,
  });
}

async function groups(client: SupabaseClient): Promise<GroupRow[]> {
  return rpcOk<GroupRow[]>(client, 'app_list_groups');
}

async function groupById(client: SupabaseClient, id: string): Promise<GroupRow | undefined> {
  return (await groups(client)).find((row) => row.id === id);
}

async function members(client: SupabaseClient, id: string): Promise<MemberRow[]> {
  return rpcOk<MemberRow[]>(client, 'app_group_members', { p_group: id });
}

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('starting a group', () => {
  it('is open to a skills officer, and comes back on the list with its count', async () => {
    const name = groupName('SkillsUSA members');
    const id = await createGroup(officer, name, '  Everybody in the chapter.  ');

    const row = await groupById(officer, id);
    expect(row?.name).toBe(name);
    // Trimmed on the way in, so a pasted description does not arrive with the
    // spreadsheet's whitespace on it.
    expect(row?.description).toBe('Everybody in the chapter.');
    expect(row?.member_count).toBe(0);

    // And it is everybody's: a NetRider and an administrator see the same row.
    expect((await groupById(netrider, id))?.name).toBe(name);
    expect((await groupById(admin, id))?.name).toBe(name);
  });

  it('refuses a name that says nothing', async () => {
    const refused = await rpcFails(officer, 'app_create_group', {
      p_name: '   ',
      p_description: '',
    });
    expect(refused.message).toContain('Give the group a name');
  });

  it('refuses a second group of the same name, however it is capitalised', async () => {
    const name = groupName('Officers');
    await createGroup(netrider, name);

    const refused = await rpcFails(officer, 'app_create_group', {
      p_name: name.toUpperCase(),
      p_description: '',
    });
    // The sentence names the group rather than the index that stopped it.
    expect(refused.message).toContain('already a group called');
  });

  it('records one history entry naming the group and nobody else', async () => {
    const name = groupName('Regionals 2027');
    const id = await createGroup(officer, name);

    const events = await rawRecordEvents('group', id);
    expect(events.map((event) => event.kind)).toEqual(['group_created']);
    expect(String(events[0].summary)).toContain(name);
  });
});

describe('members', () => {
  it('adds by id, skips the ones already in and answers with what it wrote', async () => {
    const id = await createGroup(officer, groupName('Chromebook cart 3'));
    const one = await seedRequester('student');
    const two = await seedRequester('student');

    const added = await rpcOk<number>(officer, 'app_add_group_members', {
      p_group: id,
      p_requesters: [one.id, two.id],
    });
    expect(added).toBe(2);

    // The same two again, plus one more: only the new one is a change.
    const three = await seedRequester('staff');
    const again = await rpcOk<number>(netrider, 'app_add_group_members', {
      p_group: id,
      p_requesters: [one.id, two.id, three.id],
    });
    expect(again).toBe(1);

    expect((await groupById(officer, id))?.member_count).toBe(3);
  });

  it('counts a person named twice in one call once', async () => {
    const id = await createGroup(officer, groupName('Duplicates'));
    const one = await seedRequester('student');

    const added = await rpcOk<number>(officer, 'app_add_group_members', {
      p_group: id,
      p_requesters: [one.id, one.id],
    });
    expect(added).toBe(1);
    expect((await members(officer, id))).toHaveLength(1);
  });

  it('refuses the whole call when an id is not in the directory', async () => {
    const id = await createGroup(officer, groupName('Unknown ids'));
    const one = await seedRequester('student');

    const refused = await rpcFails(officer, 'app_add_group_members', {
      p_group: id,
      p_requesters: [one.id, '11111111-1111-4111-8111-111111111111'],
    });
    expect(refused.message).toContain('not in the directory');
    // Nothing landed: half a roster is worse than none.
    expect(await members(officer, id)).toHaveLength(0);
  });

  it('refuses an empty list and a group that does not exist', async () => {
    const id = await createGroup(officer, groupName('Empty adds'));
    expect(
      (await rpcFails(officer, 'app_add_group_members', { p_group: id, p_requesters: [] })).message,
    ).toContain('at least one person');

    const person = await seedRequester('student');
    expect(
      (
        await rpcFails(officer, 'app_add_group_members', {
          p_group: '22222222-2222-4222-8222-222222222222',
          p_requesters: [person.id],
        })
      ).message,
    ).toContain('no group with that id');
  });

  it('reads back the class or department, the identifier and the note, by name', async () => {
    const id = await createGroup(officer, groupName('Roster read'));
    const student = await seedRequester('student', {
      display_name: 'Aaa Synthetic Student',
      official_class: '9A',
    });
    const staff = await seedRequester('staff', {
      display_name: 'Zzz Synthetic Staff',
      department: 'Science',
    });
    await rpcOk(officer, 'app_add_group_members', {
      p_group: id,
      p_requesters: [staff.id, student.id],
    });

    const rows = await members(officer, id);
    // Ordered by name, not by when they were added.
    expect(rows.map((row) => row.display_name)).toEqual([
      'Aaa Synthetic Student',
      'Zzz Synthetic Staff',
    ]);
    expect(rows[0].group_label).toBe('9A');
    expect(rows[0].external_id).toBe(student.externalId);
    expect(rows[0].note).toBe('');
    expect(rows[1].kind).toBe('staff');
    expect(rows[1].group_label).toBe('Science');
  });

  it('keeps a short note beside somebody, and cuts one that is too long', async () => {
    const id = await createGroup(officer, groupName('Notes'));
    const person = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', { p_group: id, p_requesters: [person.id] });

    await rpcOk(netrider, 'app_set_group_member_note', {
      p_group: id,
      p_requester: person.id,
      p_note: '  Treasurer  ',
    });
    expect((await members(officer, id))[0].note).toBe('Treasurer');

    await rpcOk(officer, 'app_set_group_member_note', {
      p_group: id,
      p_requester: person.id,
      p_note: 'x'.repeat(200),
    });
    expect((await members(officer, id))[0].note).toHaveLength(80);
  });

  it('takes somebody out, and does not mind being asked twice', async () => {
    const id = await createGroup(officer, groupName('Removals'));
    const person = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', { p_group: id, p_requesters: [person.id] });

    await rpcOk(netrider, 'app_remove_group_member', { p_group: id, p_requester: person.id });
    expect(await members(officer, id)).toHaveLength(0);

    // Removing somebody who is not in it leaves the roster as asked for, which
    // is the whole question, so it is not an error.
    await rpcOk(netrider, 'app_remove_group_member', { p_group: id, p_requester: person.id });
    expect((await groupById(officer, id))?.member_count).toBe(0);
  });

  it('moves the group’s updated_at when the roster changes', async () => {
    const id = await createGroup(officer, groupName('Stamped'));
    const before = (await groupById(officer, id))?.updated_at ?? '';
    const person = await seedRequester('student');

    await rpcOk(officer, 'app_add_group_members', { p_group: id, p_requesters: [person.id] });
    const after = (await groupById(officer, id))?.updated_at ?? '';
    expect(after).not.toBe(before);
    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it('records the count of a bulk add, and never who was added', async () => {
    const id = await createGroup(officer, groupName('Audited adds'));
    const one = await seedRequester('student');
    const two = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', {
      p_group: id,
      p_requesters: [one.id, two.id],
    });

    const events = await rawRecordEvents('group', id);
    const add = events.find((event) => event.kind === 'group_members_added');
    expect(String(add?.summary)).toContain('2 people');
    for (const event of events) {
      const written = `${event.summary} ${event.detail ?? ''}`;
      expect(written).not.toContain(one.displayName);
      expect(written).not.toContain(two.displayName);
      expect(written).not.toContain(one.externalId);
    }
  });
});

describe('editing and deleting', () => {
  it('lets any active account rename a group', async () => {
    const id = await createGroup(officer, groupName('Before'));
    const renamed = groupName('After');

    await rpcOk(netrider, 'app_update_group', {
      p_group: id,
      p_name: renamed,
      p_description: 'What it is for.',
    });

    const row = await groupById(officer, id);
    expect(row?.name).toBe(renamed);
    expect(row?.description).toBe('What it is for.');
  });

  it('refuses a rename onto a name another group already has', async () => {
    const taken = groupName('Taken');
    await createGroup(officer, taken);
    const id = await createGroup(officer, groupName('Renaming'));

    const refused = await rpcFails(officer, 'app_update_group', {
      p_group: id,
      p_name: taken,
      p_description: '',
    });
    expect(refused.message).toContain('already a group called');
  });

  it('refuses a NetRider the delete, and lets an administrator do it', async () => {
    const id = await createGroup(officer, groupName('Deletable'));
    const person = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', { p_group: id, p_requesters: [person.id] });

    const refusedRider = await rpcFails(netrider, 'app_delete_group', { p_group: id });
    expect(refusedRider.message).toContain('Only an administrator');
    const refusedOfficer = await rpcFails(officer, 'app_delete_group', { p_group: id });
    expect(refusedOfficer.message).toContain('Only an administrator');
    expect(await groupById(officer, id)).toBeDefined();

    await rpcOk(admin, 'app_delete_group', { p_group: id });
    expect(await groupById(officer, id)).toBeUndefined();
    // The membership went with it; the person did not.
    expect(await members(officer, id)).toHaveLength(0);

    const events = await rawRecordEvents('group', id);
    const deleted = events.find((event) => event.kind === 'group_deleted');
    expect(String(deleted?.detail)).toContain('1 member');
    expect(`${deleted?.summary} ${deleted?.detail ?? ''}`).not.toContain(person.displayName);
  });
});

describe('who is refused outright', () => {
  it('tells an anonymous caller nothing', async () => {
    const anon = anonClient();
    expect((await rpcFails(anon, 'app_list_groups')).message).not.toBe('');
    expect(
      (await rpcFails(anon, 'app_create_group', { p_name: 'Anything', p_description: '' })).message,
    ).not.toBe('');
  });

  it('refuses a deactivated account the read and every write', async () => {
    expect((await rpcFails(inactive, 'app_list_groups')).message).toContain(
      'cannot access helpdesk records',
    );
    expect(
      (await rpcFails(inactive, 'app_create_group', { p_name: groupName('Nope'), p_description: '' }))
        .message,
    ).toContain('cannot access helpdesk records');
  });

  it('keeps the tables themselves closed to a direct write', async () => {
    const id = await createGroup(officer, groupName('Closed'));
    const person = await seedRequester('student');

    const direct = await officer
      .from('people_group_members')
      .insert({ group_id: id, requester_id: person.id });
    expect(direct.error).not.toBeNull();

    const renamed = await officer.from('people_groups').update({ name: 'Anything' }).eq('id', id);
    expect(renamed.error).not.toBeNull();
  });
});
