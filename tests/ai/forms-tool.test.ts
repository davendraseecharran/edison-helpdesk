/**
 * The four form tools.
 *
 * What is pinned here is what an assistant can get wrong about a form:
 *
 *   1. A form is named out loud, so it is resolved rather than guessed, and a
 *      title that matches two forms is a question with both titles in it.
 *   2. The questions it writes reach `app_create_form` with ids the database
 *      accepts, the types it asked for, and nothing a question of that type
 *      does not take. A directory question that names no fact never leaves.
 *   3. Responses come back as text keyed by the question, with a signature as
 *      "Signed" and never as the drawing.
 *   4. A skills officer, who runs the chapter's sign-ups, is offered all four.
 */

import { describe, expect, it } from 'vitest';
import {
  describeCall,
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';

const FORM = '66666666-6666-4666-8666-666666666666';
const OTHER_FORM = '77777777-7777-4777-8777-777777777777';
const PERSON = '55555555-5555-4555-8555-555555555555';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** The stub the other tool suites use: every RPC answers from a table, or null. */
function context(
  options: {
    results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
    roles?: string[];
  } = {},
): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const results = options.results ?? {};
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Sam Example', roles: options.roles ?? ['skills_officer'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const FORMS = [
  {
    id: FORM,
    slug: 'k3x9q2mf',
    title: 'Trip sign-up',
    description: 'The museum trip.',
    state: 'open',
    audience: 'directory',
    response_count: 2,
    last_response_at: '2026-09-22T14:00:00Z',
    shared: true,
    mine: true,
    owner_name: 'Sam Example',
    group_name: 'Officers',
    updated_at: '2026-09-22T14:00:00Z',
  },
  {
    id: OTHER_FORM,
    slug: 'p8w2m4zt',
    title: 'Trip sign-up (spring)',
    description: '',
    state: 'closed',
    audience: 'anyone',
    response_count: 0,
    last_response_at: null,
    shared: true,
    mine: false,
    owner_name: 'Nia Example',
    group_name: null,
    updated_at: '2026-09-20T14:00:00Z',
  },
];

const FIELDS = [
  { id: 'name1', type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
  { id: 'diet1', type: 'multi_choice', label: 'Dietary needs', help: '', required: false, options: ['Vegan', 'Halal'] },
  { id: 'bus01', type: 'yes_no', label: 'Taking the bus', help: '', required: true },
  { id: 'sig01', type: 'signature', label: 'Guardian signature', help: '', required: true },
];

const DETAIL = { id: FORM, slug: 'k3x9q2mf', title: 'Trip sign-up', fields: FIELDS, state: 'open' };

const RESPONSES = [
  {
    id: 'r2',
    requester_id: PERSON,
    display_name: 'Priya Raman',
    external_id: '230045611',
    answers: { name1: 'Priya Raman', diet1: ['Vegan', 'Halal'], bus01: true, sig01: 'M1 1L20 20' },
    changed: [],
    via: 'link',
    submitted_at: '2026-09-22T14:00:00Z',
    recorded_by_name: null,
  },
  {
    id: 'r1',
    requester_id: null,
    display_name: null,
    external_id: null,
    answers: { name1: 'A visitor', diet1: ['Vegan'], bus01: false, sig01: 'M2 2L9 9' },
    changed: [],
    via: 'kiosk',
    submitted_at: '2026-09-21T14:00:00Z',
    recorded_by_name: 'Sam Example',
  },
];

describe('what the form tools are offered to', () => {
  it('gives all four to a skills officer, who runs the chapter sign-ups', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of ['list_forms', 'form_responses', 'create_form', 'set_form_open']) {
      expect(names).toContain(name);
    }
  });

  it('gives them to a NetRider too', () => {
    const names = toolsFor(['netrider']).map((tool) => tool.name);
    for (const name of ['list_forms', 'form_responses', 'create_form', 'set_form_open']) {
      expect(names).toContain(name);
    }
  });

  it('counts making and opening a form as changes, and reading as reads', () => {
    for (const name of ['create_form', 'set_form_open']) {
      expect(isWriteTool(name)).toBe(true);
      expect(requiresApproval(name, {}, true)).toBe(true);
      expect(requiresApproval(name, {}, false)).toBe(false);
    }
    for (const name of ['list_forms', 'form_responses']) {
      expect(isWriteTool(name)).toBe(false);
      expect(requiresApproval(name, {}, true)).toBe(false);
    }
  });
});

describe('arguments', () => {
  it('needs the form named and the switch given', () => {
    expect(validateArgs('form_responses', {}).error).toMatch(/form/);
    expect(validateArgs('set_form_open', { form: 'Trip' }).error).toMatch(/open/);
    expect(validateArgs('create_form', {}).error).toMatch(/title/);
  });

  it('refuses a question type or directory fact it does not know', () => {
    expect(
      validateArgs('create_form', { title: 'Trip', questions: [{ type: 'essay', label: 'Why' }] }).ok,
    ).toBe(false);
    expect(
      validateArgs('create_form', { title: 'Trip', questions: [{ type: 'directory', directory: 'shoe_size' }] }).ok,
    ).toBe(false);
    expect(validateArgs('create_form', { title: 'Trip', who_can_answer: 'everyone' }).ok).toBe(false);
  });

  it('refuses more questions than a form holds', () => {
    const questions = Array.from({ length: 61 }, (_, at) => ({ type: 'short_text', label: `Q${at}` }));
    expect(validateArgs('create_form', { title: 'Trip', questions }).ok).toBe(false);
  });
});

describe('resolving a form', () => {
  it('refuses a title that matches two forms, naming both', async () => {
    const { ctx, calls } = context({ results: { app_list_forms: FORMS } });
    const result = await executeTool('set_form_open', { form: 'trip', open: false }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Trip sign-up');
    expect(result.summary).toContain('Trip sign-up (spring)');
    expect(calls.some((call) => call.fn === 'app_set_form_open')).toBe(false);
  });

  it('takes an exact title over a longer one that contains it', async () => {
    const { ctx, calls } = context({ results: { app_list_forms: FORMS } });
    const result = await executeTool('set_form_open', { form: 'Trip sign-up', open: false }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Closed Trip sign-up');
    expect(calls.find((call) => call.fn === 'app_set_form_open')?.args).toEqual({
      p_form: FORM,
      p_open: false,
    });
  });

  it('takes an id, and refuses one it cannot see', async () => {
    const { ctx, calls } = context({ results: { app_list_forms: FORMS } });
    const opened = await executeTool('set_form_open', { form: OTHER_FORM, open: true }, ctx);
    expect(opened.summary).toBe('Opened Trip sign-up (spring)');
    expect(calls.find((call) => call.fn === 'app_set_form_open')?.args).toEqual({
      p_form: OTHER_FORM,
      p_open: true,
    });

    const missing = await executeTool(
      'set_form_open',
      { form: '88888888-8888-4888-8888-888888888888', open: true },
      ctx,
    );
    expect(missing.ok).toBe(false);
  });
});

describe('list_forms', () => {
  it('answers each form with its state, count, audience, link and group', async () => {
    const { ctx } = context({ results: { app_list_forms: FORMS } });
    const result = await executeTool('list_forms', {}, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Listed 2 forms.');
    const [first, second] = result.result as Array<Record<string, unknown>>;
    expect(first).toMatchObject({
      title: 'Trip sign-up',
      state: 'Open',
      responses: 2,
      who_can_answer: 'People in the directory',
      link: '/f/k3x9q2mf',
      page: `/forms/${FORM}`,
      group: 'Officers',
    });
    expect(second).toMatchObject({ state: 'Closed', who_can_answer: 'Anyone with the link', group: null });
  });
});

describe('form_responses', () => {
  it('summarises the choices and lists each answer as text by question', async () => {
    const { ctx, calls } = context({
      results: { app_list_forms: FORMS, app_get_form: DETAIL, app_form_responses: RESPONSES },
    });
    const result = await executeTool('form_responses', { form: 'Trip sign-up' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Read Trip sign-up: 2 responses.');
    expect(calls.find((call) => call.fn === 'app_form_responses')?.args).toEqual({ p_form: FORM });

    const answer = result.result as {
      summary: { responses: number; matched_to_directory: number; questions: unknown[] };
      responses: Array<{ respondent: string; via: string; answers: Record<string, string> }>;
      note?: string;
    };
    expect(answer.summary.responses).toBe(2);
    expect(answer.summary.matched_to_directory).toBe(1);
    expect(answer.summary.questions).toEqual([
      {
        question: 'Dietary needs',
        counts: [
          { option: 'Vegan', count: 2 },
          { option: 'Halal', count: 1 },
        ],
      },
      {
        question: 'Taking the bus',
        counts: [
          { option: 'Yes', count: 1 },
          { option: 'No', count: 1 },
        ],
      },
    ]);
    expect(answer.responses[0]).toMatchObject({
      respondent: 'Priya Raman',
      via: 'Link',
      answers: {
        'Full name': 'Priya Raman',
        'Dietary needs': 'Vegan, Halal',
        'Taking the bus': 'Yes',
        'Guardian signature': 'Signed',
      },
    });
    expect(answer.responses[1].via).toBe('Kiosk');
    expect(answer.note).toBeUndefined();
  });

  it('never hands back a signature drawing', async () => {
    const { ctx } = context({
      results: { app_list_forms: FORMS, app_get_form: DETAIL, app_form_responses: RESPONSES },
    });
    const result = await executeTool('form_responses', { form: FORM }, ctx);
    expect(JSON.stringify(result.result)).not.toContain('M1 1L20 20');
    expect(JSON.stringify(result.result)).not.toContain('M2 2L9 9');
  });

  it('lists at most 200 responses and says so, while the counts cover all', async () => {
    const many = Array.from({ length: 230 }, (_, at) => ({
      ...RESPONSES[1],
      id: `r${at}`,
    }));
    const { ctx } = context({
      results: { app_list_forms: FORMS, app_get_form: DETAIL, app_form_responses: many },
    });
    const result = await executeTool('form_responses', { form: FORM }, ctx);
    const answer = result.result as { summary: { responses: number }; responses: unknown[]; note: string };
    expect(answer.responses).toHaveLength(200);
    expect(answer.summary.responses).toBe(230);
    expect(answer.note).toMatch(/200 of 230/);
  });
});

describe('create_form', () => {
  it('sends clean questions with fresh ids and reads back the link', async () => {
    const { ctx, calls } = context({
      results: {
        app_create_form: FORM,
        app_get_form: { ...DETAIL, fields: [] },
      },
    });
    const result = await executeTool(
      'create_form',
      {
        title: 'Trip sign-up',
        description: 'The museum trip.',
        who_can_answer: 'anyone',
        questions: [
          { type: 'directory', directory: 'full_name', required: true },
          { type: 'single_choice', label: 'Lunch', options: ['Pizza', ' Pizza ', 'Salad'] },
          // Choices on a question that takes none are dropped, not sent.
          { type: 'short_text', label: 'Anything else', options: ['stray'], directory: 'email' },
          { type: 'signature', label: 'Guardian signature', required: true },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Created the form Trip sign-up');
    expect(result.result).toEqual({
      id: FORM,
      title: 'Trip sign-up',
      questions: 4,
      page: `/forms/${FORM}`,
      link: '/f/k3x9q2mf',
    });

    const sent = calls.find((call) => call.fn === 'app_create_form')?.args as Record<string, unknown>;
    expect(sent.p_title).toBe('Trip sign-up');
    expect(sent.p_description).toBe('The museum trip.');
    expect(sent.p_audience).toBe('anyone');
    const fields = sent.p_fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.type)).toEqual(['directory', 'single_choice', 'short_text', 'signature']);
    for (const field of fields) expect(field.id).toMatch(/^[a-z0-9]{1,16}$/);
    expect(new Set(fields.map((field) => field.id)).size).toBe(4);
    expect(fields[0]).toMatchObject({ directory: 'full_name', label: 'Full name', required: true });
    expect(fields[1]).toMatchObject({ label: 'Lunch', options: ['Pizza', 'Salad'], required: false });
    expect(fields[2].options).toBeUndefined();
    expect(fields[2].directory).toBeUndefined();

    expect(calls.find((call) => call.fn === 'app_get_form')?.args).toEqual({ p_form: FORM });
  });

  it('defaults to the directory and to no questions', async () => {
    const { ctx, calls } = context({ results: { app_create_form: FORM, app_get_form: DETAIL } });
    await executeTool('create_form', { title: 'Check in' }, ctx);
    expect(calls.find((call) => call.fn === 'app_create_form')?.args).toEqual({
      p_title: 'Check in',
      p_description: '',
      p_fields: [],
      p_audience: 'directory',
    });
  });

  it('refuses a question it cannot write before anything is sent', async () => {
    for (const questions of [
      [{ type: 'directory' }],
      [{ type: 'dropdown', label: 'Size' }],
      [{ type: 'short_text' }],
      [
        { type: 'directory', directory: 'email' },
        { type: 'directory', directory: 'email' },
      ],
    ]) {
      const { ctx, calls } = context({ results: { app_create_form: FORM } });
      const result = await executeTool('create_form', { title: 'Trip', questions }, ctx);
      expect(result.ok, JSON.stringify(questions)).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it('names the sheet of questions by its first label on an approval card', () => {
    expect(
      describeCall('create_form', {
        title: 'Trip',
        questions: [{ type: 'short_text', label: 'Lunch' }],
      }),
    ).toContain('1 row, starting "Lunch"');
  });
});
