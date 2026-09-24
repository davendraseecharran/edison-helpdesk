/**
 * Forms: the sign-up sheet, kept against the directory.
 *
 * What these hold, and each is a way a public form could quietly go wrong:
 *
 * 1. THE PUBLIC DOOR IS THREE FUNCTIONS. An anonymous caller reads no table and
 *    writes no table; it reaches a form only through `app_public_form*`.
 * 2. IDENTITY TAKES BOTH HALVES. The school email and the OSIS have to name the
 *    same record, and a miss says the same thing whichever half was wrong.
 * 3. THE GUARDIAN'S NUMBER NEVER LEAVES WHOLE. The prefill masks it to four
 *    digits and never carries an address; keeping it stores the real number,
 *    which only a signed-in reader sees.
 * 4. CLOSED AND FULL ARE THE DATABASE'S. A closed form and a full one refuse a
 *    new response whatever the page believed.
 * 5. A LINKED GROUP AND EVENT DO THEIR JOB: a matched response puts the person
 *    on the roster and marks them present.
 * 6. A skills officer makes forms; sharing, deleting and the throttle behave.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  schoolToday,
  seedRequester,
  signIn,
  stack,
} from './support/harness';

interface FormDetail {
  id: string;
  slug: string;
  title: string;
  fields: Array<Record<string, unknown>>;
  state: string;
  group_id: string | null;
  event_id: string | null;
  shared: boolean;
  can_own: boolean;
  response_count: number;
}

interface ResponseRow {
  id: string;
  requester_id: string | null;
  display_name: string | null;
  answers: Record<string, unknown>;
  changed: string[];
  via: string;
  recorded_by_name: string | null;
}

interface Identified {
  ok: boolean;
  reason?: string;
  first_name?: string;
  prefill?: Record<string, string>;
  masked?: Record<string, string>;
  already?: boolean;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let unrelated: SupabaseClient;

/** An anonymous caller with its own client address, so throttle buckets never collide. */
function anonFrom(address = crypto.randomUUID()): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-edison-client': address } },
  });
}

const TRIP_FIELDS = [
  { id: 'name', type: 'directory', directory: 'full_name', label: 'Full name', required: true },
  { id: 'osis', type: 'directory', directory: 'external_id', label: 'OSIS', required: true },
  { id: 'cls', type: 'directory', directory: 'official_class', label: 'Official class' },
  { id: 'gname', type: 'directory', directory: 'guardian_name', label: 'Guardian name' },
  { id: 'gphone', type: 'directory', directory: 'guardian_phone', label: 'Guardian phone', required: true },
  {
    id: 'shirt',
    type: 'single_choice',
    label: 'Shirt size',
    required: true,
    options: ['S', 'M', 'L', 'M', '  '],
  },
  { id: 'diet', type: 'multi_choice', label: 'Dietary needs', options: ['Vegetarian', 'Halal', 'None'] },
  { id: 'sign', type: 'signature', label: 'Guardian signature' },
];

async function newForm(
  client: SupabaseClient,
  options: { fields?: unknown[]; audience?: 'directory' | 'anyone'; title?: string } = {},
): Promise<FormDetail> {
  const id = await rpcOk<string>(client, 'app_create_form', {
    p_title: options.title ?? `Trip sign-up ${crypto.randomUUID().slice(0, 6)}`,
    p_description: 'Bring a packed lunch.',
    p_fields: options.fields ?? TRIP_FIELDS,
    p_audience: options.audience ?? 'directory',
  });
  return getForm(client, id);
}

async function getForm(client: SupabaseClient, id: string): Promise<FormDetail> {
  return rpcOk<FormDetail>(client, 'app_get_form', { p_form: id });
}

async function settings(
  client: SupabaseClient,
  form: FormDetail,
  patch: Partial<{
    isOpen: boolean;
    closesAt: string | null;
    cap: number | null;
    audience: string;
    group: string | null;
    event: string | null;
    shared: boolean;
  }>,
): Promise<void> {
  await rpcOk(client, 'app_save_form_settings', {
    p_form: form.id,
    p_is_open: patch.isOpen ?? true,
    p_closes_at: patch.closesAt ?? null,
    p_response_cap: patch.cap ?? null,
    p_audience: patch.audience ?? 'directory',
    p_group: patch.group ?? null,
    p_event: patch.event ?? null,
    p_shared: patch.shared ?? true,
  });
}

async function student(overrides: Record<string, unknown> = {}) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const email = `form.${suffix}@edison.example`;
  const person = await seedRequester('student', {
    first_name: 'Jordan',
    display_name: `Jordan Formtest ${suffix}`,
    email,
    official_class: '10B',
    class_of: '2028',
    guardian_name: 'Robin Formtest',
    guardian_phone: '(718) 555-0142',
    address: '12 Example Street, Queens',
    ...overrides,
  });
  return { ...person, email };
}

async function identify(
  client: SupabaseClient,
  slug: string,
  email: string,
  id: string,
): Promise<Identified> {
  return rpcOk<Identified>(client, 'app_public_form_identify', {
    p_slug: slug,
    p_email: email,
    p_external_id: id,
  });
}

async function submit(
  client: SupabaseClient,
  slug: string,
  email: string,
  id: string,
  answers: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return rpcOk<Record<string, unknown>>(client, 'app_public_form_submit', {
    p_slug: slug,
    p_email: email,
    p_external_id: id,
    p_answers: answers,
  });
}

const KEEP = { keep: true };
const GOOD_ANSWERS = {
  name: KEEP,
  osis: KEEP,
  gphone: KEEP,
  shirt: 'M',
  diet: ['None', 'Vegetarian'],
  sign: 'M10 20L30 40L50 20',
};

async function responses(client: SupabaseClient, formId: string): Promise<ResponseRow[]> {
  return rpcOk<ResponseRow[]>(client, 'app_form_responses', { p_form: formId });
}

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  unrelated = await signIn('unrelated');
});

describe('making a form', () => {
  it('is open to a skills officer, and the questions come back cleaned', async () => {
    const form = await newForm(officer);
    expect(form.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(form.state).toBe('open');
    expect(form.shared).toBe(true);
    expect(form.can_own).toBe(true);

    const shirt = form.fields.find((field) => field.id === 'shirt');
    // Repeated and blank choices are dropped, the order is kept.
    expect(shirt?.options).toEqual(['S', 'M', 'L']);
    expect(form.fields.find((field) => field.id === 'name')?.required).toBe(true);

    const created = await rawRecordEvents('form', form.id);
    expect(created.map((event) => event.kind)).toContain('form_created');
  });

  it('refuses a question type it does not know and a directory fact asked twice', async () => {
    expect(
      (
        await rpcFails(officer, 'app_create_form', {
          p_title: 'Broken',
          p_fields: [{ id: 'a', type: 'essay', label: 'Tell us' }],
        })
      ).message,
    ).toContain('type this form does not know');
    expect(
      (
        await rpcFails(officer, 'app_create_form', {
          p_title: 'Twice',
          p_fields: [
            { id: 'a', type: 'directory', directory: 'email', label: 'Email' },
            { id: 'b', type: 'directory', directory: 'email', label: 'Email again' },
          ],
        })
      ).message,
    ).toContain('already asks for that');
    expect((await rpcFails(officer, 'app_create_form', { p_title: '   ' })).message).toContain(
      'Give the form a title',
    );
  });

  it('lists shared forms to everybody and a private one only to its maker and an administrator', async () => {
    const shared = await newForm(officer);
    const hidden = await newForm(officer);
    await settings(officer, hidden, { shared: false });

    const seenBy = async (client: SupabaseClient) =>
      (await rpcOk<Array<{ id: string }>>(client, 'app_list_forms')).map((row) => row.id);

    expect(await seenBy(netrider)).toContain(shared.id);
    expect(await seenBy(netrider)).not.toContain(hidden.id);
    expect(await seenBy(officer)).toContain(hidden.id);
    expect(await seenBy(admin)).toContain(hidden.id);
    expect(await rpcOk(netrider, 'app_get_form', { p_form: hidden.id })).toBeNull();
    expect((await rpcFails(netrider, 'app_form_responses', { p_form: hidden.id })).message).toContain(
      'no form with that id',
    );
  });

  it('lets only the maker change who sees it, and only the maker or an administrator delete it', async () => {
    const form = await newForm(officer);
    expect(
      (
        await rpcFails(netrider, 'app_save_form_settings', {
          p_form: form.id,
          p_is_open: true,
          p_closes_at: null,
          p_response_cap: null,
          p_audience: 'directory',
          p_group: null,
          p_event: null,
          p_shared: false,
        })
      ).message,
    ).toContain('Only the person who made this form');
    expect((await rpcFails(netrider, 'app_delete_form', { p_form: form.id })).message).toContain(
      'Only the person who made this form',
    );
    await rpcOk(admin, 'app_delete_form', { p_form: form.id });
    expect(await rpcOk(officer, 'app_get_form', { p_form: form.id })).toBeNull();
  });
});

describe('the public door', () => {
  it('gives an anonymous caller no table at all', async () => {
    const form = await newForm(officer);
    const anon = anonClient();

    const read = await anon.from('forms').select('id, slug');
    expect(read.error !== null || (read.data ?? []).length === 0).toBe(true);
    expect(read.error?.message ?? '').toMatch(/permission denied/i);

    const responsesRead = await anon.from('form_responses').select('id');
    expect(responsesRead.error?.message ?? '').toMatch(/permission denied/i);

    const write = await anon
      .from('form_responses')
      .insert({ form_id: form.id, answers: {}, via: 'link' });
    expect(write.error).not.toBeNull();

    const attempts = await anon.from('form_identity_attempts').select('*');
    expect(attempts.error?.message ?? '').toMatch(/permission denied/i);

    // And not the signed-in reads or writes either.
    for (const [fn, args] of [
      ['app_list_forms', {}],
      ['app_get_form', { p_form: form.id }],
      ['app_form_responses', { p_form: form.id }],
      ['app_create_form', { p_title: 'Nope' }],
      ['app_delete_form_response', { p_response: crypto.randomUUID() }],
      ['app_form_kiosk_identify', { p_form: form.id, p_key: '123' }],
    ] as const) {
      expect((await rpcFails(anon, fn, args)).message, fn).not.toBe('');
    }
  });

  it('keeps the throttle table closed to signed-in accounts too', async () => {
    const read = await admin.from('form_identity_attempts').select('*');
    expect(read.error?.message ?? '').toMatch(/permission denied/i);
  });

  it('reads a form by its slug, without its group, its maker or its responses', async () => {
    const form = await newForm(officer);
    const anon = anonClient();
    const view = await rpcOk<Record<string, unknown>>(anon, 'app_public_form', { p_slug: form.slug });
    expect(view.title).toBe(form.title);
    expect(view.state).toBe('open');
    expect(Array.isArray(view.fields)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(
      ['audience', 'closes_at', 'description', 'fields', 'slug', 'state', 'title'].sort(),
    );

    expect(await rpcOk(anon, 'app_public_form', { p_slug: 'abcdefghjkmn' })).toBeNull();
    expect(await rpcOk(anon, 'app_public_form', { p_slug: "x' or 1=1" })).toBeNull();
  });

  it('needs the email and the OSIS to name the same person, and says no_match either way', async () => {
    const form = await newForm(officer);
    const person = await student();
    const other = await student();
    const anon = anonFrom();

    const wrongId = await identify(anon, form.slug, person.email, other.externalId);
    const wrongEmail = await identify(anon, form.slug, other.email, person.externalId);
    const bothWrong = await identify(anon, form.slug, 'nobody@edison.example', '000000000');
    expect(wrongId).toEqual({ ok: false, reason: 'no_match' });
    expect(wrongEmail).toEqual(wrongId);
    expect(bothWrong).toEqual(wrongId);
    expect(await identify(anon, form.slug, person.email, '')).toEqual({ ok: false, reason: 'incomplete' });

    // Case and spacing are not a different person.
    const right = await identify(anon, form.slug, person.email.toUpperCase(), ` ${person.externalId} `);
    expect(right.ok).toBe(true);
    expect(right.first_name).toBe('Jordan');
    expect(right.prefill?.name).toBe(person.displayName);
    expect(right.prefill?.osis).toBe(person.externalId);
    expect(right.prefill?.cls).toBe('10B');
    expect(right.already).toBe(false);
  });

  it('never hands the guardian phone or an address to the public, only the last four digits', async () => {
    const form = await newForm(officer);
    const person = await student();
    const found = await identify(anonFrom(), form.slug, person.email, person.externalId);

    expect(found.masked?.gphone).toBe('••• ••• 0142');
    expect(found.prefill?.gphone).toBeUndefined();
    const text = JSON.stringify(found);
    expect(text).not.toContain('555');
    expect(text).not.toContain('7185550142');
    expect(text).not.toContain('Example Street');
    // Only the facts this form asks for: it does not ask for email or class of.
    expect(Object.keys(found.prefill ?? {}).sort()).toEqual(['cls', 'gname', 'name', 'osis'].sort());
  });

  it('stores the real number when the respondent keeps it, and marks what they changed', async () => {
    const form = await newForm(officer);
    const person = await student();
    const anon = anonFrom();

    const sent = await submit(anon, form.slug, person.email, person.externalId, {
      ...GOOD_ANSWERS,
      gname: 'Sam Formtest',
    });
    expect(sent).toMatchObject({ ok: true, updated: false, first_name: 'Jordan' });

    const [row] = await responses(netrider, form.id);
    expect(row.requester_id).toBe(person.id);
    expect(row.display_name).toBe(person.displayName);
    expect(row.via).toBe('link');
    expect(row.answers.gphone).toBe('(718) 555-0142');
    expect(row.answers.name).toBe(person.displayName);
    expect(row.answers.gname).toBe('Sam Formtest');
    expect(row.changed).toEqual(['gname']);
    // Kept in the form's order, not the order they were ticked.
    expect(row.answers.diet).toEqual(['Vegetarian', 'None']);
    expect(row.answers.sign).toBe('M10 20L30 40L50 20');

    // Answering again replaces rather than adds.
    const again = await submit(anon, form.slug, person.email, person.externalId, {
      ...GOOD_ANSWERS,
      shirt: 'L',
    });
    expect(again).toMatchObject({ ok: true, updated: true });
    const after = await responses(netrider, form.id);
    expect(after).toHaveLength(1);
    expect(after[0].answers.shirt).toBe('L');
    expect(after[0].changed).toEqual([]);
  });

  it('checks the identity again on submit and checks every answer against its question', async () => {
    const form = await newForm(officer);
    const person = await student();
    const anon = anonFrom();

    expect(await submit(anon, form.slug, person.email, '999999999', GOOD_ANSWERS)).toEqual({
      ok: false,
      reason: 'no_match',
    });

    const missing = await rpcFails(anon, 'app_public_form_submit', {
      p_slug: form.slug,
      p_email: person.email,
      p_external_id: person.externalId,
      p_answers: { ...GOOD_ANSWERS, shirt: null },
    });
    expect(missing.message).toContain('Answer "Shirt size"');

    const offList = await rpcFails(anon, 'app_public_form_submit', {
      p_slug: form.slug,
      p_email: person.email,
      p_external_id: person.externalId,
      p_answers: { ...GOOD_ANSWERS, shirt: 'XXL' },
    });
    expect(offList.message).toContain('Choose one of the choices');

    const badSignature = await rpcFails(anon, 'app_public_form_submit', {
      p_slug: form.slug,
      p_email: person.email,
      p_external_id: person.externalId,
      p_answers: { ...GOOD_ANSWERS, sign: '<script>' },
    });
    expect(badSignature.message).toContain('signature could not be read');

    const huge = await rpcFails(anon, 'app_public_form_submit', {
      p_slug: form.slug,
      p_email: person.email,
      p_external_id: person.externalId,
      p_answers: { ...GOOD_ANSWERS, pad: 'x'.repeat(210_000) },
    });
    expect(huge.message).toContain('too long');

    expect(await responses(officer, form.id)).toHaveLength(0);
  });

  it('stops answering identity questions after ten misses from one caller', async () => {
    const form = await newForm(officer);
    const person = await student();
    const noisy = anonFrom();
    for (let at = 0; at < 10; at += 1) {
      expect((await identify(noisy, form.slug, person.email, `00000000${at}`)).reason).toBe('no_match');
    }
    // Even the right answer is refused now, from this caller.
    expect(await identify(noisy, form.slug, person.email, person.externalId)).toEqual({
      ok: false,
      reason: 'throttled',
    });
    expect(await submit(noisy, form.slug, person.email, person.externalId, GOOD_ANSWERS)).toEqual({
      ok: false,
      reason: 'throttled',
    });
    // Somebody else is not.
    expect((await identify(anonFrom(), form.slug, person.email, person.externalId)).ok).toBe(true);
  });

  it('takes an anyone form without an identity, and records nobody', async () => {
    const form = await newForm(officer, {
      audience: 'anyone',
      fields: [
        { id: 'q', type: 'short_text', label: 'Your name', required: true },
        { id: 'go', type: 'yes_no', label: 'Coming?', required: true },
        { id: 'when', type: 'date', label: 'Arriving' },
      ],
    });
    const anon = anonFrom();
    expect(await identify(anon, form.slug, 'a@edison.example', '1')).toEqual({
      ok: false,
      reason: 'not_needed',
    });
    expect(await submit(anon, form.slug, '', '', { q: 'A visitor', go: 'yes', when: '2026-10-02' })).toMatchObject({
      ok: true,
    });
    expect(
      (
        await rpcFails(anon, 'app_public_form_submit', {
          p_slug: form.slug,
          p_email: '',
          p_external_id: '',
          p_answers: { q: 'A visitor', go: 'yes', when: '2026-02-30' },
        })
      ).message,
    ).toContain('real date');

    const [row] = await responses(officer, form.id);
    expect(row.requester_id).toBeNull();
    expect(row.answers).toEqual({ q: 'A visitor', go: true, when: '2026-10-02' });
  });
});

describe('closed and full', () => {
  it('refuses a closed form at both steps, and says so', async () => {
    const form = await newForm(officer);
    const person = await student();
    await rpcOk(officer, 'app_set_form_open', { p_form: form.id, p_open: false });

    const anon = anonFrom();
    const view = await rpcOk<Record<string, unknown>>(anon, 'app_public_form', { p_slug: form.slug });
    expect(view.state).toBe('closed');
    expect(view.fields).toEqual([]);
    expect(await identify(anon, form.slug, person.email, person.externalId)).toEqual({
      ok: false,
      reason: 'closed',
    });
    expect(await submit(anon, form.slug, person.email, person.externalId, GOOD_ANSWERS)).toEqual({
      ok: false,
      reason: 'closed',
    });

    const kinds = (await rawRecordEvents('form', form.id)).map((event) => event.kind);
    expect(kinds).toContain('form_closed');
  });

  it('treats a closing time that has passed as closed', async () => {
    const form = await newForm(officer);
    await settings(officer, form, { closesAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await getForm(officer, form.id)).state).toBe('closed');
    // Reopening by hand clears a date that is already behind it.
    await rpcOk(officer, 'app_set_form_open', { p_form: form.id, p_open: false });
    await rpcOk(officer, 'app_set_form_open', { p_form: form.id, p_open: true });
    expect((await getForm(officer, form.id)).state).toBe('open');
  });

  it('stops at its cap for new people and still lets the first one correct their answers', async () => {
    const form = await newForm(officer);
    await settings(officer, form, { cap: 1 });
    const first = await student();
    const second = await student();
    const anon = anonFrom();

    expect((await submit(anon, form.slug, first.email, first.externalId, GOOD_ANSWERS)).ok).toBe(true);
    expect((await getForm(officer, form.id)).state).toBe('full');
    expect(await submit(anon, form.slug, second.email, second.externalId, GOOD_ANSWERS)).toEqual({
      ok: false,
      reason: 'full',
    });
    expect(
      await submit(anon, form.slug, first.email, first.externalId, { ...GOOD_ANSWERS, shirt: 'S' }),
    ).toMatchObject({ ok: true, updated: true });
    expect(await responses(officer, form.id)).toHaveLength(1);
  });
});

describe('the linked group and event', () => {
  it('puts a matched respondent on the roster and marks them present', async () => {
    const groupId = await rpcOk<string>(officer, 'app_create_group', {
      p_name: `Trip roster ${crypto.randomUUID().slice(0, 8)}`,
      p_description: '',
    });
    const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Departure',
      p_held_on: schoolToday(),
    });
    const form = await newForm(officer);
    // Naming only the event is enough: its group comes with it.
    await settings(officer, form, { event: eventId });
    const linked = await getForm(officer, form.id);
    expect(linked.group_id).toBe(groupId);
    expect(linked.event_id).toBe(eventId);

    const person = await student();
    expect((await submit(anonFrom(), form.slug, person.email, person.externalId, GOOD_ANSWERS)).ok).toBe(true);

    const members = await rpcOk<Array<{ requester_id: string }>>(officer, 'app_group_members', {
      p_group: groupId,
    });
    expect(members.map((row) => row.requester_id)).toContain(person.id);
    const roll = await rpcOk<Array<{ requester_id: string; present: boolean }>>(officer, 'app_event_roll', {
      p_event: eventId,
    });
    expect(roll.find((row) => row.requester_id === person.id)?.present).toBe(true);
  });

  it('refuses an event from a different group than the one named', async () => {
    const one = await rpcOk<string>(officer, 'app_create_group', {
      p_name: `One ${crypto.randomUUID().slice(0, 8)}`,
      p_description: '',
    });
    const two = await rpcOk<string>(officer, 'app_create_group', {
      p_name: `Two ${crypto.randomUUID().slice(0, 8)}`,
      p_description: '',
    });
    const eventOfTwo = await rpcOk<string>(officer, 'app_create_group_event', {
      p_group: two,
      p_name: 'Meeting',
      p_held_on: schoolToday(),
    });
    const form = await newForm(officer);
    const failure = await rpcFails(officer, 'app_save_form_settings', {
      p_form: form.id,
      p_is_open: true,
      p_closes_at: null,
      p_response_cap: null,
      p_audience: 'directory',
      p_group: one,
      p_event: eventOfTwo,
      p_shared: true,
    });
    expect(failure.message).toContain('different group');
  });
});

describe('the kiosk', () => {
  it('finds a person by OSIS on a signed-in device, masks the phone, and records who held it', async () => {
    const form = await newForm(officer);
    const person = await student();

    const found = await rpcOk<Record<string, unknown>>(officer, 'app_form_kiosk_identify', {
      p_form: form.id,
      p_key: person.externalId,
    });
    expect(found.outcome).toBe('match');
    expect(found.requester_id).toBe(person.id);
    expect((found.masked as Record<string, string>).gphone).toBe('••• ••• 0142');
    expect(JSON.stringify(found)).not.toContain('555');

    expect(
      (await rpcOk<Record<string, unknown>>(officer, 'app_form_kiosk_identify', { p_form: form.id, p_key: 'no-such-card' }))
        .outcome,
    ).toBe('no_match');

    await rpcOk(officer, 'app_form_kiosk_submit', {
      p_form: form.id,
      p_requester: person.id,
      p_answers: GOOD_ANSWERS,
    });
    const [row] = await responses(officer, form.id);
    expect(row.via).toBe('kiosk');
    expect(row.recorded_by_name).not.toBeNull();
    expect(row.answers.gphone).toBe('(718) 555-0142');

    expect(
      (await rpcFails(officer, 'app_form_kiosk_submit', { p_form: form.id, p_requester: null, p_answers: {} }))
        .message,
    ).toContain('Scan an ID first');
  });
});

describe('deleting responses', () => {
  it('is open to anybody who can see the form, leaves the roster alone, and logs no name', async () => {
    const groupId = await rpcOk<string>(officer, 'app_create_group', {
      p_name: `Delete roster ${crypto.randomUUID().slice(0, 8)}`,
      p_description: '',
    });
    const form = await newForm(officer);
    await settings(officer, form, { group: groupId });
    const person = await student();
    await submit(anonFrom(), form.slug, person.email, person.externalId, GOOD_ANSWERS);

    const [row] = await responses(netrider, form.id);
    await rpcOk(netrider, 'app_delete_form_response', { p_response: row.id });
    expect(await responses(officer, form.id)).toHaveLength(0);

    const members = await rpcOk<Array<{ requester_id: string }>>(officer, 'app_group_members', {
      p_group: groupId,
    });
    expect(members.map((member) => member.requester_id)).toContain(person.id);

    const logged = (await rawRecordEvents('form', form.id)).find(
      (event) => event.kind === 'form_response_deleted',
    );
    expect(logged).toBeDefined();
    expect(`${logged?.summary} ${logged?.detail ?? ''}`).not.toContain(person.displayName);

    // Somebody who cannot see a private form cannot delete from it either.
    const hidden = await newForm(officer);
    await settings(officer, hidden, { shared: false });
    const other = await student();
    await submit(anonFrom(), hidden.slug, other.email, other.externalId, GOOD_ANSWERS);
    const [hiddenRow] = await responses(officer, hidden.id);
    expect((await rpcFails(unrelated, 'app_delete_form_response', { p_response: hiddenRow.id })).message).toContain(
      'no response with that id',
    );
  });

  it('takes the responses with a deleted form and says how many went', async () => {
    const form = await newForm(officer);
    const person = await student();
    await submit(anonFrom(), form.slug, person.email, person.externalId, GOOD_ANSWERS);
    await rpcOk(officer, 'app_delete_form', { p_form: form.id });

    const { data } = await adminServiceClient().from('form_responses').select('id').eq('form_id', form.id);
    expect(data ?? []).toHaveLength(0);
    const deleted = (await rawRecordEvents('form', form.id)).find((event) => event.kind === 'form_deleted');
    expect(String(deleted?.detail)).toContain('1 response');
  });
});

describe('search', () => {
  it('finds a form by its title for anybody who can see it', async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const form = await newForm(officer, { title: `Museum trip ${marker}` });
    const hits = await rpcOk<Array<{ id: string; title: string }>>(netrider, 'app_search_forms', {
      p_query: `trip ${marker}`.split(' ')[1],
    });
    expect(hits.map((hit) => hit.id)).toContain(form.id);
  });
});
