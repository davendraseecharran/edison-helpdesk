import { describe, expect, it } from 'vitest';
import {
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
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

  it('hands over a small table whole, as something that can be saved', async () => {
    const { ctx } = tableOf([{ id: 'inv-1', email: 'sam@edison.example' }]);
    const result = await executeTool('export_backup', { table: 'account_invites' }, ctx);
    expect(result.ok).toBe(true);
    const payload = result.result as Record<string, unknown>;
    expect(String(payload.filename)).toContain('account_invites');
    expect(String(payload.download)).toMatch(/^data:text\/csv;base64,/);
    const decoded = Buffer.from(String(payload.download).split(',')[1], 'base64').toString('utf8');
    expect(decoded).toContain('sam@edison.example');
  });

  it('sends a summary and the first rows rather than a table that would not fit', async () => {
    const big = Array.from({ length: 900 }, (_, at) => ({
      id: `row-${at}`,
      notes: 'x'.repeat(400),
    }));
    const { ctx } = tableOf(big);
    const result = await executeTool('export_backup', { table: 'requesters' }, ctx);
    expect(result.ok).toBe(true);
    const payload = result.result as Record<string, unknown>;
    expect(payload.download).toBeUndefined();
    expect(payload.previewRows).toBe(20);
    expect(String(payload.preview).length).toBeLessThan(20_000);
    expect(result.summary).toMatch(/Backups screen/);
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
