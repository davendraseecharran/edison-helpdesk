/**
 * Attendance: the register a group takes, and the rules that keep it honest.
 *
 * Four things carry it, and each is a way a register could quietly become
 * fiction:
 *
 * 1. THE MEMBERSHIP IS THE AUTHORITY. Somebody who is not in the group cannot
 *    be marked present at its meeting, by id or by scanned card. A roster that
 *    grew a shadow membership of people who were only ever scanned at the door
 *    would be a roster nobody could trust.
 * 2. THE FIVE ANSWERS ARE REALLY FIVE. `app_mark_attendance_by_key` is what a
 *    phone at a door calls, and each of present / already / not_member /
 *    no_match / ambiguous is a different thing for the person holding it to do.
 * 3. A SECOND SCAN IS NOT A SECOND PERSON. Marking twice is idempotent, and it
 *    says so rather than silently doing nothing.
 * 4. DELETING THE EVENT TAKES THE REGISTER WITH IT, and says how many rows went.
 *
 * Every call is a real signed-in session, because every one of these functions
 * derives its actor inside the body.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  schoolToday,
  seedRequester,
  signIn,
} from './support/harness';

interface EventRow {
  id: string;
  name: string;
  held_on: string;
  present_count: number;
  member_count: number;
}

interface RollRow {
  requester_id: string;
  display_name: string;
  kind: string;
  external_id: string | null;
  group_label: string | null;
  present: boolean;
  marked_at: string | null;
}

interface KeyRow {
  outcome: string;
  requester_id: string | null;
  display_name: string | null;
}

interface ManyRow {
  outcome: string;
  requester_id: string;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

function unique(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

async function newGroup(client: SupabaseClient): Promise<string> {
  return rpcOk<string>(client, 'app_create_group', {
    p_name: unique('Attendance group'),
    p_description: '',
  });
}

async function events(client: SupabaseClient, groupId: string): Promise<EventRow[]> {
  return rpcOk<EventRow[]>(client, 'app_list_group_events', { p_group: groupId });
}

async function roll(client: SupabaseClient, eventId: string): Promise<RollRow[]> {
  return rpcOk<RollRow[]>(client, 'app_event_roll', { p_event: eventId });
}

async function byKey(client: SupabaseClient, eventId: string, key: string): Promise<KeyRow> {
  const rows = await rpcOk<KeyRow[]>(client, 'app_mark_attendance_by_key', {
    p_event: eventId,
    p_key: key,
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** A group with two members and one event, which is what most of these need. */
async function arrange(): Promise<{
  groupId: string;
  eventId: string;
  one: { id: string; displayName: string; externalId: string };
  two: { id: string; displayName: string; externalId: string };
}> {
  const groupId = await newGroup(officer);
  const one = await seedRequester('student');
  const two = await seedRequester('staff');
  await rpcOk(officer, 'app_add_group_members', {
    p_group: groupId,
    p_requesters: [one.id, two.id],
  });
  const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
    p_group: groupId,
    p_name: 'Weekly meeting',
    p_held_on: schoolToday(),
  });
  return { groupId, eventId, one, two };
}

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('events', () => {
  it('is added by any active account and comes back with both counts', async () => {
    const { groupId, one } = await arrange();

    const list = await events(netrider, groupId);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Weekly meeting');
    expect(list[0].held_on).toBe(schoolToday());
    expect(list[0].present_count).toBe(0);
    expect(list[0].member_count).toBe(2);

    // The counts are live: marking somebody moves the first of them.
    await rpcOk(netrider, 'app_mark_attendance', {
      p_event: list[0].id,
      p_requester: one.id,
      p_present: true,
    });
    expect((await events(admin, groupId))[0].present_count).toBe(1);
  });

  it('refuses a nameless event and an unknown group', async () => {
    const groupId = await newGroup(officer);
    expect(
      (await rpcFails(officer, 'app_create_group_event', { p_group: groupId, p_name: '  ' })).message,
    ).toContain('Give the event a name');
    expect(
      (
        await rpcFails(officer, 'app_create_group_event', {
          p_group: '11111111-1111-4111-8111-111111111111',
          p_name: 'Meeting',
        })
      ).message,
    ).toContain('no group with that id');
  });

  it('lists newest first', async () => {
    const groupId = await newGroup(officer);
    await rpcOk(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Older',
      p_held_on: '2026-01-05',
    });
    await rpcOk(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Newer',
      p_held_on: '2026-03-05',
    });
    expect((await events(officer, groupId)).map((row) => row.name)).toEqual(['Newer', 'Older']);
  });

  it('records the creation against the group, naming the event and nobody else', async () => {
    const { groupId } = await arrange();
    const written = await rawRecordEvents('group', groupId);
    const created = written.find((event) => event.kind === 'group_event_created');
    expect(String(created?.summary)).toContain('Weekly meeting');
  });
});

describe('the roll', () => {
  it('is every member of the group, present or not, in name order', async () => {
    const groupId = await newGroup(officer);
    const first = await seedRequester('student', {
      display_name: 'Aaa Roll Student',
      official_class: '9A',
    });
    const last = await seedRequester('staff', {
      display_name: 'Zzz Roll Staff',
      department: 'Science',
    });
    await rpcOk(officer, 'app_add_group_members', {
      p_group: groupId,
      p_requesters: [last.id, first.id],
    });
    const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Practice',
    });

    const rows = await roll(officer, eventId);
    expect(rows.map((row) => row.display_name)).toEqual(['Aaa Roll Student', 'Zzz Roll Staff']);
    expect(rows[0].group_label).toBe('9A');
    expect(rows[1].group_label).toBe('Science');
    expect(rows.every((row) => row.present === false)).toBe(true);
    expect(rows[0].marked_at).toBeNull();

    await rpcOk(officer, 'app_mark_attendance', {
      p_event: eventId,
      p_requester: first.id,
      p_present: true,
    });
    const marked = (await roll(officer, eventId))[0];
    expect(marked.present).toBe(true);
    expect(Number.isFinite(Date.parse(marked.marked_at ?? ''))).toBe(true);
  });

  it('answers with no rows for an event that does not exist', async () => {
    expect(await roll(officer, '11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });
});

describe('marking by id', () => {
  it('marks, unmarks, and does not mind being asked twice', async () => {
    const { eventId, one } = await arrange();

    await rpcOk(officer, 'app_mark_attendance', {
      p_event: eventId,
      p_requester: one.id,
      p_present: true,
    });
    await rpcOk(officer, 'app_mark_attendance', {
      p_event: eventId,
      p_requester: one.id,
      p_present: true,
    });
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(1);

    await rpcOk(netrider, 'app_mark_attendance', {
      p_event: eventId,
      p_requester: one.id,
      p_present: false,
    });
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(0);
  });

  it('refuses somebody who is not in the group, and names the group', async () => {
    const { eventId } = await arrange();
    const stranger = await seedRequester('student');

    const refused = await rpcFails(officer, 'app_mark_attendance', {
      p_event: eventId,
      p_requester: stranger.id,
      p_present: true,
    });
    expect(refused.message).toContain('Attendance group');
    expect(refused.message).toContain('Add them to the group first');
  });

  it('refuses an event that does not exist', async () => {
    const person = await seedRequester('student');
    const refused = await rpcFails(officer, 'app_mark_attendance', {
      p_event: '11111111-1111-4111-8111-111111111111',
      p_requester: person.id,
      p_present: true,
    });
    expect(refused.message).toContain('no event with that id');
  });
});

describe('marking by key, which is what the scanner calls', () => {
  it('marks on an OSIS or staff id and says who it was', async () => {
    const { eventId, one } = await arrange();

    const marked = await byKey(officer, eventId, one.externalId);
    expect(marked.outcome).toBe('present');
    expect(marked.requester_id).toBe(one.id);
    expect(marked.display_name).toBe(one.displayName);
  });

  it('says "already" on the second scan rather than pretending it did something', async () => {
    const { eventId, one } = await arrange();
    await byKey(officer, eventId, one.externalId);

    const again = await byKey(netrider, eventId, one.externalId);
    expect(again.outcome).toBe('already');
    expect(again.requester_id).toBe(one.id);
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(1);
  });

  it('matches a full name, ignoring capitals', async () => {
    const { eventId, two } = await arrange();
    const marked = await byKey(officer, eventId, two.displayName.toUpperCase());
    expect(marked.outcome).toBe('present');
    expect(marked.requester_id).toBe(two.id);
  });

  it('names a real person who is not in this group', async () => {
    const { eventId } = await arrange();
    const stranger = await seedRequester('student');

    const answer = await byKey(officer, eventId, stranger.externalId);
    expect(answer.outcome).toBe('not_member');
    expect(answer.requester_id).toBe(stranger.id);
    expect(answer.display_name).toBe(stranger.displayName);
  });

  it('says no match for a code nothing reads like, and marks nobody', async () => {
    const { eventId } = await arrange();
    const answer = await byKey(officer, eventId, `9${crypto.randomUUID().slice(0, 8)}`);
    expect(answer.outcome).toBe('no_match');
    expect(answer.requester_id).toBeNull();
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(0);
  });

  it('refuses to choose between two people of one name', async () => {
    const groupId = await newGroup(officer);
    const shared = `Shared Name ${crypto.randomUUID().slice(0, 6)}`;
    const first = await seedRequester('student', { display_name: shared });
    const second = await seedRequester('student', { display_name: shared });
    await rpcOk(officer, 'app_add_group_members', {
      p_group: groupId,
      p_requesters: [first.id, second.id],
    });
    const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Meeting',
    });

    const answer = await byKey(officer, eventId, shared);
    expect(answer.outcome).toBe('ambiguous');
    expect(answer.requester_id).toBeNull();
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(0);

    // The identifier still works, which is what the message tells somebody to use.
    const byId = await byKey(officer, eventId, first.externalId);
    expect(byId.outcome).toBe('present');
  });

  it('refuses an empty key rather than answering "no match" to nothing', async () => {
    const { eventId } = await arrange();
    const refused = await rpcFails(officer, 'app_mark_attendance_by_key', {
      p_event: eventId,
      p_key: '   ',
    });
    expect(refused.message).toContain('Scan a card');
  });
});

describe('marking a whole list', () => {
  it('answers one row per id: marked, already, or not in the group', async () => {
    const { eventId, one, two } = await arrange();
    const stranger = await seedRequester('student');
    await byKey(officer, eventId, one.externalId);

    const answers = await rpcOk<ManyRow[]>(officer, 'app_mark_attendance_many', {
      p_event: eventId,
      p_requesters: [one.id, two.id, stranger.id],
    });

    const outcomes = new Map(answers.map((row) => [row.requester_id, row.outcome]));
    expect(outcomes.get(one.id)).toBe('already');
    expect(outcomes.get(two.id)).toBe('present');
    expect(outcomes.get(stranger.id)).toBe('not_member');
    // Nobody outside the group landed in the register.
    expect((await roll(officer, eventId)).filter((row) => row.present)).toHaveLength(2);
  });

  it('refuses an empty list and an event that is not there', async () => {
    const { eventId } = await arrange();
    expect(
      (await rpcFails(officer, 'app_mark_attendance_many', { p_event: eventId, p_requesters: [] }))
        .message,
    ).toContain('at least one person');
    expect(
      (
        await rpcFails(officer, 'app_mark_attendance_many', {
          p_event: '11111111-1111-4111-8111-111111111111',
          p_requesters: [crypto.randomUUID()],
        })
      ).message,
    ).toContain('no event with that id');
  });
});

describe('deleting an event', () => {
  it('takes the register with it and records how many rows went', async () => {
    const { groupId, eventId, one } = await arrange();
    await byKey(officer, eventId, one.externalId);

    // Not an administrator's act: a Tuesday can be taken again.
    await rpcOk(netrider, 'app_delete_group_event', { p_event: eventId });

    expect(await events(officer, groupId)).toHaveLength(0);
    expect(await roll(officer, eventId)).toHaveLength(0);

    const written = await rawRecordEvents('group', groupId);
    const deleted = written.find((event) => event.kind === 'group_event_deleted');
    expect(String(deleted?.detail)).toContain('1 attendance record');
    expect(`${deleted?.summary} ${deleted?.detail ?? ''}`).not.toContain(one.displayName);
  });

  it('refuses an event that does not exist', async () => {
    const refused = await rpcFails(officer, 'app_delete_group_event', {
      p_event: '11111111-1111-4111-8111-111111111111',
    });
    expect(refused.message).toContain('no event with that id');
  });

  it('goes when the group goes', async () => {
    const { groupId, eventId } = await arrange();
    await rpcOk(admin, 'app_delete_group', { p_group: groupId });
    expect(await roll(officer, eventId)).toHaveLength(0);
  });
});

describe('the export entry', () => {
  it('records the count and which file, and refuses anything else', async () => {
    const { groupId } = await arrange();

    await rpcOk(officer, 'app_log_group_export', {
      p_group: groupId,
      p_what: 'roster',
      p_count: 2,
    });
    await rpcOk(netrider, 'app_log_group_export', {
      p_group: groupId,
      p_what: 'attendance',
      p_count: 2,
    });

    const written = await rawRecordEvents('group', groupId);
    expect(String(written.find((event) => event.kind === 'group_export')?.summary)).toContain(
      '2 rows',
    );
    expect(
      String(written.find((event) => event.kind === 'group_attendance_export')?.summary),
    ).toContain('2 rows');

    expect(
      (await rpcFails(officer, 'app_log_group_export', { p_group: groupId, p_what: 'everything' }))
        .message,
    ).toContain('roster or attendance');
  });
});

describe('who is refused outright', () => {
  it('tells an anonymous caller nothing', async () => {
    const anon = anonClient();
    expect(
      (await rpcFails(anon, 'app_list_group_events', { p_group: crypto.randomUUID() })).message,
    ).not.toBe('');
  });

  it('refuses a deactivated account the read and the register', async () => {
    const { groupId, eventId, one } = await arrange();
    expect((await rpcFails(inactive, 'app_list_group_events', { p_group: groupId })).message).toContain(
      'cannot access helpdesk records',
    );
    expect(
      (
        await rpcFails(inactive, 'app_mark_attendance', {
          p_event: eventId,
          p_requester: one.id,
          p_present: true,
        })
      ).message,
    ).toContain('cannot access helpdesk records');
  });

  it('keeps the tables closed to a direct write', async () => {
    const { eventId, one } = await arrange();
    const direct = await officer
      .from('group_attendance')
      .insert({ event_id: eventId, requester_id: one.id });
    expect(direct.error).not.toBeNull();
  });
});
