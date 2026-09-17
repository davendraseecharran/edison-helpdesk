/**
 * The three exports the screens have buttons for, as the assistant offers them.
 *
 * None of them hands over a file: the assistant cannot download, and a whole
 * table in a chat turn is the one thing `export_backup` already refuses to do.
 * So what is pinned is what comes back instead — a link the person opens, or a
 * count with a bounded preview — and who is offered each one:
 *
 *   * the directory export is a skills officer's and an administrator's, and
 *     a NetRider is refused it at the list AND at the executor, the way the
 *     route and `app_log_people_export` refuse them independently;
 *   * the inventory and roster exports are every active account's, because
 *     every active account has the button.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_EXPORT_TOOLS,
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';

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

const GROUP = '33333333-3333-4333-8333-333333333333';
const EVENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const PERSON = '55555555-5555-4555-8555-555555555555';

describe('who is offered what', () => {
  it('offers the directory export to a skills officer and an administrator, not a NetRider', () => {
    expect(DIRECTORY_EXPORT_TOOLS).toEqual(['export_people_csv']);
    expect(toolsFor(['skills_officer']).map((tool) => tool.name)).toContain('export_people_csv');
    expect(toolsFor(['admin']).map((tool) => tool.name)).toContain('export_people_csv');
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('export_people_csv');
    // Holding both roles is holding the export.
    expect(toolsFor(['netrider', 'skills_officer']).map((tool) => tool.name)).toContain('export_people_csv');
  });

  it('refuses a NetRider at the executor too, before any round trip', async () => {
    const { ctx, calls } = context({ roles: ['netrider'] });
    const result = await executeTool('export_people_csv', { kind: 'student' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/administrator or a skills officer/);
    expect(calls).toEqual([]);
  });

  it('offers the inventory and roster exports to everybody', () => {
    for (const roles of [['netrider'], ['skills_officer'], ['admin']]) {
      const names = toolsFor(roles as never).map((tool) => tool.name);
      expect(names).toContain('export_devices_csv');
      expect(names).toContain('export_group_csv');
    }
  });

  it('counts all three as reads that never ask', () => {
    for (const name of ['export_people_csv', 'export_devices_csv', 'export_group_csv']) {
      expect(isWriteTool(name)).toBe(false);
      expect(requiresApproval(name, {}, true)).toBe(false);
    }
  });
});

describe('export_people_csv', () => {
  it('answers with the route’s link and the count, never the rows', async () => {
    const { ctx, calls } = context({
      results: { app_list_people: { rows: [{ id: PERSON, displayName: 'Ari Example' }], total: 3448, page: 1, pageSize: 50 } },
    });
    const result = await executeTool('export_people_csv', { kind: 'student', query: '9A' }, ctx);
    expect(result.ok).toBe(true);
    // The list read the screen makes, for the total in its envelope.
    expect(calls).toEqual([{ fn: 'app_list_people', args: { p_kind: 'student', p_query: '9A', p_page: 1 } }]);
    const payload = result.result as Record<string, unknown>;
    expect(payload.link).toBe('/people/export?kind=student&query=9A');
    expect(payload.rowCount).toBe(3448);
    expect(payload.rows).toBeUndefined();
    expect(payload.preview).toBeUndefined();
    expect(result.summary).toBe('3,448 students match "9A". Open /people/export?kind=student&query=9A to download the CSV.');
  });

  it('links the whole list when there is no search', async () => {
    const { ctx } = context({ results: { app_list_people: { rows: [], total: 261 } } });
    const result = await executeTool('export_people_csv', { kind: 'staff' }, ctx);
    expect((result.result as { link: string }).link).toBe('/people/export?kind=staff');
    expect(result.summary).toMatch(/^261 staff\. Open/);
  });

  it('needs students or staff', () => {
    expect(validateArgs('export_people_csv', {}).ok).toBe(false);
    expect(validateArgs('export_people_csv', { kind: 'everyone' }).ok).toBe(false);
  });
});

describe('export_devices_csv', () => {
  const DEVICE_ROWS = Array.from({ length: 50 }, (_, at) => ({
    id: `device-${at}`,
    assetTag: `EDI-${1000 + at}`,
    serialNumber: `SN${at}`,
    externalId: `INV${at}`,
    deviceType: 'Chromebook',
    manufacturer: 'Acme',
    model: 'C100',
    osVersion: '',
    status: 'Assigned',
    location: 'Cart 3',
    assignedName: 'Ari Example',
    assignedKind: 'student',
    updatedAt: '2026-09-16T12:00:00Z',
    version: 1,
  }));

  it('hands over the count, the export’s own columns and a bounded preview', async () => {
    const { ctx, calls } = context({
      roles: ['netrider'],
      results: { app_list_inventory: { rows: DEVICE_ROWS, total: 4278, page: 1, pageSize: 50 } },
    });
    const result = await executeTool('export_devices_csv', { query: 'cart 3' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { fn: 'app_list_inventory', args: { p_query: 'cart 3', p_page: 1, p_requester: null } },
    ]);
    const payload = result.result as Record<string, unknown>;
    expect(payload.rowCount).toBe(4278);
    expect(payload.columns).toEqual([
      'Asset tag',
      'Serial number',
      'Inventory ID',
      'Type',
      'Manufacturer',
      'Model',
      'OS',
      'Status',
      'Location',
      'Holder',
      'Holder kind',
      'Updated',
    ]);
    expect(payload.previewRows).toBe(20);
    const lines = String(payload.preview).trim().split('\r\n');
    expect(lines).toHaveLength(21);
    expect(lines[1]).toContain('EDI-1000');
    expect(lines[1]).toContain('Student');
    expect(String(payload.filename)).toMatch(/^edison-devices-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(result.summary).toContain('4,278 devices matching "cart 3"');
    expect(result.summary).toContain('Export button on the Devices list');
  });

  it('narrows to one person’s machines the way the list does', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_people: (args: Record<string, unknown>) =>
          args.p_kind === 'student'
            ? { rows: [{ id: PERSON, displayName: 'Ari Example', email: 'ari@edison.example', externalId: '230020049' }], total: 1 }
            : { rows: [], total: 0 },
        app_list_inventory: { rows: DEVICE_ROWS.slice(0, 2), total: 2 },
      },
    });
    const result = await executeTool('export_devices_csv', { person: 'Ari Example' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_list_inventory')?.args.p_requester).toBe(PERSON);
    expect(result.summary).toContain('2 devices held by Ari Example');
  });
});

describe('export_group_csv', () => {
  const GROUPS = [{ id: GROUP, name: 'Officers', description: '', member_count: 4 }];

  it('links the roster export for a group', async () => {
    const { ctx } = context({ results: { app_list_groups: GROUPS } });
    const result = await executeTool('export_group_csv', { group: 'officers' }, ctx);
    expect(result.ok).toBe(true);
    expect((result.result as { link: string }).link).toBe(`/groups/${GROUP}/export`);
    expect(result.summary).toBe(`Officers: 4 members. Open /groups/${GROUP}/export to download the roster.`);
  });

  it('links the register export for one of its events', async () => {
    const { ctx } = context({
      results: {
        app_list_groups: GROUPS,
        app_list_group_events: [{ id: EVENT, name: 'Weekly meeting', held_on: '2026-09-15', present_count: 3 }],
      },
    });
    const result = await executeTool('export_group_csv', { group: 'Officers', event: 'weekly' }, ctx);
    expect(result.ok).toBe(true);
    expect((result.result as { link: string }).link).toBe(`/groups/${GROUP}/events/${EVENT}/export`);
    expect(result.summary).toContain('Weekly meeting on 2026-09-15');
  });

  it('refuses an event the group does not have, naming the group', async () => {
    const { ctx } = context({ results: { app_list_groups: GROUPS, app_list_group_events: [] } });
    const result = await executeTool('export_group_csv', { group: 'Officers', event: 'Regionals' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/Officers has no events/);
  });
});
