import { describe, expect, it } from 'vitest';
import { executeTool, type ToolContext } from '../../src/lib/ai/tools';

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
