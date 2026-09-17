import { describe, expect, it } from 'vitest';
import {
  ADMIN_READ_TOOLS,
  ADMIN_TOOLS,
  DIRECTORY_EXPORT_TOOLS,
  executeTool,
  isWriteTool,
  READ_TOOLS,
  requiresApproval,
  toolsFor,
  validateArgs,
  WRITE_TOOLS,
  type ToolContext,
} from '../../src/lib/ai/tools';
import { schoolDayEnd, schoolDayStart } from '../../src/lib/format';

/**
 * The tools added so the assistant can do what the screens already could, with
 * no database behind them.
 *
 * Each one asserts the same two things: what reaches the RPC, and that a call
 * the checker can settle is settled BEFORE anything is sent. A refusal that
 * arrives from Postgres is a round trip and a worse sentence.
 */

const TICKET = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOTICE = '44444444-4444-4444-8444-444444444444';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * A PostgREST table as `readBackupTable` uses one: a head count, and pages read
 * newest first. Enough of the builder to answer those two questions and no more.
 */
function tableClient(rows: Record<string, unknown>[]) {
  return {
    select(_columns: string, options?: { head?: boolean }) {
      if (options?.head === true) return Promise.resolve({ count: rows.length, error: null });
      const builder = {
        order: () => builder,
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
      };
      return builder;
    },
  };
}

export function context(options: {
  results?: Record<string, unknown>;
  roles?: string[];
  /** Rows a `from(...)` read should find, for the backup tools. */
  table?: Record<string, unknown>[];
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const results = options.results ?? {};
        return { data: fn in results ? results[fn] : null, error: null };
      },
      from: () => tableClient(options.table ?? []),
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const TICKET_DETAIL = { ticket: { number: 'EDT-1042', title: 'Projector will not wake' } };

describe('unlink_device_from_ticket', () => {
  it('unlinks the machine the person named from the ticket they named', async () => {
    const { ctx, calls } = context({
      results: {
        app_ticket_detail: TICKET_DETAIL,
        app_get_inventory_device: { id: DEVICE, assetTag: 'EDI-0007' },
      },
    });
    const result = await executeTool(
      'unlink_device_from_ticket',
      { ticket: TICKET, device: DEVICE },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_unlink_ticket_device')?.args).toEqual({
      p_ticket: TICKET,
      p_device: DEVICE,
    });
    expect(result.summary).toBe('Unlinked EDI-0007 from EDT-1042');
  });
});

describe('mark_notifications_read', () => {
  it('marks everything with a null list, which is how the RPC spells "all"', async () => {
    const { ctx, calls } = context({ results: { app_mark_notifications_read: 3 } });
    const result = await executeTool('mark_notifications_read', { all: true }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'app_mark_notifications_read', args: { p_ids: null } }]);
    expect(result.summary).toBe('Marked 3 notifications read');
  });

  it('says nothing was unread rather than claiming a change', async () => {
    const { ctx } = context({ results: { app_mark_notifications_read: 0 } });
    const result = await executeTool('mark_notifications_read', { all: true }, ctx);
    expect(result.summary).toBe('Nothing was unread.');
  });

  it('marks only the ids it was given', async () => {
    const { ctx, calls } = context({ results: { app_mark_notifications_read: 1 } });
    const result = await executeTool('mark_notifications_read', { notification_ids: [NOTICE] }, ctx);
    expect(result.ok).toBe(true);
    expect(calls[0].args).toEqual({ p_ids: [NOTICE] });
  });

  it('refuses both at once rather than guessing which was meant', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'mark_notifications_read',
      { notification_ids: [NOTICE], all: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses neither', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('mark_notifications_read', {}, ctx);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never turns a list of nonsense into "mark everything"', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'mark_notifications_read',
      { notification_ids: ['the one about the projector'] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/list_notifications/);
    expect(calls).toEqual([]);
  });
});

describe('set_preference', () => {
  it('writes the column name the RPC whitelists, not the tool’s word', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('set_preference', { key: 'theme', value: 'light' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'app_update_preferences', args: { p_patch: { theme: 'light' } } }]);
  });

  it('reads the words people use for true and false', async () => {
    for (const [said, stored] of [
      ['true', true],
      ['on', true],
      ['false', false],
      ['off', false],
    ] as const) {
      const { ctx, calls } = context({});
      const result = await executeTool(
        'set_preference',
        { key: 'ai_confirm_changes', value: said },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(calls[0].args).toEqual({ p_patch: { ai_confirm_changes: stored } });
    }
  });

  it('refuses a value that is neither, rather than reading it as false', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'notify_in_app', value: 'sometimes' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/true or false/);
    expect(calls).toEqual([]);
  });

  it('names the settings it knows when asked for one it does not', async () => {
    const checked = validateArgs('set_preference', { key: 'admin', value: 'true' });
    expect(checked.ok).toBe(false);
    expect(checked.error).toContain('theme');
    expect(checked.error).toContain('ai_confirm_changes');
  });

  it('holds reasoning to the three levels the interface offers', async () => {
    const offered = context({});
    expect((await executeTool('set_preference', { key: 'ai_reasoning', value: 'max' }, offered.ctx)).ok).toBe(
      true,
    );
    expect(offered.calls[0].args).toEqual({ p_patch: { ai_reasoning: 'max' } });

    // A stored value older accounts still carry, and no screen offers back.
    const withdrawn = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'ai_reasoning', value: 'low' },
      withdrawn.ctx,
    );
    expect(result.ok).toBe(false);
    expect(withdrawn.calls).toEqual([]);
  });

  it('takes the welcome effects by the names people use, as a list', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'ai_welcome_states', value: 'Diamond, wave and Diamond' },
      ctx,
    );
    expect(result.ok).toBe(true);
    // The stored words, folded, each once, in the order said.
    expect(calls).toEqual([
      { fn: 'app_update_preferences', args: { p_patch: { ai_welcome_states: ['generating', 'listening'] } } },
    ]);
  });

  it('refuses a welcome effect it does not have, naming the seven, before any round trip', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'ai_welcome_states', value: 'diamond, fireworks' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Rubik's cube");
    expect(result.summary).not.toContain('generating');
    expect(calls).toEqual([]);

    const empty = context({});
    const nothing = await executeTool('set_preference', { key: 'ai_welcome_states', value: ' , ' }, empty.ctx);
    expect(nothing.ok).toBe(false);
    expect(nothing.summary).toMatch(/at least one welcome animation/);
    expect(empty.calls).toEqual([]);
  });
});

describe('save_view', () => {
  const existing = [{ id: 'view-1', name: 'Room 214', path: '/queue', query: 'q=214' }];

  it('adds to the list it read rather than replacing it', async () => {
    const { ctx, calls } = context({
      results: { app_my_preferences: { saved_views: existing } },
    });
    const result = await executeTool(
      'save_view',
      { name: 'Urgent', path: '/queue', query: 'priority=urgent&page=3' },
      ctx,
    );
    expect(result.ok).toBe(true);

    const written = calls.find((call) => call.fn === 'app_set_saved_views');
    const views = written?.args.p_views as { name: string; query: string }[];
    expect(views.map((view) => view.name)).toEqual(['Urgent', 'Room 214']);
    // A saved view is a filter, not a page number.
    expect(views[0].query).toBe('priority=urgent');
  });

  it('refuses an address that leaves the helpdesk', async () => {
    for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const { ctx, calls } = context({});
      const result = await executeTool('save_view', { name: 'Anything', path }, ctx);
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a twenty-fifth view in the words the screen uses', async () => {
    const full = Array.from({ length: 24 }, (_, at) => ({
      id: `view-${at}`,
      name: `View ${at}`,
      path: '/queue',
      query: `q=${at}`,
    }));
    const { ctx, calls } = context({ results: { app_my_preferences: { saved_views: full } } });
    const result = await executeTool('save_view', { name: 'One more', path: '/queue' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/24 saved views/);
    expect(calls.map((call) => call.fn)).not.toContain('app_set_saved_views');
  });
});

describe('delete_view', () => {
  it('removes the one with that name and writes the rest back', async () => {
    const { ctx, calls } = context({
      results: {
        app_my_preferences: {
          saved_views: [
            { id: 'view-1', name: 'Room 214', path: '/queue', query: 'q=214' },
            { id: 'view-2', name: 'Urgent', path: '/queue', query: 'priority=urgent' },
          ],
        },
      },
    });
    const result = await executeTool('delete_view', { name: 'room 214' }, ctx);
    expect(result.ok).toBe(true);
    const written = calls.find((call) => call.fn === 'app_set_saved_views');
    expect((written?.args.p_views as { id: string }[]).map((view) => view.id)).toEqual(['view-2']);
  });

  it('names what there is instead of removing the nearest thing', async () => {
    const { ctx, calls } = context({
      results: {
        app_my_preferences: { saved_views: [{ id: 'view-1', name: 'Room 214', path: '/queue', query: '' }] },
      },
    });
    const result = await executeTool('delete_view', { name: 'Room 215' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Room 214');
    expect(calls.map((call) => call.fn)).not.toContain('app_set_saved_views');
  });
});

describe('archive_person', () => {
  const PERSON = '77777777-7777-4777-8777-777777777777';
  const record = {
    id: PERSON,
    kind: 'staff',
    displayName: 'Marcus Ellery',
    email: 'marcus@edison.example',
    version: 4,
    archivedAt: null,
  };

  it('sends the whole record back with the boolean the save takes', async () => {
    const { ctx, calls } = context({ results: { app_get_person: record } });
    const result = await executeTool('archive_person', { person: PERSON, archived: true }, ctx);
    expect(result.ok).toBe(true);

    const saved = calls.find((call) => call.fn === 'app_save_person');
    expect(saved?.args.p_id).toBe(PERSON);
    // The version travels with it, so an edit somebody else made is refused
    // rather than overwritten.
    expect(saved?.args.p_version).toBe(4);
    expect((saved?.args.p_data as Record<string, unknown>).archived).toBe(true);
    expect((saved?.args.p_data as Record<string, unknown>).displayName).toBe('Marcus Ellery');
    expect(result.summary).toBe('Recorded that Marcus Ellery has left');
  });

  it('undoes it, because somebody coming back is not a different person', async () => {
    const { ctx, calls } = context({
      results: { app_get_person: { ...record, archivedAt: '2026-09-01T12:00:00Z' } },
    });
    const result = await executeTool('archive_person', { person: PERSON, archived: false }, ctx);
    expect(result.ok).toBe(true);
    expect((calls.find((call) => call.fn === 'app_save_person')?.args.p_data as Record<string, unknown>)
      .archived).toBe(false);
    expect(result.summary).toBe('Marcus Ellery is no longer archived');
  });

  it('is the only way to say it: update_person does not take the field', () => {
    const checked = validateArgs('update_person', { person: PERSON, archived: true });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatch(/does not take archived/);
  });

  it('needs to be told which way round', () => {
    expect(validateArgs('archive_person', { person: PERSON }).ok).toBe(false);
  });
});

const DIRECTORY = [
  { id: '55555555-5555-4555-8555-555555555555', display_name: 'Dev Okafor' },
  { id: '66666666-6666-4666-8666-666666666666', display_name: 'Nia Example' },
];

describe('deactivate_account and reactivate_account', () => {
  it('sends the status the RPC takes, for the colleague named', async () => {
    for (const [tool, status] of [
      ['deactivate_account', 'inactive'],
      ['reactivate_account', 'active'],
    ] as const) {
      const { ctx, calls } = context({
        roles: ['admin'],
        results: { app_directory: DIRECTORY },
      });
      const result = await executeTool(tool, { account: 'Dev Okafor' }, ctx);
      expect(result.ok).toBe(true);
      expect(calls.find((call) => call.fn === 'app_set_account_status')?.args).toEqual({
        p_account: DIRECTORY[0].id,
        p_status: status,
      });
    }
  });

  it('is refused for anybody who is not an administrator, before the database', async () => {
    const { ctx, calls } = context({ roles: ['netrider'] });
    const result = await executeTool('deactivate_account', { account: 'Dev Okafor' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/only an administrator/i);
    expect(calls).toEqual([]);
  });

  it('always asks, whatever the person’s confirmation setting says', () => {
    for (const tool of ['deactivate_account', 'reactivate_account']) {
      expect(requiresApproval(tool, { account: 'Dev Okafor' }, false)).toBe(true);
    }
  });
});

describe('export_backup', () => {
  function tableOf(rows: Record<string, unknown>[]) {
    return context({ roles: ['admin'], table: rows });
  }

  it('hands over a count, the columns and a preview, never the file itself', async () => {
    const { ctx } = tableOf([{ id: 'inv-1', email: 'sam@edison.example' }]);
    const result = await executeTool('export_backup', { table: 'account_invites' }, ctx);
    expect(result.ok).toBe(true);
    const payload = result.result as Record<string, unknown>;
    expect(String(payload.filename)).toContain('account_invites');
    expect(payload.download).toBeUndefined();
    expect(payload.rowCount).toBe(1);
    expect(payload.columns).toEqual(['id', 'email']);
    expect(payload.previewRows).toBe(1);
    expect(String(payload.preview)).toContain('sam@edison.example');
    expect(result.summary).toContain('Download the full file from Administration → Backups.');
  });

  it('never sends more than the preview rows, however large the table', async () => {
    const big = Array.from({ length: 900 }, (_, at) => ({
      id: `row-${at}`,
      notes: 'x'.repeat(400),
    }));
    const { ctx } = tableOf(big);
    const result = await executeTool('export_backup', { table: 'requesters' }, ctx);
    expect(result.ok).toBe(true);
    const payload = result.result as Record<string, unknown>;
    expect(payload.download).toBeUndefined();
    expect(payload.rowCount).toBe(900);
    expect(payload.previewRows).toBe(20);
    const previewLines = String(payload.preview).trim().split('\r\n');
    // One header line plus at most twenty rows: the whole table never rides
    // along just because it was small enough to fit in a message.
    expect(previewLines.length).toBeLessThanOrEqual(21);
    expect(String(payload.preview).length).toBeLessThan(20_000);
    expect(result.summary).toContain('Download the full file from Administration → Backups.');
  });

  it('takes only a table from the fixed list', () => {
    const checked = validateArgs('export_backup', { table: 'auth.users' });
    expect(checked.ok).toBe(false);
    expect(checked.error).toContain('tickets');
  });
});

describe('list_audit', () => {
  const entry = {
    id: 'event-1',
    kind: 'resolved',
    entity_type: 'ticket',
    summary: 'Resolved EDT-1042',
    total_count: 412,
  };

  it('bounds a day at both ends and reports the whole filtered set', async () => {
    const { ctx, calls } = context({ roles: ['admin'], results: { app_audit_log: [entry] } });
    const result = await executeTool(
      'list_audit',
      { since: '2026-09-01', until: '2026-09-15', kind: 'resolved', via: 'ai' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const sent = calls[0].args;
    expect(sent.p_kind).toBe('resolved');
    expect(sent.p_via).toBe('ai');
    // The whole school day at both ends, in the school's own timezone, which is
    // why the upper bound reads as the small hours of the next morning in UTC.
    expect(sent.p_from).toBe(schoolDayStart('2026-09-01'));
    expect(sent.p_to).toBe(schoolDayEnd('2026-09-15'));
    expect(result.summary).toBe('Read 1 of 412 audit entries.');
  });

  it('is a read, so it never asks for approval', () => {
    expect(requiresApproval('list_audit', {}, true)).toBe(false);
    expect(isWriteTool('list_audit')).toBe(false);
  });

  it('is offered to an administrator and to nobody else', () => {
    expect(toolsFor(['admin']).map((tool) => tool.name)).toContain('list_audit');
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('list_audit');
    expect(toolsFor(['skills_officer']).map((tool) => tool.name)).not.toContain('list_audit');
  });

  it('refuses a NetRider at the executor as well as in the list', async () => {
    const { ctx, calls } = context({ roles: ['netrider'] });
    const result = await executeTool('list_audit', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/only an administrator/i);
    expect(calls).toEqual([]);
  });

  it('refuses a date that is not one', () => {
    expect(validateArgs('list_audit', { since: 'last Tuesday' }).ok).toBe(false);
  });
});

/**
 * The second parity pass: everything a signed-in person can do from a screen
 * that the assistant could not, closed in one table.
 *
 * One row per tool: its group, and who is offered it. The table is the
 * assertion — a tool that lands in the wrong group asks or fails to ask, and
 * one offered to the wrong role is a card a skills officer should never see —
 * and it is checked against `toolsFor` for all three roles rather than
 * sampled, so a gating change shows up as a row that no longer matches.
 */
describe('the parity tools, and who is offered each', () => {
  type Who = 'all' | 'desk' | 'admin' | 'directory-export';
  const TABLE: [string, 'read' | 'write' | 'admin', Who][] = [
    // Reads.
    ['list_presets', 'read', 'desk'],
    ['export_people_csv', 'read', 'directory-export'],
    ['export_devices_csv', 'read', 'all'],
    ['export_group_csv', 'read', 'all'],
    ['list_invites', 'read', 'admin'],
    ['list_access_requests', 'read', 'admin'],
    // Settings.
    ['set_display_name', 'write', 'all'],
    ['update_shared_notes', 'write', 'all'],
    ['save_preset', 'write', 'desk'],
    ['delete_preset', 'write', 'desk'],
    ['move_preset', 'write', 'desk'],
    // Bulk.
    ['create_tickets', 'write', 'desk'],
    ['claim_tickets', 'write', 'desk'],
    ['import_people', 'write', 'all'],
    ['bulk_assign_devices', 'write', 'desk'],
    ['bulk_return_devices', 'write', 'desk'],
    // The rest of a group's page.
    ['update_group', 'write', 'all'],
    ['set_group_member_note', 'write', 'all'],
    ['save_group_field', 'write', 'all'],
    ['delete_group_field', 'write', 'all'],
    ['set_checklist_marks', 'write', 'all'],
    ['create_group_event', 'write', 'all'],
    ['delete_group_event', 'write', 'all'],
    // Administration.
    ['delete_group', 'admin', 'admin'],
    ['revoke_invite', 'admin', 'admin'],
  ];

  const offered = {
    admin: new Set(toolsFor(['admin']).map((tool) => tool.name)),
    netrider: new Set(toolsFor(['netrider']).map((tool) => tool.name)),
    skills: new Set(toolsFor(['skills_officer']).map((tool) => tool.name)),
  };

  it('puts each in the group the table says', () => {
    for (const [name, group] of TABLE) {
      const list = group === 'read' ? READ_TOOLS : group === 'write' ? WRITE_TOOLS : ADMIN_TOOLS;
      expect(list, name).toContain(name);
      expect(isWriteTool(name), name).toBe(group !== 'read');
    }
  });

  it('offers each to exactly the roles the table says', () => {
    for (const [name, , who] of TABLE) {
      expect(offered.admin.has(name), `${name} for an administrator`).toBe(true);
      expect(offered.netrider.has(name), `${name} for a NetRider`).toBe(who === 'all' || who === 'desk');
      expect(offered.skills.has(name), `${name} for a skills officer`).toBe(
        who === 'all' || who === 'directory-export',
      );
    }
    // The two administrator reads are reads that never ask; the export is the
    // one read gated by the roster's own roles.
    expect(ADMIN_READ_TOOLS).toContain('list_invites');
    expect(ADMIN_READ_TOOLS).toContain('list_access_requests');
    expect(DIRECTORY_EXPORT_TOOLS).toEqual(['export_people_csv']);
  });

  it('asks for each the way its group says', () => {
    for (const [name, group] of TABLE) {
      if (group === 'read') {
        expect(requiresApproval(name, {}, true), name).toBe(false);
      } else if (group === 'admin') {
        expect(requiresApproval(name, {}, false), name).toBe(true);
      } else {
        expect(requiresApproval(name, {}, false), name).toBe(false);
        expect(requiresApproval(name, {}, true), name).toBe(true);
      }
    }
  });

  it('gives every new tool a description that says what it does', () => {
    const defs = toolsFor(['admin']);
    for (const [name] of TABLE) {
      const def = defs.find((tool) => tool.name === name);
      expect(def, name).toBeDefined();
      expect(def?.description.length, name).toBeGreaterThan(40);
    }
  });
});
