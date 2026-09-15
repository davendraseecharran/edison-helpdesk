import { describe, expect, it } from 'vitest';
import { executeTool, validateArgs, type ToolContext } from '../../src/lib/ai/tools';

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

export function context(options: {
  results?: Record<string, unknown>;
  roles?: string[];
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const results = options.results ?? {};
        return { data: fn in results ? results[fn] : null, error: null };
      },
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
