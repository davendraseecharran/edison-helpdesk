/**
 * The Workflows page's jobs, for the assistant.
 *
 * `run_workflow` is the scan loop over a pasted list: every code goes through
 * the same `app_workflow_scan` a beep does, a machine already done is skipped,
 * an unknown code is reported, and the rest still land. `audit_location`
 * sorts a room the way the audit screen does and changes nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  executeTool,
  isWriteTool,
  READ_TOOLS,
  toolsFor,
  validateArgs,
  WRITE_TOOLS,
  type ToolContext,
} from '../../src/lib/ai/tools';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(options: {
  results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  fail?: (fn: string, args: Record<string, unknown>) => { code: string; message: string } | null;
  roles?: string[];
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const failure = options.fail?.(fn, args) ?? null;
        if (failure) return { data: null, error: failure };
        const found = (options.results ?? {})[fn] ?? null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

function device(tag: string) {
  return {
    id: `id-${tag}`,
    label: tag,
    assetTag: tag,
    serialNumber: `SER-${tag}`,
    externalId: `DEV-${tag}`,
    deviceType: 'Chromebook',
    manufacturer: 'Lenovo',
    model: '300e',
  };
}

function state(location: string | null, holderName: string | null = null) {
  return { location, status: 'Available', holderId: holderName ? 'p' : null, holderName, holderKind: null };
}

/** The scan RPC for a small invented cart. */
function scanner(args: Record<string, unknown>) {
  const code = String(args.p_code).toUpperCase();
  if (code === 'DOE-1') {
    return { outcome: 'done', code, device: device('DOE-1'), before: state('Library'), after: state('Cart 3') };
  }
  if (code === 'DOE-2') return { outcome: 'already', code, device: device('DOE-2'), before: state('Cart 3') };
  if (code === 'DOE-3') return { outcome: 'held', code, device: device('DOE-3'), before: state(null, 'Juniper Vale') };
  if (code === 'DOE-9') return { outcome: 'found', code, device: device('DOE-9'), before: state('Room 118') };
  return { outcome: 'unknown', code };
}

describe('classification', () => {
  it('reads what changes nothing, and asks before what does', () => {
    for (const name of ['list_workflows', 'audit_location']) expect(READ_TOOLS).toContain(name);
    for (const name of ['run_workflow', 'save_workflow_shortcut', 'delete_workflow_shortcut']) {
      expect(WRITE_TOOLS).toContain(name);
      expect(isWriteTool(name)).toBe(true);
    }
  });

  it('is not offered to a skills officer, who changes no inventory', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of ['run_workflow', 'audit_location', 'list_workflows']) expect(names).not.toContain(name);
    expect(toolsFor(['netrider']).map((tool) => tool.name)).toContain('run_workflow');
  });
});

describe('run_workflow', () => {
  it('scans each code once, skips what is done, reports what is unknown, and records the run', async () => {
    const { ctx, calls } = context({ results: { app_workflow_scan: scanner, app_record_workflow_run: 'run-1' } });
    const result = await executeTool(
      'run_workflow',
      { workflow: 'move', devices: ['DOE-1', 'doe-1', 'DOE-2', 'NOPE'], location: 'Cart 3' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Moved 1 to Cart 3; 1 skipped, 1 not in the inventory');

    const scans = calls.filter((call) => call.fn === 'app_workflow_scan');
    expect(scans.map((call) => call.args.p_code)).toEqual(['DOE-1', 'DOE-2', 'NOPE']);
    expect(scans[0].args).toEqual({ p_code: 'DOE-1', p_action: 'move', p_target: { location: 'Cart 3' } });

    const run = calls.find((call) => call.fn === 'app_record_workflow_run');
    expect(run?.args).toMatchObject({ p_kind: 'move', p_label: 'Cart 3', p_done: 1, p_skipped: 1, p_errors: 1 });
  });

  it('says a held machine must be collected first, for a status run', async () => {
    const { ctx, calls } = context({ results: { app_workflow_scan: scanner } });
    const result = await executeTool('run_workflow', { workflow: 'set_status', devices: ['DOE-3'], status: 'In repair' }, ctx);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).toContain('held by Juniper Vale');
    expect(calls[0].args).toMatchObject({ p_action: 'status', p_target: { status: 'In repair' } });
  });

  it('defaults a collection to Available and keeps the place only when given', async () => {
    const { ctx, calls } = context({ results: { app_workflow_scan: scanner } });
    await executeTool('run_workflow', { workflow: 'collect', devices: ['DOE-1'] }, ctx);
    expect(calls[0].args.p_target).toEqual({ status: 'Available' });
  });

  it('refuses a run that is set up wrong before anything is sent', async () => {
    for (const args of [
      { workflow: 'move', devices: ['DOE-1'] },
      { workflow: 'set_status', devices: ['DOE-1'] },
      { workflow: 'set_status', devices: ['DOE-1'], status: 'Assigned' },
      { workflow: 'hand_out', devices: ['DOE-1'] },
    ]) {
      const { ctx, calls } = context();
      const result = await executeTool('run_workflow', args, ctx);
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
    expect(validateArgs('run_workflow', { workflow: 'teleport', devices: ['A'] }).ok).toBe(false);
    expect(
      validateArgs('run_workflow', { workflow: 'move', devices: Array.from({ length: 201 }, (_, i) => `D${i}`), location: 'x' }).ok,
    ).toBe(false);
  });

  it('stops at a refusal about the account, and carries on past one about a machine', async () => {
    const refusedAccount = context({
      fail: (fn) => (fn === 'app_workflow_scan' ? { code: '42501', message: 'Only a NetRider or an administrator can change inventory.' } : null),
    });
    const stopped = await executeTool('run_workflow', { workflow: 'move', devices: ['A', 'B'], location: 'Cart 3' }, refusedAccount.ctx);
    expect(stopped.ok).toBe(false);
    expect(stopped.summary).toContain('Only a NetRider');
    expect(refusedAccount.calls.filter((call) => call.fn === 'app_workflow_scan')).toHaveLength(1);

    let first = true;
    const oneBad = context({
      results: { app_workflow_scan: scanner },
      fail: (fn) => {
        if (fn !== 'app_workflow_scan' || !first) return null;
        first = false;
        return { code: '23514', message: 'Keep the location under 120 characters.' };
      },
    });
    const carried = await executeTool('run_workflow', { workflow: 'move', devices: ['A', 'DOE-1'], location: 'Cart 3' }, oneBad.ctx);
    expect(carried.ok).toBe(true);
    expect(carried.summary).toBe('Moved 1 to Cart 3; 1 refused');
  });

  it('hands out to the person named', async () => {
    const PERSON = 'cccccccc-1111-4111-8111-111111111111';
    const { ctx, calls } = context({
      results: {
        app_get_person: { id: PERSON, displayName: 'Juniper Vale' },
        app_workflow_scan: scanner,
      },
    });
    const result = await executeTool('run_workflow', { workflow: 'hand_out', devices: ['DOE-1'], person: PERSON }, ctx);
    expect(result.summary).toBe('Handed 1 to Juniper Vale');
    expect(calls.find((call) => call.fn === 'app_workflow_scan')?.args).toMatchObject({
      p_action: 'assign',
      p_target: { requester: PERSON },
    });
  });
});

describe('audit_location', () => {
  it('answers codes on the room’s list from memory and sorts the rest, changing nothing', async () => {
    const { ctx, calls } = context({
      results: {
        app_workflow_location_devices: [
          { ...device('DOE-1'), state: state('Room 204') },
          { ...device('DOE-5'), state: state('Room 204') },
        ],
        app_workflow_scan: scanner,
      },
    });
    const result = await executeTool('audit_location', { location: 'Room 204', devices: ['ser-doe-1', 'DOE-9', 'ZZZ'] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('1 of 2 found in Room 204; 1 not seen, 1 recorded elsewhere');
    expect(result.result).toMatchObject({
      missing: ['DOE-5'],
      recorded_elsewhere: [{ device: 'DOE-9', recorded_in: 'Room 118' }],
      not_in_inventory: ['ZZZ'],
    });
    const scans = calls.filter((call) => call.fn === 'app_workflow_scan');
    expect(scans.map((call) => call.args.p_code)).toEqual(['DOE-9', 'ZZZ']);
    expect(scans.every((call) => call.args.p_action === 'resolve')).toBe(true);
  });
});

describe('shortcuts', () => {
  it('saves a shortcut named from its target, and deletes one by name', async () => {
    const { ctx, calls } = context({
      results: {
        app_save_workflow_shortcut: { id: 's1' },
        app_list_workflow_shortcuts: [{ id: 's1', name: 'Load Cart 3', kind: 'move', location: 'Cart 3', status: '', position: 0 }],
      },
    });
    const saved = await executeTool('save_workflow_shortcut', { workflow: 'move', location: 'Cart 3' }, ctx);
    expect(saved.summary).toBe('Saved the shortcut Load Cart 3');
    expect(calls[0].args).toMatchObject({ p_name: 'Load Cart 3', p_kind: 'move', p_location: 'Cart 3' });

    const deleted = await executeTool('delete_workflow_shortcut', { name: 'load cart 3' }, ctx);
    expect(deleted.ok).toBe(true);
    expect(calls.at(-1)).toEqual({ fn: 'app_delete_workflow_shortcut', args: { p_id: 's1' } });

    const missing = await executeTool('delete_workflow_shortcut', { name: 'Nope' }, ctx);
    expect(missing.ok).toBe(false);

    const bad = context();
    expect((await executeTool('save_workflow_shortcut', { workflow: 'audit' }, bad.ctx)).ok).toBe(false);
    expect(bad.calls).toHaveLength(0);
  });

  it('lists the saved runs and the recent ones', async () => {
    const { ctx } = context({
      results: {
        app_list_workflow_shortcuts: [{ id: 's1', name: 'Load Cart 3', kind: 'move', location: 'Cart 3', status: '', position: 0 }],
        app_list_workflow_runs: [
          {
            id: 'r1', kind: 'audit', label: 'Room 204', location: 'Room 204', status: '', done: 20, skipped: 2, errors: 0,
            startedAt: '2026-09-23T13:00:00Z', finishedAt: '2026-09-23T13:10:00Z', runBy: 'Priya Raman', performedVia: 'user',
          },
        ],
      },
    });
    const result = await executeTool('list_workflows', {}, ctx);
    expect(result.summary).toBe('1 saved run, 1 recent');
    expect(result.result).toMatchObject({ recent_runs: [{ workflow: 'Room audit', target: 'Room 204', done: 20 }] });
  });
});
