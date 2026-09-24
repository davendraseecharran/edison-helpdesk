/**
 * Self check-in: a QR code on the door and a phone in every pocket.
 *
 * What these hold, and each is a way a public check-in could quietly go wrong:
 *
 * 1. THE PUBLIC DOOR IS TWO FUNCTIONS. An anonymous caller reads no table and
 *    writes no table; it reaches a check-in only through `app_public_checkin*`.
 * 2. EACH IDENTITY SETTING ASKS FOR WHAT IT SAYS: the OSIS, the name, either,
 *    or both belonging to the same person.
 * 3. A NAME IS A NAME however it is typed: case, spacing, apostrophes and
 *    accents do not make a different person. Two people with one name is a
 *    question for the OSIS, never a guess.
 * 4. THE ROSTER IS THE AUTHORITY. Somebody not in the group is not checked in
 *    unless walk-ins are allowed, and then they join the group first — and a
 *    stranger is told the same thing a real person not on the list is.
 * 5. THE WINDOW IS THE DATABASE'S: the switch, and the event's own school day.
 * 6. THE THROTTLE HOLDS per caller and leaves other callers alone.
 * 7. NOTHING LEAKS: a success says the first name and nothing else.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  schoolDateOffset,
  schoolToday,
  seedRequester,
  signIn,
  stack,
} from './support/harness';

interface Settings {
  event_id: string;
  slug: string;
  is_open: boolean;
  identity: string;
  walk_ins: boolean;
  state: string;
  present_count: number;
  self_count: number;
  member_count: number;
}

interface Answer {
  ok: boolean;
  outcome?: string;
  first_name?: string;
  reason?: string;
}

let officer: SupabaseClient;
let netrider: SupabaseClient;

/** An anonymous caller with its own client key, so throttle buckets never collide. */
function anonFrom(key = crypto.randomUUID()): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-edison-client': key } },
  });
}

function tag(): string {
  // Letters only, so a folded name keeps it whole.
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join('');
}

async function person(first: string, last: string, overrides: Record<string, unknown> = {}) {
  return seedRequester('student', {
    first_name: first,
    last_name: last,
    display_name: `${first} ${last}`,
    ...overrides,
  });
}

async function arrange(options: { heldOn?: string; members?: string[] } = {}) {
  const groupId = await rpcOk<string>(officer, 'app_create_group', {
    p_name: `Check-in group ${tag()}`,
    p_description: '',
  });
  if (options.members && options.members.length > 0) {
    await rpcOk(officer, 'app_add_group_members', { p_group: groupId, p_requesters: options.members });
  }
  const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
    p_group: groupId,
    p_name: 'Weekly meeting',
    p_held_on: options.heldOn ?? schoolToday(),
  });
  return { groupId, eventId };
}

async function turnOn(
  eventId: string,
  patch: { open?: boolean; identity?: string; walkIns?: boolean } = {},
): Promise<Settings> {
  return rpcOk<Settings>(officer, 'app_set_event_checkin', {
    p_event: eventId,
    p_open: patch.open ?? true,
    p_identity: patch.identity ?? null,
    p_walk_ins: patch.walkIns ?? null,
  });
}

async function checkIn(
  client: SupabaseClient,
  slug: string,
  input: { osis?: string; first?: string; last?: string },
): Promise<Answer> {
  return rpcOk<Answer>(client, 'app_public_checkin_submit', {
    p_slug: slug,
    p_osis: input.osis ?? '',
    p_first: input.first ?? '',
    p_last: input.last ?? '',
  });
}

async function present(eventId: string): Promise<string[]> {
  const { data, error } = await adminServiceClient()
    .from('group_attendance')
    .select('requester_id, marked_by')
    .eq('event_id', eventId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => String(row.requester_id));
}

beforeAll(async () => {
  officer = await signIn('skillsOfficer');
  netrider = await signIn('owner');
});

describe('turning it on', () => {
  it('draws an address and starts open, on the OSIS or the name, with no walk-ins', async () => {
    const { groupId, eventId } = await arrange();
    const settings = await turnOn(eventId);
    expect(settings.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(settings).toMatchObject({ is_open: true, identity: 'either', walk_ins: false, state: 'open' });

    // A second call keeps the address: a poster on the wall keeps working.
    const closed = await turnOn(eventId, { open: false });
    expect(closed.slug).toBe(settings.slug);
    expect(closed.state).toBe('closed');

    const listed = await rpcOk<Array<{ event_id: string; state: string }>>(netrider, 'app_group_event_checkins', {
      p_group: groupId,
    });
    expect(listed).toEqual([{ event_id: eventId, is_open: false, state: 'closed' }]);

    const kinds = (await rawRecordEvents('group', groupId)).map((event) => event.kind);
    expect(kinds).toContain('group_checkin_opened');
    expect(kinds).toContain('group_checkin_closed');
  });

  it('refuses a setting it does not know, and an event that is not there', async () => {
    const { eventId } = await arrange();
    expect((await rpcFails(officer, 'app_set_event_checkin', { p_event: eventId, p_identity: 'face' })).message).toContain(
      'Choose how people check in',
    );
    expect(
      (await rpcFails(officer, 'app_set_event_checkin', { p_event: crypto.randomUUID(), p_open: true })).message,
    ).toContain('no event');
    expect(await rpcOk(officer, 'app_event_checkin', { p_event: eventId })).toBeNull();
  });
});

describe('the public door', () => {
  it('gives an anonymous caller no table and none of the signed-in functions', async () => {
    const { eventId } = await arrange();
    await turnOn(eventId);
    const anon = anonClient();

    for (const table of ['event_checkins', 'event_checkin_attempts']) {
      const read = await anon.from(table).select('*');
      expect(read.error?.message ?? '', table).toMatch(/permission denied/i);
    }
    const write = await anon.from('event_checkins').insert({ event_id: eventId, slug: 'abcdefghjkmn' });
    expect(write.error).not.toBeNull();
    const attendance = await anon.from('group_attendance').select('*');
    expect(attendance.error?.message ?? '').toMatch(/permission denied/i);

    for (const [fn, args] of [
      ['app_event_checkin', { p_event: eventId }],
      ['app_set_event_checkin', { p_event: eventId, p_open: false }],
      ['app_group_event_checkins', { p_group: crypto.randomUUID() }],
      ['app_checkin_match', { p_group: crypto.randomUUID(), p_walk_ins: true, p_identity: 'name', p_osis: '', p_first: 'a', p_last: 'b' }],
      ['app_checkin_fold', { p_text: 'x' }],
    ] as const) {
      expect((await rpcFails(anon, fn, args)).message, fn).not.toBe('');
    }

    // And the throttle's memory is closed to signed-in accounts too.
    const signedIn = await officer.from('event_checkin_attempts').select('*');
    expect(signedIn.error?.message ?? '').toMatch(/permission denied/i);
  });

  it('reads a check-in by its slug and says only what the poster says', async () => {
    const { eventId } = await arrange();
    const { slug } = await turnOn(eventId, { identity: 'osis' });
    const view = await rpcOk<Record<string, unknown>>(anonClient(), 'app_public_checkin', { p_slug: slug });
    expect(Object.keys(view).sort()).toEqual(['event_name', 'group_name', 'held_on', 'identity', 'slug', 'state'].sort());
    expect(view).toMatchObject({ event_name: 'Weekly meeting', identity: 'osis', state: 'open' });
    expect(await rpcOk(anonClient(), 'app_public_checkin', { p_slug: 'abcdefghjkmn' })).toBeNull();
    expect(await rpcOk(anonClient(), 'app_public_checkin', { p_slug: "x' or 1=1" })).toBeNull();
  });
});

describe('who you are', () => {
  it('folds case, spacing, apostrophes and accents, and says the first name only', async () => {
    const last = `O'Neil${tag()}`;
    const jose = await person('José', last, { guardian_phone: '(718) 555-0142', email: `${tag()}@edison.example` });
    const { eventId } = await arrange({ members: [jose.id] });
    const { slug } = await turnOn(eventId);
    const anon = anonFrom();

    // No accent, no apostrophe, shouting, and padded: still José O'Neil.
    const typed = await checkIn(anon, slug, { first: '  JOSE ', last: `  ONEIL${last.slice(6).toUpperCase()} ` });
    expect(typed).toEqual({ ok: true, outcome: 'present', first_name: 'José' });
    expect(await present(eventId)).toEqual([jose.id]);

    // Again is not twice.
    expect(await checkIn(anon, slug, { first: 'josé', last })).toEqual({
      ok: true,
      outcome: 'already',
      first_name: 'José',
    });

    // Nothing beyond the first name: not the surname, the id, the phone.
    const text = JSON.stringify(typed);
    expect(text).not.toContain(last);
    expect(text).not.toContain(jose.externalId);
    expect(text).not.toContain('555');

    // The register knows it was self check-in: nobody signed in marked it.
    const settings = await rpcOk<Settings>(officer, 'app_event_checkin', { p_event: eventId });
    expect(settings).toMatchObject({ present_count: 1, self_count: 1, member_count: 1 });
  });

  it('finds a record kept surname first, and a first name on file with a middle name', async () => {
    const t = tag();
    const surnameFirst = await seedRequester('student', {
      first_name: null,
      last_name: null,
      display_name: `Okafor${t}, Chidi`,
    });
    const middle = await person('Amara Grace', `Bello${t}`);
    const { eventId } = await arrange({ members: [surnameFirst.id, middle.id] });
    const { slug } = await turnOn(eventId, { identity: 'name' });
    const anon = anonFrom();
    expect(await checkIn(anon, slug, { first: 'Chidi', last: `Okafor${t}` })).toMatchObject({ ok: true, outcome: 'present' });
    expect(await checkIn(anon, slug, { first: 'Amara', last: `Bello${t}` })).toMatchObject({
      ok: true,
      outcome: 'present',
      first_name: 'Amara Grace',
    });
  });

  it('asks each setting for what it says', async () => {
    const t = tag();
    const nia = await person('Nia', `Adeyemi${t}`);
    const other = await person('Kofi', `Mensah${t}`);
    const { eventId } = await arrange({ members: [nia.id, other.id] });
    const anon = anonFrom();

    const { slug } = await turnOn(eventId, { identity: 'osis' });
    expect(await checkIn(anon, slug, { first: 'Nia', last: `Adeyemi${t}` })).toEqual({ ok: false, reason: 'incomplete' });
    expect(await checkIn(anon, slug, { osis: ` ${nia.externalId} ` })).toMatchObject({ ok: true, outcome: 'present' });

    await turnOn(eventId, { identity: 'name' });
    expect(await checkIn(anon, slug, { osis: other.externalId })).toEqual({ ok: false, reason: 'incomplete' });
    expect(await checkIn(anon, slug, { first: 'kofi', last: `mensah${t}` })).toMatchObject({ ok: true, outcome: 'present' });

    const second = await arrange({ members: [nia.id, other.id] });
    const both = await turnOn(second.eventId, { identity: 'both' });
    expect(await checkIn(anon, both.slug, { osis: nia.externalId })).toEqual({ ok: false, reason: 'incomplete' });
    // The OSIS of one and the name of the other is nobody.
    expect(await checkIn(anon, both.slug, { osis: nia.externalId, first: 'Kofi', last: `Mensah${t}` })).toEqual({
      ok: false,
      reason: 'no_match',
    });
    expect(await checkIn(anon, both.slug, { osis: nia.externalId, first: 'Nia', last: `Adeyemi${t}` })).toMatchObject({
      ok: true,
      outcome: 'present',
    });
  });

  it('turns a shared name into a question for the OSIS, and never picks one', async () => {
    const t = tag();
    const one = await person('Nia', `Okonkwo${t}`);
    const two = await person('Nia', `Okonkwo${t}`);
    const { eventId } = await arrange({ members: [one.id, two.id] });
    const { slug } = await turnOn(eventId);
    const anon = anonFrom();

    expect(await checkIn(anon, slug, { first: 'Nia', last: `Okonkwo${t}` })).toEqual({ ok: false, reason: 'ambiguous' });
    expect(await present(eventId)).toEqual([]);

    // The name and the OSIS together, as the page sends them next.
    expect(await checkIn(anon, slug, { first: 'Nia', last: `Okonkwo${t}`, osis: two.externalId })).toMatchObject({
      ok: true,
      outcome: 'present',
    });
    expect(await present(eventId)).toEqual([two.id]);
  });
});

describe('the roster', () => {
  it('answers somebody not on the list exactly like somebody who does not exist', async () => {
    const t = tag();
    const member = await person('Ada', `Lovelace${t}`);
    const outsider = await person('Grace', `Hopper${t}`);
    const { eventId } = await arrange({ members: [member.id] });
    const { slug } = await turnOn(eventId);
    const anon = anonFrom();

    const notOnList = await checkIn(anon, slug, { first: 'Grace', last: `Hopper${t}` });
    const nobody = await checkIn(anon, slug, { first: 'Nobody', last: `Atall${t}` });
    const outsiderById = await checkIn(anon, slug, { osis: outsider.externalId });
    expect(notOnList).toEqual({ ok: false, reason: 'no_match' });
    expect(nobody).toEqual(notOnList);
    expect(outsiderById).toEqual(notOnList);
    expect(await present(eventId)).toEqual([]);
  });

  it('adds a walk-in to the group, noted, and marks them present, when the officer allows it', async () => {
    const t = tag();
    const member = await person('Ada', `Lovelace${t}`);
    const walkIn = await person('Grace', `Hopper${t}`);
    const archived = await person('Old', `Student${t}`, { archived_at: new Date().toISOString() });
    const { groupId, eventId } = await arrange({ members: [member.id] });
    const { slug } = await turnOn(eventId, { walkIns: true });
    const anon = anonFrom();

    expect(await checkIn(anon, slug, { first: 'grace', last: `hopper${t}` })).toEqual({
      ok: true,
      outcome: 'present',
      first_name: 'Grace',
    });
    const { data } = await adminServiceClient()
      .from('people_group_members')
      .select('requester_id, note, added_by')
      .eq('group_id', groupId)
      .eq('requester_id', walkIn.id)
      .single();
    expect(data).toMatchObject({ note: 'Walk-in', added_by: null });
    expect((await present(eventId)).sort()).toEqual([walkIn.id].sort());

    // Somebody who has left is not walking in.
    expect(await checkIn(anon, slug, { first: 'Old', last: `Student${t}` })).toEqual({ ok: false, reason: 'no_match' });
    void archived;
  });

  it('looks on the roster first, so a name the directory shares is still the member', async () => {
    const t = tag();
    const member = await person('Sam', `Rivera${t}`);
    await person('Sam', `Rivera${t}`);
    const { eventId } = await arrange({ members: [member.id] });
    const { slug } = await turnOn(eventId, { walkIns: true, identity: 'name' });
    expect(await checkIn(anonFrom(), slug, { first: 'Sam', last: `Rivera${t}` })).toMatchObject({ ok: true, outcome: 'present' });
    expect(await present(eventId)).toEqual([member.id]);
  });
});

describe('the window', () => {
  it('is closed by the switch, before the event day and after it', async () => {
    const t = tag();
    const nia = await person('Nia', `Window${t}`);
    const today = await arrange({ members: [nia.id] });
    const { slug } = await turnOn(today.eventId, { open: false });
    expect(await checkIn(anonFrom(), slug, { first: 'Nia', last: `Window${t}` })).toEqual({ ok: false, reason: 'closed' });
    expect((await rpcOk<{ state: string }>(anonClient(), 'app_public_checkin', { p_slug: slug })).state).toBe('closed');

    const yesterday = await arrange({ members: [nia.id], heldOn: schoolDateOffset(-1) });
    const past = await turnOn(yesterday.eventId);
    expect(past.state).toBe('ended');
    expect(await checkIn(anonFrom(), past.slug, { first: 'Nia', last: `Window${t}` })).toEqual({ ok: false, reason: 'ended' });

    const tomorrow = await arrange({ members: [nia.id], heldOn: schoolDateOffset(1) });
    const future = await turnOn(tomorrow.eventId);
    expect(future.state).toBe('early');
    expect(await checkIn(anonFrom(), future.slug, { first: 'Nia', last: `Window${t}` })).toEqual({ ok: false, reason: 'early' });

    expect(await present(today.eventId)).toEqual([]);
    expect(await present(yesterday.eventId)).toEqual([]);
    expect(await present(tomorrow.eventId)).toEqual([]);
  });
});

describe('the throttle', () => {
  it('stops one caller after ten misses and leaves the next caller alone', async () => {
    const t = tag();
    const nia = await person('Nia', `Throttle${t}`);
    const { eventId } = await arrange({ members: [nia.id] });
    const { slug } = await turnOn(eventId);
    const noisy = anonFrom();
    for (let at = 0; at < 10; at += 1) {
      expect((await checkIn(noisy, slug, { osis: `00000000${at}` })).reason).toBe('no_match');
    }
    // Even the right answer is refused now, from this caller.
    expect(await checkIn(noisy, slug, { first: 'Nia', last: `Throttle${t}` })).toEqual({ ok: false, reason: 'throttled' });
    expect(await present(eventId)).toEqual([]);

    expect(await checkIn(anonFrom(), slug, { first: 'Nia', last: `Throttle${t}` })).toMatchObject({
      ok: true,
      outcome: 'present',
    });
  });

  it('stops one phone checking in a crowd', async () => {
    const t = tag();
    const people = await Promise.all(Array.from({ length: 26 }, (_, at) => person(`P${at}x`, `Crowd${t}`)));
    const { eventId } = await arrange({ members: people.map((entry) => entry.id) });
    const { slug } = await turnOn(eventId, { identity: 'osis' });
    const phone = anonFrom();
    for (const entry of people.slice(0, 25)) {
      expect((await checkIn(phone, slug, { osis: entry.externalId })).ok).toBe(true);
    }
    expect(await checkIn(phone, slug, { osis: people[25].externalId })).toEqual({ ok: false, reason: 'throttled' });
    expect(await present(eventId)).toHaveLength(25);
  });
});
