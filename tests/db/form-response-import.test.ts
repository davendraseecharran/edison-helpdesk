/**
 * Responses from a Google Sheet, taken into a form.
 *
 * What these hold:
 *
 * 1. WHO ANSWERED is found by OSIS, then email, then name; a row that names
 *    nobody, or two people, still comes in, unmatched.
 * 2. THE SAME SHEET TWICE IS ONE SHEET. Every row of a second import is
 *    skipped; a newer row for somebody replaces their older answer and an
 *    older one never replaces a newer.
 * 3. A BAD ROW TAKES NOTHING WITH IT: it is refused with the question named,
 *    and the rest of the batch lands.
 * 4. A MATCHED ROW DOES WHAT THE FORM DOES: it fills the linked roster and
 *    marks the linked event.
 * 5. The doors: signed-in only, and only for a form the caller can see.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  schoolToday,
  seedRequester,
  signIn,
} from './support/harness';

interface Outcome {
  row_index: number;
  outcome: string;
  response_id: string | null;
  person_id: string | null;
  message: string | null;
}

interface ResponseRow {
  id: string;
  requester_id: string | null;
  answers: Record<string, unknown>;
  via: string;
  submitted_at: string;
  recorded_by_name: string | null;
}

let officer: SupabaseClient;
let netrider: SupabaseClient;

const FIELDS = [
  { id: 'name', type: 'directory', directory: 'full_name', label: 'Full name' },
  { id: 'shirt', type: 'single_choice', label: 'Shirt size', options: ['S', 'M', 'L'], required: true },
  { id: 'diet', type: 'multi_choice', label: 'Dietary needs', options: ['Vegetarian', 'Halal', 'None'] },
  { id: 'bus', type: 'yes_no', label: 'Taking the bus', required: true },
];

function tag(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join('');
}

async function newForm(client: SupabaseClient = officer): Promise<string> {
  return rpcOk<string>(client, 'app_create_form', {
    p_title: `Imported trip ${tag()}`,
    p_fields: FIELDS,
    p_audience: 'directory',
  });
}

async function importRows(client: SupabaseClient, formId: string, rows: unknown[]): Promise<Outcome[]> {
  return rpcOk<Outcome[]>(client, 'app_import_form_responses', { p_form: formId, p_rows: rows });
}

async function responses(formId: string): Promise<ResponseRow[]> {
  return rpcOk<ResponseRow[]>(officer, 'app_form_responses', { p_form: formId });
}

beforeAll(async () => {
  officer = await signIn('skillsOfficer');
  netrider = await signIn('owner');
});

describe('who answered', () => {
  it('matches by OSIS, then email, then name, and takes the rest unmatched', async () => {
    const t = tag();
    const byId = await seedRequester('student', { first_name: 'Ada', last_name: `Byid${t}`, display_name: `Ada Byid${t}` });
    const byEmail = await seedRequester('student', {
      first_name: 'Bo',
      last_name: `Byemail${t}`,
      display_name: `Bo Byemail${t}`,
      email: `bo.${t}@edison.example`,
    });
    const byName = await seedRequester('student', { first_name: 'Cy', last_name: `Byname${t}`, display_name: `Cy Byname${t}` });
    await seedRequester('student', { display_name: `Dee Twice${t}` });
    await seedRequester('student', { display_name: `Dee Twice${t}` });
    const formId = await newForm();

    const preview = await rpcOk<Array<{ row_index: number; state: string; person_id: string | null }>>(
      officer,
      'app_match_form_respondents',
      {
        p_form: formId,
        p_rows: [
          { external_id: ` ${byId.externalId} ` },
          { email: `BO.${t}@EDISON.EXAMPLE` },
          { name: `cy  BYNAME${t}` },
          { name: `Dee Twice${t}` },
          { name: 'Nobody Here', email: 'nobody@edison.example' },
        ],
      },
    );
    expect(preview.map((row) => [row.row_index, row.state, row.person_id])).toEqual([
      [1, 'match', byId.id],
      [2, 'match', byEmail.id],
      [3, 'match', byName.id],
      [4, 'ambiguous', null],
      [5, 'none', null],
    ]);

    const outcomes = await importRows(officer, formId, [
      { submitted_at: '2026-09-01T13:00:00Z', external_id: byId.externalId, answers: { shirt: 'M', bus: true } },
      { submitted_at: '2026-09-01T13:05:00Z', email: `bo.${t}@edison.example`, answers: { shirt: 'S', bus: false } },
      { submitted_at: '2026-09-01T13:10:00Z', name: `Cy Byname${t}`, answers: { shirt: 'L', diet: ['Halal', 'Vegetarian'], bus: true } },
      { submitted_at: '2026-09-01T13:15:00Z', name: `Dee Twice${t}`, answers: { name: `Dee Twice${t}`, shirt: 'M', bus: true } },
    ]);
    expect(outcomes.map((row) => row.outcome)).toEqual(['made', 'made', 'made', 'made']);
    expect(outcomes.map((row) => row.person_id)).toEqual([byId.id, byEmail.id, byName.id, null]);

    const stored = await responses(formId);
    expect(stored).toHaveLength(4);
    for (const row of stored) {
      expect(row.via).toBe('import');
      expect(row.recorded_by_name).not.toBeNull();
    }
    const cy = stored.find((row) => row.requester_id === byName.id)!;
    // The sheet's time is kept, and choices come back in the form's order.
    expect(new Date(cy.submitted_at).toISOString()).toBe('2026-09-01T13:10:00.000Z');
    expect(cy.answers.diet).toEqual(['Vegetarian', 'Halal']);

    const history = await rawRecordEvents('form', formId);
    const imported = history.find((event) => event.kind === 'form_import');
    expect(imported?.summary).toContain('Imported 4 responses');
  });
});

describe('the same sheet twice', () => {
  it('skips every row the second time, and lets only a newer row replace an answer', async () => {
    const t = tag();
    const person = await seedRequester('student', { display_name: `Eve Again${t}` });
    const formId = await newForm();
    const rows = [
      { submitted_at: '2026-09-02T14:00:00Z', external_id: person.externalId, answers: { shirt: 'M', bus: true } },
      { submitted_at: '2026-09-02T14:01:00Z', name: 'A visitor', answers: { shirt: 'S', bus: false } },
    ];
    expect((await importRows(officer, formId, rows)).map((row) => row.outcome)).toEqual(['made', 'made']);
    const again = await importRows(officer, formId, rows);
    expect(again.map((row) => row.outcome)).toEqual(['skipped', 'skipped']);
    expect(again[0].message).toBe('Already imported.');
    expect(await responses(formId)).toHaveLength(2);

    // An older answer from the same person does not win.
    const older = await importRows(officer, formId, [
      { submitted_at: '2026-09-01T09:00:00Z', external_id: person.externalId, answers: { shirt: 'L', bus: true } },
    ]);
    expect(older[0].outcome).toBe('skipped');

    // A newer one does, and stays one response.
    const newer = await importRows(officer, formId, [
      { submitted_at: '2026-09-03T09:00:00Z', external_id: person.externalId, answers: { shirt: 'L', bus: true } },
    ]);
    expect(newer[0].outcome).toBe('updated');
    const mine = (await responses(formId)).filter((row) => row.requester_id === person.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].answers.shirt).toBe('L');
    expect(new Date(mine[0].submitted_at).toISOString()).toBe('2026-09-03T09:00:00.000Z');
  });
});

describe('a bad row', () => {
  it('is refused with the question named, and the rest of the batch lands', async () => {
    const formId = await newForm();
    const outcomes = await importRows(officer, formId, [
      { submitted_at: '2026-09-04T10:00:00Z', name: 'Visitor one', answers: { shirt: 'XXL', bus: true } },
      { submitted_at: '2026-09-04T10:01:00Z', name: 'Visitor two', answers: { shirt: 'M' } },
      { submitted_at: '2099-01-01T00:00:00Z', name: 'Visitor three', answers: { shirt: 'M', bus: true } },
      { submitted_at: 'last Tuesday', name: 'Visitor four', answers: { shirt: 'M', bus: true } },
    ]);
    expect(outcomes.map((row) => row.outcome)).toEqual(['refused', 'made', 'refused', 'refused']);
    expect(outcomes[0].message).toContain('Shirt size');
    expect(outcomes[2].message).toContain('future');
    expect(outcomes[3].message).toContain('not a date');
    // "Taking the bus" is required on the form, and row two left it empty: a
    // row sent before a question was required is not refused for it.
    expect(await responses(formId)).toHaveLength(1);
  });
});

describe('what a matched row does', () => {
  it('fills the linked roster and marks the linked event, for matched rows only', async () => {
    const t = tag();
    const person = await seedRequester('student', { display_name: `Fay Linked${t}` });
    const formId = await newForm();
    const groupId = await rpcOk<string>(officer, 'app_create_group', { p_name: `Trip ${t}`, p_description: '' });
    const eventId = await rpcOk<string>(officer, 'app_create_group_event', {
      p_group: groupId,
      p_name: 'Departure',
      p_held_on: schoolToday(),
    });
    await rpcOk(officer, 'app_save_form_settings', {
      p_form: formId,
      p_is_open: true,
      p_closes_at: null,
      p_response_cap: null,
      p_audience: 'directory',
      p_group: groupId,
      p_event: eventId,
      p_shared: true,
    });

    await importRows(officer, formId, [
      { submitted_at: '2026-09-05T08:00:00Z', external_id: person.externalId, answers: { shirt: 'S', bus: true } },
      { submitted_at: '2026-09-05T08:01:00Z', name: 'Nobody Known', answers: { shirt: 'S', bus: true } },
    ]);

    const service = adminServiceClient();
    const members = await service.from('people_group_members').select('requester_id').eq('group_id', groupId);
    expect((members.data ?? []).map((row) => row.requester_id)).toEqual([person.id]);
    const attendance = await service.from('group_attendance').select('requester_id').eq('event_id', eventId);
    expect((attendance.data ?? []).map((row) => row.requester_id)).toEqual([person.id]);
  });
});

describe('the doors', () => {
  it('is closed to anonymous callers and to a private form that is not yours', async () => {
    const formId = await newForm();
    const anon = anonClient();
    expect((await rpcFails(anon, 'app_import_form_responses', { p_form: formId, p_rows: [] })).message).not.toBe('');
    expect((await rpcFails(anon, 'app_match_form_respondents', { p_form: formId, p_rows: [] })).message).not.toBe('');
    expect((await rpcFails(anon, 'app_form_import_match', { p_email: 'a', p_external_id: 'b', p_name: 'c' })).message).not.toBe('');

    await rpcOk(officer, 'app_save_form_settings', {
      p_form: formId,
      p_is_open: true,
      p_closes_at: null,
      p_response_cap: null,
      p_audience: 'directory',
      p_group: null,
      p_event: null,
      p_shared: false,
    });
    expect(
      (await rpcFails(netrider, 'app_import_form_responses', { p_form: formId, p_rows: [{ answers: { shirt: 'S' } }] }))
        .message,
    ).toContain('no form with that id');
  });

  it('refuses an empty or oversized batch', async () => {
    const formId = await newForm();
    expect((await rpcFails(officer, 'app_import_form_responses', { p_form: formId, p_rows: [] })).message).toContain(
      'no rows',
    );
    const many = Array.from({ length: 201 }, () => ({ answers: { shirt: 'S' } }));
    expect((await rpcFails(officer, 'app_import_form_responses', { p_form: formId, p_rows: many })).message).toContain(
      'at most 200',
    );
  });
});
