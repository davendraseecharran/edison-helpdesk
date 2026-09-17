/**
 * The rest of a group's page, as the assistant reaches it: the name and the
 * line under it, the note beside a member, the checklist columns, the events,
 * a whole column ticked at once, and a wrong tick on a register taken back.
 *
 * Same contract as the other roster suites: a group, an event and a column
 * are resolved rather than guessed, only the people the directory matched are
 * written, the numbers are the database's, and deleting a group is the one
 * thing on the page that is an administrator's and asks first.
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

const GROUP = '33333333-3333-4333-8333-333333333333';
const EVENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const FIELD_DUES = 'bbbbbbbb-1111-4111-8111-111111111111';
const FIELD_SLIP = 'bbbbbbbb-2222-4222-8222-222222222222';
const NIA = 'cccccccc-1111-4111-8111-111111111111';
const ARI = 'cccccccc-2222-4222-8222-222222222222';
const SAM = 'cccccccc-3333-4333-8333-333333333333';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(
  options: {
    results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
    roles?: string[];
    fail?: (fn: string, args: Record<string, unknown>) => { code: string; message: string } | null;
  } = {},
): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const failure = options.fail?.(fn, args) ?? null;
        if (failure !== null) return { data: null, error: failure };
        const results = options.results ?? {};
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Sam Example', roles: options.roles ?? ['skills_officer'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const GROUPS = [
  { id: GROUP, name: 'Officers', description: 'The chapter officers.', member_count: 3 },
];
const FIELDS = [
  { id: FIELD_DUES, name: 'Dues', position: 0, checked_count: 1 },
  { id: FIELD_SLIP, name: 'Permission slip', position: 1, checked_count: 0 },
];
const EVENTS = [{ id: EVENT, name: 'Weekly meeting', held_on: '2026-09-15', present_count: 2 }];

function person(key: string, id: string, name: string) {
  return { key, found: 'match', matches: 1, id, display_name: name, kind: 'student', group_label: '9A' };
}

const findPeople = (args: Record<string, unknown>) =>
  (args.p_keys as string[]).map((key) => {
    if (key === '230020049') return person(key, NIA, 'Nia Okonkwo');
    if (key === 'ari@edison.example') return person(key, ARI, 'Ari Example');
    if (key === 'Sam Outsider') return person(key, SAM, 'Sam Outsider');
    if (key === 'Alex Common') return { key, found: 'ambiguous', matches: 2, id: null, display_name: null, kind: null };
    return { key, found: 'none', matches: 0, id: null, display_name: null, kind: null };
  });

/** `app_list_people`, answering one student for one name. */
const directory = (args: Record<string, unknown>) => {
  const query = String(args.p_query ?? '').toLowerCase();
  const rows =
    args.p_kind === 'student' && 'nia okonkwo'.includes(query)
      ? [{ id: NIA, displayName: 'Nia Okonkwo', email: 'nia@edison.example', externalId: '230020049' }]
      : [];
  return { rows, total: rows.length };
};

describe('who is offered what', () => {
  it('gives every roster tool but deletion to a skills officer', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of [
      'update_group',
      'set_group_member_note',
      'save_group_field',
      'delete_group_field',
      'set_checklist_marks',
      'create_group_event',
      'delete_group_event',
    ]) {
      expect(names).toContain(name);
      expect(isWriteTool(name)).toBe(true);
      expect(requiresApproval(name, {}, false)).toBe(false);
    }
    expect(names).not.toContain('delete_group');
  });

  it('makes deleting a group an administrator’s, and it always asks', () => {
    expect(toolsFor(['admin']).map((tool) => tool.name)).toContain('delete_group');
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('delete_group');
    expect(requiresApproval('delete_group', { group: 'Officers' }, false)).toBe(true);
  });
});

describe('update_group', () => {
  it('renames, keeping the description it did not touch', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('update_group', { group: 'Officers', name: 'Chapter officers' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_update_group')?.args).toEqual({
      p_group: GROUP,
      p_name: 'Chapter officers',
      p_description: 'The chapter officers.',
    });
    expect(result.summary).toBe('Renamed Officers to Chapter officers');
  });

  it('rewrites the description alone', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('update_group', { group: GROUP, description: 'Elected each June.' }, ctx);
    expect(calls.find((call) => call.fn === 'app_update_group')?.args).toEqual({
      p_group: GROUP,
      p_name: 'Officers',
      p_description: 'Elected each June.',
    });
    expect(result.summary).toBe('Updated Officers');
  });

  it('refuses a call with nothing to change, and a name too long for the column', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('update_group', { group: 'Officers' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/what to change/);
    expect(calls.map((call) => call.fn)).not.toContain('app_update_group');
    expect(validateArgs('update_group', { group: 'Officers', name: 'x'.repeat(81) }).ok).toBe(false);
  });
});

describe('set_group_member_note', () => {
  it('writes the note beside the one member', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_list_people: directory } });
    const result = await executeTool(
      'set_group_member_note',
      { group: 'Officers', person: 'Nia Okonkwo', note: ' treasurer ' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_set_group_member_note')?.args).toEqual({
      p_group: GROUP,
      p_requester: NIA,
      p_note: 'treasurer',
    });
    expect(result.summary).toBe('Noted "treasurer" beside Nia Okonkwo in Officers');
  });

  it('clears it when the note is left out', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        // An id skips the search and reads the record instead.
        app_get_person: { id: NIA, displayName: 'Nia Okonkwo', kind: 'student' },
      },
    });
    const result = await executeTool('set_group_member_note', { group: 'Officers', person: NIA }, ctx);
    expect(calls.find((call) => call.fn === 'app_set_group_member_note')?.args.p_note).toBe('');
    expect(result.summary).toMatch(/^Cleared the note beside/);
  });

  it('holds the note to the cell', () => {
    expect(validateArgs('set_group_member_note', { group: 'g', person: 'p', note: 'x'.repeat(81) }).ok).toBe(false);
  });
});

describe('save_group_field and delete_group_field', () => {
  it('adds a column at the end', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS, app_save_group_field: 'field-3' },
    });
    const result = await executeTool('save_group_field', { group: 'Officers', name: 'Shirt size' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_save_group_field')?.args).toEqual({
      p_field: null,
      p_group: GROUP,
      p_name: 'Shirt size',
      p_position: 2,
    });
    expect(result.summary).toBe('Added the column Shirt size to Officers');
  });

  it('renames an existing column, keeping its place', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS, app_save_group_field: FIELD_SLIP },
    });
    const result = await executeTool(
      'save_group_field',
      { group: 'Officers', column: 'permission', name: 'Trip permission' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_save_group_field')?.args).toEqual({
      p_field: FIELD_SLIP,
      p_group: GROUP,
      p_name: 'Trip permission',
      p_position: 1,
    });
    expect(result.summary).toBe('Renamed the column Permission slip to Trip permission on Officers');
  });

  it('removes a column by name', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS } });
    const result = await executeTool('delete_group_field', { group: 'Officers', column: 'Dues' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_delete_group_field')?.args).toEqual({ p_field: FIELD_DUES });
    expect(result.summary).toBe('Removed the column Dues from Officers');
  });

  it('names the columns there are when asked for one that is not', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS } });
    const result = await executeTool('delete_group_field', { group: 'Officers', column: 'Hoodie' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Permission slip');
    expect(calls.map((call) => call.fn)).not.toContain('app_delete_group_field');
    expect(validateArgs('save_group_field', { group: 'g', name: 'x'.repeat(41) }).ok).toBe(false);
  });
});

describe('set_checklist_marks', () => {
  it('ticks every member the directory matched and counts the rest by kind', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS, app_find_people: findPeople },
      fail: (fn, args) =>
        fn === 'app_set_group_mark' && args.p_requester === SAM
          ? { code: '23514', message: 'That person is not in Officers. Add them to the group first.' }
          : null,
    });
    const result = await executeTool(
      'set_checklist_marks',
      {
        group: 'Officers',
        column: 'dues',
        people: ['230020049', 'ari@edison.example', 'Sam Outsider', 'Nobody Here', 'Alex Common'],
        checked: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const marks = calls.filter((call) => call.fn === 'app_set_group_mark');
    expect(marks.map((call) => call.args)).toEqual([
      { p_field: FIELD_DUES, p_requester: NIA, p_checked: true },
      { p_field: FIELD_DUES, p_requester: ARI, p_checked: true },
      { p_field: FIELD_DUES, p_requester: SAM, p_checked: true },
    ]);
    expect(result.result).toEqual({
      changed: 2,
      not_member: 1,
      unmatched: ['Nobody Here'],
      ambiguous: ['Alex Common'],
    });
    expect(result.summary).toBe('Dues on Officers: 2 ticked, 1 not in the group, 1 not found, 1 ambiguous.');
  });

  it('unticks with checked false', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS, app_find_people: findPeople },
    });
    const result = await executeTool(
      'set_checklist_marks',
      { group: 'Officers', column: 'Dues', people: ['230020049'], checked: false },
      ctx,
    );
    expect(calls.find((call) => call.fn === 'app_set_group_mark')?.args.p_checked).toBe(false);
    expect(result.summary).toBe('Dues on Officers: 1 unticked.');
  });

  it('writes nothing when nobody on the list is in the directory', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_fields: FIELDS, app_find_people: findPeople },
    });
    const result = await executeTool(
      'set_checklist_marks',
      { group: 'Officers', column: 'Dues', people: ['Nobody Here'], checked: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.fn)).not.toContain('app_set_group_mark');
  });

  it('needs to be told which way round, and holds the list to two hundred', () => {
    expect(validateArgs('set_checklist_marks', { group: 'g', column: 'c', people: ['1'] }).error).toMatch(/checked/);
    expect(
      validateArgs('set_checklist_marks', {
        group: 'g',
        column: 'c',
        people: Array.from({ length: 201 }, () => '1'),
        checked: true,
      }).ok,
    ).toBe(false);
  });
});

describe('create_group_event and delete_group_event', () => {
  it('adds a day, today by default', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_create_group_event: 'event-2' } });
    const result = await executeTool('create_group_event', { group: 'Officers', name: 'Regionals' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_create_group_event')?.args).toEqual({
      p_group: GROUP,
      p_name: 'Regionals',
      p_held_on: null,
    });
    expect(result.summary).toBe('Added Regionals on today to Officers');
  });

  it('takes the day it was held', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_create_group_event: 'event-2' } });
    const result = await executeTool(
      'create_group_event',
      { group: 'Officers', name: 'Regionals', held_on: '2026-10-03' },
      ctx,
    );
    expect(calls.find((call) => call.fn === 'app_create_group_event')?.args.p_held_on).toBe('2026-10-03');
    expect(result.summary).toBe('Added Regionals on 2026-10-03 to Officers');
    expect(validateArgs('create_group_event', { group: 'g', name: 'n', held_on: 'next Tuesday' }).ok).toBe(false);
  });

  it('deletes the event named, resolved within its group', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS, app_list_group_events: EVENTS } });
    const result = await executeTool('delete_group_event', { group: 'Officers', event: 'weekly' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_delete_group_event')?.args).toEqual({ p_event: EVENT });
    expect(result.summary).toBe('Deleted Weekly meeting on 2026-09-15 from Officers');
  });
});

describe('mark_attendance with present false', () => {
  it('takes the mark back one person at a time, the way the screen unticks', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_events: EVENTS, app_find_people: findPeople },
      fail: (fn, args) =>
        fn === 'app_mark_attendance' && args.p_requester === SAM
          ? { code: '23514', message: 'That person is not in Officers. Add them to the group first.' }
          : null,
    });
    const result = await executeTool(
      'mark_attendance',
      { group: 'Officers', event: 'Weekly meeting', people: ['230020049', 'Sam Outsider', 'Nobody Here'], present: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).not.toContain('app_mark_attendance_many');
    expect(calls.filter((call) => call.fn === 'app_mark_attendance').map((call) => call.args)).toEqual([
      { p_event: EVENT, p_requester: NIA, p_present: false },
      { p_event: EVENT, p_requester: SAM, p_present: false },
    ]);
    expect(result.summary).toBe('Weekly meeting on 2026-09-15: 1 unmarked, 1 not in the group, 1 not found.');
  });

  it('still marks in one batch when present is true or left out', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: EVENTS,
        app_find_people: findPeople,
        app_mark_attendance_many: [{ requester_id: NIA, outcome: 'present' }],
      },
    });
    await executeTool('mark_attendance', { group: 'Officers', event: 'Weekly meeting', people: ['230020049'] }, ctx);
    expect(calls.map((call) => call.fn)).toContain('app_mark_attendance_many');
    expect(calls.map((call) => call.fn)).not.toContain('app_mark_attendance');
  });
});

describe('delete_group', () => {
  it('deletes the group named and says what went with it', async () => {
    const { ctx, calls } = context({ roles: ['admin'], results: { app_list_groups: GROUPS } });
    const result = await executeTool('delete_group', { group: 'Officers' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_delete_group')?.args).toEqual({ p_group: GROUP });
    expect(result.summary).toBe('Deleted the group Officers (3 members)');
  });

  it('is refused for anybody who is not an administrator, before the database', async () => {
    const { ctx, calls } = context({ roles: ['skills_officer'], results: { app_list_groups: GROUPS } });
    const result = await executeTool('delete_group', { group: 'Officers' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/only an administrator/i);
    expect(calls).toEqual([]);
  });
});
