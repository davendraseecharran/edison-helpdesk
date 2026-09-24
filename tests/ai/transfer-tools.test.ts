/**
 * The four tools that let somebody with ChatGPT hand the assistant a Google
 * Form link, a script's output, a sheet of answers or an event to open.
 *
 * Pinned: who is offered them, which are changes, what reaches the database
 * (the same RPCs the screens call, with the arguments the screens send), and
 * that a form needing a sign-in comes back as the script to hand over rather
 * than as a failure with nothing to do.
 */

import { describe, expect, it } from 'vitest';
import {
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';

const FORM = '66666666-6666-4666-8666-666666666666';
const GROUP = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(results: Record<string, unknown | ((args: Record<string, unknown>) => unknown)> = {}): {
  ctx: ToolContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Sam Example', roles: ['skills_officer'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const SCRIPT_JSON = JSON.stringify({
  source: 'edison-apps-script',
  version: 1,
  title: 'Robotics sign-up',
  description: '',
  items: [
    { type: 'TEXT', title: 'Full name', help: '', required: true },
    { type: 'MULTIPLE_CHOICE', title: 'Team', help: '', required: true, choices: ['Build', 'Code'] },
    { type: 'FILE_UPLOAD', title: 'Photo', help: '' },
  ],
});

const FIELDS = [
  { id: 'name', type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
  { id: 'shirt', type: 'single_choice', label: 'Shirt size', help: '', required: true, options: ['S', 'M'] },
  { id: 'sig', type: 'signature', label: 'Guardian signature', help: '', required: true },
];

const FORMS = [{ id: FORM, slug: 'k3x9q2mfab7p', title: 'Trip sign-up', state: 'open', audience: 'directory' }];
const DETAIL = { id: FORM, slug: 'k3x9q2mfab7p', title: 'Trip sign-up', description: 'Bring lunch.', fields: FIELDS };

describe('who is offered them', () => {
  const names = ['import_google_form', 'google_form_script', 'import_form_responses', 'set_self_checkin'];

  it('gives all four to a skills officer and to a NetRider', () => {
    for (const roles of [['skills_officer'], ['netrider'], ['admin']] as const) {
      const offered = toolsFor([...roles]).map((tool) => tool.name);
      for (const name of names) expect(offered, `${roles} ${name}`).toContain(name);
    }
  });

  it('counts the three that change something as changes, and the script as a read', () => {
    for (const name of ['import_google_form', 'import_form_responses', 'set_self_checkin']) {
      expect(isWriteTool(name)).toBe(true);
      expect(requiresApproval(name, {}, true)).toBe(true);
    }
    expect(isWriteTool('google_form_script')).toBe(false);
    expect(requiresApproval('google_form_script', {}, true)).toBe(false);
  });

  it('refuses an identity setting it does not know', () => {
    expect(validateArgs('set_self_checkin', { group: 'a', event: 'b', on: true, identity: 'face' }).error).toMatch(/identity/);
    expect(validateArgs('import_form_responses', { form: 'Trip' }).error).toMatch(/sheet/);
  });
});

describe('import_google_form', () => {
  it('makes the form from the script’s JSON, with the directory question it names', async () => {
    const { ctx, calls } = context({
      app_create_form: FORM,
      app_get_form: { id: FORM, slug: 'k3x9q2mfab7p' },
    });
    const done = await executeTool('import_google_form', { json: `10:31 AM Info ${SCRIPT_JSON}` }, ctx);
    expect(done.ok).toBe(true);
    const created = calls.find((call) => call.fn === 'app_create_form')!;
    expect(created.args.p_title).toBe('Robotics sign-up');
    expect(created.args.p_audience).toBe('directory');
    const fields = created.args.p_fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => [field.type, field.label, field.directory ?? null])).toEqual([
      ['directory', 'Full name', 'full_name'],
      ['single_choice', 'Team', null],
    ]);
    const result = done.result as Record<string, unknown>;
    expect(result.link).toBe('/f/k3x9q2mfab7p');
    expect(result.not_imported).toEqual(['Photo: File uploads are not taken by these forms.']);
  });

  it('keeps every question as Google had it when asked', async () => {
    const { ctx, calls } = context({ app_create_form: FORM, app_get_form: { id: FORM, slug: 'x' } });
    await executeTool('import_google_form', { json: SCRIPT_JSON, use_directory: false }, ctx);
    const fields = calls.find((call) => call.fn === 'app_create_form')!.args.p_fields as Array<Record<string, unknown>>;
    expect(fields.some((field) => field.type === 'directory')).toBe(false);
    expect(calls.find((call) => call.fn === 'app_create_form')!.args.p_audience).toBe('anyone');
  });

  it('needs exactly one of the link and the JSON, and refuses a link that is not a form', async () => {
    const { ctx, calls } = context();
    expect((await executeTool('import_google_form', {}, ctx)).ok).toBe(false);
    expect((await executeTool('import_google_form', { link: 'https://forms.gle/x1', json: '{}' }, ctx)).ok).toBe(false);
    const refused = await executeTool('import_google_form', { link: 'http://169.254.169.254/latest' }, ctx);
    expect(refused.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('google_form_script', () => {
  it('writes the script for a form and says what will differ', async () => {
    const { ctx } = context({ app_list_forms: FORMS, app_get_form: DETAIL });
    const done = await executeTool('google_form_script', { form: 'Trip' }, ctx);
    expect(done.ok).toBe(true);
    const result = done.result as { script: string; not_the_same: string[]; steps: string[] };
    expect(result.script).toContain('FormApp.create("Trip sign-up")');
    expect(result.script).toContain('form.addTextItem().setTitle("Full name").setRequired(true)');
    expect(result.not_the_same.join(' ')).toContain('signature');
    expect(result.steps[0]).toContain('script.new');
  });
});

describe('import_form_responses', () => {
  it('maps the headings, sends the rows in one batch, and reports the counts', async () => {
    const { ctx, calls } = context({
      app_list_forms: FORMS,
      app_get_form: DETAIL,
      app_import_form_responses: (args: Record<string, unknown>) =>
        (args.p_rows as unknown[]).map((_, at) => ({
          row_index: at + 1,
          outcome: at === 0 ? 'made' : 'skipped',
          message: at === 0 ? null : 'Already imported.',
        })),
    });
    const sheet = 'Timestamp\tFull name\tShirt size\tColour\n9/23/2026 14:05\tNia Example\tM\tblue\n9/23/2026 14:06\tJo Example\tS\tred\n9/23/2026 14:07\tAl Example\tXL\t';
    const done = await executeTool('import_form_responses', { form: 'Trip sign-up', sheet }, ctx);
    expect(done.ok).toBe(true);
    const sent = calls.find((call) => call.fn === 'app_import_form_responses')!;
    expect(sent.args.p_form).toBe(FORM);
    expect(sent.args.p_rows).toEqual([
      {
        submitted_at: '2026-09-23T18:05:00.000Z',
        email: null,
        external_id: null,
        name: 'Nia Example',
        answers: { name: 'Nia Example', shirt: 'M' },
      },
      {
        submitted_at: '2026-09-23T18:06:00.000Z',
        email: null,
        external_id: null,
        name: 'Jo Example',
        answers: { name: 'Jo Example', shirt: 'S' },
      },
    ]);
    expect(done.result).toMatchObject({
      imported: 1,
      already_here: 1,
      refused_count: 1,
      columns_left_out: ['Colour'],
    });
    expect((done.result as { refused: string[] }).refused[0]).toContain('Row 4');
  });

  it('says which headings it could not place rather than guessing', async () => {
    const { ctx, calls } = context({ app_list_forms: FORMS, app_get_form: DETAIL });
    const done = await executeTool('import_form_responses', { form: 'Trip', sheet: 'When\tColour\nyesterday\tblue' }, ctx);
    expect(done.ok).toBe(false);
    expect(done.summary).toContain('Shirt size');
    expect(calls.some((call) => call.fn === 'app_import_form_responses')).toBe(false);
  });
});

describe('set_self_checkin', () => {
  const settings = {
    event_id: EVENT,
    slug: 'k3x9q2mfab7p',
    is_open: true,
    identity: 'either',
    walk_ins: true,
    state: 'open',
    held_on: '2026-09-24',
    present_count: 0,
    self_count: 0,
    member_count: 12,
  };
  const results = {
    app_list_groups: [{ id: GROUP, name: 'SkillsUSA', description: '', member_count: 12 }],
    app_list_group_events: [{ id: EVENT, name: 'Weekly meeting', held_on: '2026-09-24' }],
    app_set_event_checkin: settings,
    app_event_checkin: null,
  };

  it('opens it and answers the link and the poster', async () => {
    const { ctx, calls } = context(results);
    const done = await executeTool(
      'set_self_checkin',
      { group: 'SkillsUSA', event: 'Weekly meeting', on: true, walk_ins: true },
      ctx,
    );
    expect(done.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_set_event_checkin')!.args).toEqual({
      p_event: EVENT,
      p_open: true,
      p_identity: null,
      p_walk_ins: true,
    });
    expect(done.result).toMatchObject({
      link: '/c/k3x9q2mfab7p',
      poster: `/print/checkin/${EVENT}`,
      people_type: 'OSIS or name',
      state: 'Open',
    });
  });

  it('does not make a closed check-in for an event that never had one', async () => {
    const { ctx, calls } = context(results);
    const done = await executeTool('set_self_checkin', { group: 'SkillsUSA', event: 'Weekly meeting', on: false }, ctx);
    expect(done.ok).toBe(true);
    expect(calls.some((call) => call.fn === 'app_set_event_checkin')).toBe(false);
  });
});
