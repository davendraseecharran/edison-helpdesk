import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOOLS,
  executeTool,
  isWriteTool,
  READ_TOOLS,
  requiresApproval,
  toolsFor,
  type ToolContext,
} from '../../src/lib/ai/tools';

/**
 * The assistant's half of the NetRiders' round: deleting a record from an
 * audit, and handing over a label link. Each asserts what reaches the RPC and
 * who is offered the tool.
 */

const DEVICE = '22222222-2222-4222-8222-222222222222';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(options: {
  results?: Record<string, unknown>;
  fail?: (fn: string) => { code: string; message: string } | null;
  roles?: string[];
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const failure = options.fail?.(fn) ?? null;
        if (failure) return { data: null, error: failure };
        return { data: (options.results ?? {})[fn] ?? null, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe('delete_device', () => {
  it('is an administrator tool that always asks first, whatever the setting', () => {
    expect(ADMIN_TOOLS).toContain('delete_device');
    expect(isWriteTool('delete_device')).toBe(true);
    expect(requiresApproval('delete_device', { device: 'DOE-1' }, false)).toBe(true);
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('delete_device');
    expect(toolsFor(['admin']).map((tool) => tool.name)).toContain('delete_device');
  });

  it('sends the machine it resolved and the reason, trimmed', async () => {
    const { ctx, calls } = context({
      roles: ['admin'],
      results: {
        app_lookup_inventory_code: [{ id: DEVICE, label: 'DOE-LN0000001' }],
        app_delete_inventory_device: { id: DEVICE, label: 'DOE-LN0000001' },
      },
    });
    const result = await executeTool('delete_device', { device: 'DOE-LN0000001', reason: '  Typed twice  ' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      fn: 'app_delete_inventory_device',
      args: { p_device: DEVICE, p_reason: 'Typed twice' },
    });
    expect(result.summary).toBe('Deleted the record DOE-LN0000001');
  });

  it('passes on the database\'s refusal, which says to retire it instead', async () => {
    const { ctx } = context({
      roles: ['admin'],
      results: { app_lookup_inventory_code: [{ id: DEVICE, label: 'DOE-LN0000001' }] },
      fail: (fn) =>
        fn === 'app_delete_inventory_device'
          ? { code: '23514', message: 'DOE-LN0000001 is linked to 1 ticket. Keep the record and mark it Retired instead.' }
          : null,
    });
    const result = await executeTool('delete_device', { device: 'DOE-LN0000001' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Retired');
  });
});

describe('label_link', () => {
  it('is a read, offered to a NetRider', () => {
    expect(READ_TOOLS).toContain('label_link');
    expect(toolsFor(['netrider']).map((tool) => tool.name)).toContain('label_link');
  });

  it('links Print labels with the machines it found, once each, and names the ones it did not', async () => {
    const { ctx } = context({
      results: {
        app_get_inventory_device: { id: DEVICE, assetTag: 'DOE-1' },
      },
    });
    const result = await executeTool('label_link', { devices: [DEVICE, DEVICE, 'NOPE-1'] }, ctx);
    expect(result.ok).toBe(true);
    const payload = result.result as { link: string; devices: string[]; not_found: string[] };
    expect(payload.link).toBe(`/devices/labels?ids=${DEVICE}`);
    expect(payload.devices).toEqual(['DOE-1']);
    expect(payload.not_found).toEqual(['NOPE-1']);
  });
});
