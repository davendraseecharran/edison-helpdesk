/**
 * The register and the checklist, as the assistant sees them.
 *
 * Four things are pinned, and each is a way an assistant could quietly do the
 * wrong thing to a roster:
 *
 *   1. AN EVENT IS RESOLVED, NOT GUESSED. A group that calls every meeting
 *      "Weekly meeting" means the NEWEST one — the list comes back newest
 *      first, so that is what the words mean — but a vague partial that hits
 *      two different events is refused with both in the message.
 *   2. NOBODY IS MARKED WHO WAS NOT NAMED. The people list goes through
 *      `app_find_people` first and only the ids it matched are sent; a line
 *      that matched nobody, or two people, comes back by name.
 *   3. THE NUMBERS ARE THE DATABASE'S. "28 marked, 3 already" is read off the
 *      outcomes `app_mark_attendance_many` returns, so somebody who was
 *      already ticked is never counted as work.
 *   4. THE CHECKLIST ANSWERS WITH WHO IS MISSING. A count alone is a fact
 *      nobody can act on; the names are the list somebody is about to chase.
 */

import { describe, expect, it } from 'vitest';
import { executeTool, isWriteTool, toolsFor, validateArgs, type ToolContext } from '../../src/lib/ai/tools';

const GROUP = '33333333-3333-4333-8333-333333333333';
const EVENT_NEW = 'aaaaaaaa-1111-4111-8111-111111111111';
const EVENT_OLD = 'aaaaaaaa-2222-4222-8222-222222222222';
const EVENT_COMP = 'aaaaaaaa-3333-4333-8333-333333333333';
const FIELD_DUES = 'bbbbbbbb-1111-4111-8111-111111111111';
const FIELD_SLIP = 'bbbbbbbb-2222-4222-8222-222222222222';
const NIA = 'cccccccc-1111-4111-8111-111111111111';
const ARI = 'cccccccc-2222-4222-8222-222222222222';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

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

const GROUPS = [{ id: GROUP, name: 'Officers', description: '', member_count: 2 }];

/** Newest first, exactly as `app_list_group_events` answers. */
const EVENTS = [
  { id: EVENT_NEW, name: 'Weekly meeting', held_on: '2026-09-16', present_count: 1, member_count: 2 },
  { id: EVENT_OLD, name: 'Weekly meeting', held_on: '2026-09-09', present_count: 2, member_count: 2 },
  { id: EVENT_COMP, name: 'Regionals practice', held_on: '2026-09-02', present_count: 0, member_count: 2 },
];

const ROLL = [
  { requester_id: NIA, display_name: 'Nia Okonkwo', kind: 'student', external_id: '230020049', present: true },
  { requester_id: ARI, display_name: 'Ari Mendez', kind: 'student', external_id: '230020050', present: false },
];

const MEMBERS = [
  { requester_id: NIA, display_name: 'Nia Okonkwo', kind: 'student', external_id: '230020049' },
  { requester_id: ARI, display_name: 'Ari Mendez', kind: 'student', external_id: '230020050' },
];

function match(key: string, id: string, name: string) {
  return { key, found: 'match', matches: 1, id, display_name: name, kind: 'student', group_label: '9A' };
}

describe('what the register tools are offered to', () => {
  it('gives all five to a skills officer, whose chapter this is', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of [
      'group_events',
      'event_attendance',
      'mark_attendance',
      'group_checklist',
      'set_checklist_mark',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('counts marking and ticking as changes and the three reads as reads', () => {
    expect(isWriteTool('mark_attendance')).toBe(true);
    expect(isWriteTool('set_checklist_mark')).toBe(true);
    for (const name of ['group_events', 'event_attendance', 'group_checklist']) {
      expect(isWriteTool(name)).toBe(false);
    }
  });
});

describe('arguments', () => {
  it('needs the group, the event and the people', () => {
    expect(validateArgs('group_events', {}).error).toMatch(/group/);
    expect(validateArgs('event_attendance', { group: 'Officers' }).error).toMatch(/event/);
    expect(
      validateArgs('mark_attendance', { group: 'Officers', event: 'Weekly meeting' }).error,
    ).toMatch(/people/);
    expect(validateArgs('set_checklist_mark', { group: 'Officers', column: 'Dues' }).error).toMatch(
      /person/,
    );
  });

  it('needs to be told whether a tick is going on or coming off', () => {
    const result = validateArgs('set_checklist_mark', {
      group: 'Officers',
      column: 'Dues',
      person: 'Nia Okonkwo',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checked/);
  });

  it('holds the marking list to what one find_people call answers', () => {
    const many = Array.from({ length: 201 }, (_, at) => `23002${String(at).padStart(4, '0')}`);
    const refused = validateArgs('mark_attendance', {
      group: 'Officers',
      event: 'Weekly meeting',
      people: many,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/200/);
  });
});

describe('naming an event', () => {
  it('takes the newest of a standing name rather than refusing a tie', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_list_group_events: EVENTS, app_event_roll: ROLL },
    });

    const result = await executeTool(
      'event_attendance',
      { group: 'Officers', event: 'Weekly meeting' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_event_roll')?.args).toEqual({ p_event: EVENT_NEW });
    expect(result.summary).toContain('2026-09-16');
  });

  it('refuses a vague partial with both events in the message', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: [
          EVENTS[0],
          { ...EVENTS[2], name: 'Weekly practice', held_on: '2026-09-02' },
        ],
      },
    });

    const result = await executeTool('event_attendance', { group: 'Officers', event: 'Weekly' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Weekly meeting');
    expect(result.summary).toContain('Weekly practice');
    expect(calls.some((call) => call.fn === 'app_event_roll')).toBe(false);
  });

  it('says so when a group has no events at all', async () => {
    const { ctx } = context({ results: { app_list_groups: GROUPS, app_list_group_events: [] } });
    const result = await executeTool('group_events', { group: 'Officers' }, ctx);
    // The list itself is happy to be empty; naming one is what refuses.
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('0 events');

    const named = await executeTool(
      'event_attendance',
      { group: 'Officers', event: 'Weekly meeting' },
      ctx,
    );
    expect(named.ok).toBe(false);
    expect(named.summary).toMatch(/no events yet/i);
  });
});

describe('event_attendance', () => {
  it('names who was absent, because that is the list somebody acts on', async () => {
    const { ctx } = context({
      results: { app_list_groups: GROUPS, app_list_group_events: EVENTS, app_event_roll: ROLL },
    });

    const result = await executeTool(
      'event_attendance',
      { group: 'Officers', event: 'Weekly meeting' },
      ctx,
    );

    expect(result.result).toMatchObject({
      present_count: 1,
      absent_count: 1,
      present: ['Nia Okonkwo'],
      absent: ['Ari Mendez'],
    });
    expect(result.summary).toContain('1 of 2 present');
  });
});

describe('mark_attendance', () => {
  it('resolves the list once, marks once, and reports what the database wrote', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: EVENTS,
        app_find_people: [match('230020049', NIA, 'Nia Okonkwo'), match('230020050', ARI, 'Ari Mendez')],
        app_mark_attendance_many: [
          { outcome: 'present', requester_id: ARI },
          { outcome: 'already', requester_id: NIA },
        ],
      },
    });

    const result = await executeTool(
      'mark_attendance',
      { group: 'Officers', event: 'Weekly meeting', people: ['230020049', '230020050'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).toEqual([
      'app_list_groups',
      'app_list_group_events',
      'app_find_people',
      'app_mark_attendance_many',
    ]);
    expect(calls[3].args).toEqual({ p_event: EVENT_NEW, p_requesters: [NIA, ARI] });
    expect(result.result).toMatchObject({ marked: 1, already: 1, not_member: 0 });
    expect(result.summary).toContain('1 marked');
    expect(result.summary).toContain('1 already');
  });

  it('carries the lines nobody matched, and the ones that matched two people', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: EVENTS,
        app_find_people: [
          match('230020049', NIA, 'Nia Okonkwo'),
          { key: '999999999', found: 'none', matches: 0, id: null },
          { key: 'Nia Okonkwo', found: 'ambiguous', matches: 2, id: null },
        ],
        app_mark_attendance_many: [{ outcome: 'present', requester_id: NIA }],
      },
    });

    const result = await executeTool(
      'mark_attendance',
      {
        group: 'Officers',
        event: 'Weekly meeting',
        people: ['230020049', '999999999', 'Nia Okonkwo'],
      },
      ctx,
    );

    expect(calls[3].args).toEqual({ p_event: EVENT_NEW, p_requesters: [NIA] });
    expect(result.result).toMatchObject({
      marked: 1,
      unmatched: ['999999999'],
      ambiguous: ['Nia Okonkwo'],
    });
  });

  it('reports somebody who is not in the group rather than adding them to it', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: EVENTS,
        app_find_people: [match('230020051', 'cccccccc-3333-4333-8333-333333333333', 'Sam Visitor')],
        app_mark_attendance_many: [
          { outcome: 'not_member', requester_id: 'cccccccc-3333-4333-8333-333333333333' },
        ],
      },
    });

    const result = await executeTool(
      'mark_attendance',
      { group: 'Officers', event: 'Weekly meeting', people: ['230020051'] },
      ctx,
    );

    expect(result.result).toMatchObject({ marked: 0, not_member: 1 });
    expect(result.summary).toContain('not in the group');
    // Nothing tried to fix it by adding them.
    expect(calls.some((call) => call.fn === 'app_add_group_members')).toBe(false);
  });

  it('writes nothing when the whole list matched nobody', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: EVENTS,
        app_find_people: [{ key: '999999999', found: 'none', matches: 0, id: null }],
      },
    });

    const result = await executeTool(
      'mark_attendance',
      { group: 'Officers', event: 'Weekly meeting', people: ['999999999'] },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/nobody was marked/i);
    expect(calls.some((call) => call.fn === 'app_mark_attendance_many')).toBe(false);
  });
});

describe('the checklist', () => {
  const FIELDS = [
    { id: FIELD_SLIP, name: 'Permission slip', position: 0, checked_count: 1 },
    { id: FIELD_DUES, name: 'Dues', position: 1, checked_count: 0 },
  ];

  it('answers with who is missing, not only how many', async () => {
    const { ctx } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_fields: FIELDS,
        app_group_marks: [{ requester_id: NIA, field_id: FIELD_SLIP }],
        app_group_members: MEMBERS,
      },
    });

    const result = await executeTool('group_checklist', { group: 'Officers' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      members: 2,
      columns: [
        { column: 'Permission slip', checked: 1, of: 2, missing: ['Ari Mendez'] },
        { column: 'Dues', checked: 0, of: 2, missing: ['Nia Okonkwo', 'Ari Mendez'] },
      ],
    });
    expect(result.summary).toContain('Permission slip 1/2');
  });

  it('ticks one person against one column', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_fields: FIELDS,
        app_list_people: {
          rows: [{ id: NIA, displayName: 'Nia Okonkwo', externalId: '230020049', kind: 'student' }],
          total: 1,
        },
        app_set_group_mark: null,
      },
    });

    const result = await executeTool(
      'set_checklist_mark',
      { group: 'Officers', column: 'dues', person: 'Nia Okonkwo', checked: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_set_group_mark')?.args).toEqual({
      p_field: FIELD_DUES,
      p_requester: NIA,
      p_checked: true,
    });
    expect(result.summary).toContain('Dues');
  });

  it('refuses a column name that matches two, and one that matches none', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_fields: [
          { id: FIELD_SLIP, name: 'Shirt ordered', position: 0, checked_count: 0 },
          { id: FIELD_DUES, name: 'Shirt collected', position: 1, checked_count: 0 },
        ],
      },
    });

    const tie = await executeTool(
      'set_checklist_mark',
      { group: 'Officers', column: 'Shirt', person: 'Nia Okonkwo', checked: true },
      ctx,
    );
    expect(tie.ok).toBe(false);
    expect(tie.summary).toContain('Shirt ordered');
    expect(tie.summary).toContain('Shirt collected');

    const missing = await executeTool(
      'set_checklist_mark',
      { group: 'Officers', column: 'Dues', person: 'Nia Okonkwo', checked: true },
      ctx,
    );
    expect(missing.ok).toBe(false);
    expect(missing.summary).toMatch(/no column called/i);
    expect(calls.some((call) => call.fn === 'app_set_group_mark')).toBe(false);
  });
});
