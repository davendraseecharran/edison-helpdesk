/**
 * The five roster tools.
 *
 * What is pinned here is what an assistant can get WRONG about a group, which
 * is a short list and all of it is about naming:
 *
 *   1. A group is named out loud, so it is resolved rather than guessed. Two
 *      groups whose names both contain what somebody said is a question, not a
 *      coin toss, and the refusal says both names.
 *   2. A list of people is resolved through `app_find_people` BEFORE anything
 *      is written, and only the people it matched are sent. A line that matched
 *      nobody and a name that matched two people are reported back by name, so
 *      whoever asked can fix them; they are never quietly dropped into a count.
 *   3. The number reported is the number the DATABASE wrote. Somebody already
 *      in the group is skipped, and saying "31 added" when 28 landed is the one
 *      thing a batch tool must not do.
 *   4. Nothing reaches the database when the arguments cannot be right. The
 *      ceiling on a list, an unknown field and a missing group are all settled
 *      here, in one sentence, rather than in a round trip.
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
const OTHER_GROUP = '44444444-4444-4444-8444-444444444444';
const PERSON = '55555555-5555-4555-8555-555555555555';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** The stub `tools.test.ts` uses: every RPC answers from a table, or null. */
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

const GROUPS = [
  { id: GROUP, name: 'Officers', description: 'The chapter officers.', member_count: 4 },
  { id: OTHER_GROUP, name: 'Officers dinner', description: '', member_count: 9 },
];

function person(key: string, id: string, name: string) {
  return {
    key,
    found: 'match',
    matches: 1,
    id,
    display_name: name,
    kind: 'student',
    group_label: '9A',
  };
}

describe('what the roster tools are offered to', () => {
  it('gives all five to a skills officer, who is the account most likely to keep one', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of [
      'list_groups',
      'group_members',
      'create_group',
      'add_to_group',
      'remove_from_group',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('counts the three that change something as changes', () => {
    for (const name of ['create_group', 'add_to_group', 'remove_from_group']) {
      expect(isWriteTool(name)).toBe(true);
      expect(requiresApproval(name, {}, true)).toBe(true);
      // Ordinary work: with confirmations off it does not ask, like every other
      // write that is not an administrator's.
      expect(requiresApproval(name, {}, false)).toBe(false);
    }
    for (const name of ['list_groups', 'group_members']) {
      expect(isWriteTool(name)).toBe(false);
      expect(requiresApproval(name, {}, true)).toBe(false);
    }
  });
});

describe('arguments', () => {
  it('takes no arguments at all for the list', () => {
    expect(validateArgs('list_groups', {}).ok).toBe(true);
    expect(validateArgs('list_groups', { query: 'officers' }).ok).toBe(false);
  });

  it('needs the group named', () => {
    expect(validateArgs('group_members', {}).error).toMatch(/group/);
    expect(validateArgs('add_to_group', { people: ['230020049'] }).error).toMatch(/group/);
    expect(validateArgs('remove_from_group', { group: 'Officers' }).error).toMatch(/person/);
  });

  it('needs a name for a new group, and refuses one too long for the column', () => {
    expect(validateArgs('create_group', {}).error).toMatch(/name/);
    expect(validateArgs('create_group', { name: 'x'.repeat(81) }).ok).toBe(false);
    expect(validateArgs('create_group', { name: 'x'.repeat(80) }).ok).toBe(true);
    expect(validateArgs('create_group', { name: 'Officers', description: 'x'.repeat(301) }).ok).toBe(
      false,
    );
  });

  it('refuses a field it does not know rather than ignoring it', () => {
    const result = validateArgs('add_to_group', {
      group: 'Officers',
      people: ['230020049'],
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/force/);
  });

  it('holds the list to what one find_people call answers', () => {
    const many = Array.from({ length: 201 }, (_, at) => `23002${String(at).padStart(4, '0')}`);
    const refused = validateArgs('add_to_group', { group: 'Officers', people: many });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/200/);
    expect(validateArgs('add_to_group', { group: 'Officers', people: many.slice(0, 200) }).ok).toBe(
      true,
    );
  });

  it('refuses an empty list rather than sending one', () => {
    expect(validateArgs('add_to_group', { group: 'Officers', people: [] }).ok).toBe(false);
  });
});

describe('naming a group', () => {
  it('matches a name exactly, even when another group contains it', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_group_members: [] },
    });
    const result = await executeTool('group_members', { group: 'officers' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_group_members')?.args).toEqual({ p_group: GROUP });
  });

  it('refuses a tie with both names in it rather than choosing one', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('group_members', { group: 'Officer' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Officers');
    expect(result.summary).toContain('Officers dinner');
    expect(calls.some((call) => call.fn === 'app_group_members')).toBe(false);
  });

  it('says so when no group is called that, and reads nothing', async () => {
    const { ctx, calls } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('group_members', { group: 'Robotics' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no group called/i);
    expect(calls.some((call) => call.fn === 'app_group_members')).toBe(false);
  });

  it('takes an id as an id', async () => {
    const { ctx, calls } = context({
      results: { app_list_groups: GROUPS, app_group_members: [] },
    });
    const result = await executeTool('group_members', { group: GROUP }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_group_members')?.args).toEqual({ p_group: GROUP });
  });
});

describe('create_group', () => {
  it('sends the name and the description, and the description empty when there is none', async () => {
    const { ctx, calls } = context({ results: { app_create_group: GROUP } });
    const result = await executeTool('create_group', { name: 'Regionals 2027' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      fn: 'app_create_group',
      args: { p_name: 'Regionals 2027', p_description: '' },
    });
    expect(result.summary).toContain('Regionals 2027');
  });
});

describe('add_to_group', () => {
  it('resolves the whole list once, then writes once', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_find_people: [
          person('230020049', PERSON, 'Nia Okonkwo'),
          person('230020050', '66666666-6666-4666-8666-666666666666', 'Ari Mendez'),
        ],
        app_add_group_members: 2,
      },
    });

    const result = await executeTool(
      'add_to_group',
      { group: 'Officers', people: ['230020049', '230020050'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).toEqual([
      'app_list_groups',
      'app_find_people',
      'app_add_group_members',
    ]);
    expect(calls[1].args).toEqual({ p_keys: ['230020049', '230020050'] });
    expect(calls[2].args).toEqual({
      p_group: GROUP,
      p_requesters: [PERSON, '66666666-6666-4666-8666-666666666666'],
    });
    expect(result.summary).toContain('2 added');
  });

  it('reports what the database wrote, not what was asked for', async () => {
    const { ctx } = context({
      results: {
        app_list_groups: GROUPS,
        app_find_people: [
          person('230020049', PERSON, 'Nia Okonkwo'),
          person('230020050', '66666666-6666-4666-8666-666666666666', 'Ari Mendez'),
        ],
        // One of the two was already in the group.
        app_add_group_members: 1,
      },
    });

    const result = await executeTool(
      'add_to_group',
      { group: 'Officers', people: ['230020049', '230020050'] },
      ctx,
    );

    expect(result.summary).toContain('1 added');
    expect(result.summary).toContain('1 already in it');
    expect(result.result).toMatchObject({ added: 1, skipped: 1 });
  });

  it('names the lines nobody could be found for, and adds the rest', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_find_people: [
          person('230020049', PERSON, 'Nia Okonkwo'),
          { key: '999999999', found: 'none', matches: 0, id: null },
          { key: 'Nia Okonkwo', found: 'ambiguous', matches: 2, id: null },
        ],
        app_add_group_members: 1,
      },
    });

    const result = await executeTool(
      'add_to_group',
      { group: 'Officers', people: ['230020049', '999999999', 'Nia Okonkwo'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Only the one that resolved is sent.
    expect(calls[2].args).toEqual({ p_group: GROUP, p_requesters: [PERSON] });
    expect(result.result).toMatchObject({
      added: 1,
      unmatched: ['999999999'],
      ambiguous: ['Nia Okonkwo'],
    });
    expect(result.summary).toContain('1 not found');
    expect(result.summary).toContain('1 ambiguous');
  });

  it('writes nothing at all when the list matched nobody', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_find_people: [
          { key: '999999999', found: 'none', matches: 0, id: null },
          { key: 'Nobody Here', found: 'none', matches: 0, id: null },
        ],
      },
    });

    const result = await executeTool(
      'add_to_group',
      { group: 'Officers', people: ['999999999', 'Nobody Here'] },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/nobody was added/i);
    expect(calls.some((call) => call.fn === 'app_add_group_members')).toBe(false);
  });
});

describe('remove_from_group', () => {
  it('resolves both the group and the person before removing', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_people: {
          rows: [{ id: PERSON, displayName: 'Nia Okonkwo', externalId: '230020049', kind: 'student' }],
          total: 1,
        },
        app_remove_group_member: null,
      },
    });

    const result = await executeTool(
      'remove_from_group',
      { group: 'Officers', person: 'Nia Okonkwo' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_remove_group_member')?.args).toEqual({
      p_group: GROUP,
      p_requester: PERSON,
    });
    expect(result.summary).toContain('Nia Okonkwo');
    expect(result.summary).toContain('Officers');
  });
});
