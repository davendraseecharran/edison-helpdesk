import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_READ_TOOLS,
  ADMIN_TOOLS,
  describeCall,
  executeTool,
  isWriteCall,
  isWriteTool,
  normaliseTicketNumber,
  READ_TOOLS,
  requiresApproval,
  ToolError,
  toolsFor,
  validateArgs,
  WRITE_TOOLS,
  type ToolContext,
} from '../../src/lib/ai/tools';

const ALL = [...READ_TOOLS, ...WRITE_TOOLS, ...ADMIN_TOOLS];

describe('tool classification', () => {
  it('classifies every tool exactly once', () => {
    const seen = new Map<string, number>();
    for (const name of ALL) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
  });

  it('classifies every tool an administrator is offered', () => {
    const classified = new Set(ALL);
    const unclassified = toolsFor(['admin'])
      .map((tool) => tool.name)
      .filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('offers an administrator exactly the three lists', () => {
    expect(toolsFor(['admin']).map((tool) => tool.name).sort()).toEqual([...ALL].sort());
  });

  it('excludes every admin tool from a NetRider', () => {
    const names = new Set(toolsFor(['netrider']).map((tool) => tool.name));
    for (const name of ADMIN_TOOLS) expect(names.has(name)).toBe(false);
  });

  it('offers a NetRider every read and write tool except the administrator reads', () => {
    expect(toolsFor(['netrider']).map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].filter((name) => !ADMIN_READ_TOOLS.includes(name)).sort(),
    );
    // The audit log is a read and is still administration. Both facts, held
    // separately, are why `adminOnly` exists beside the group.
    expect(ADMIN_READ_TOOLS.length).toBeGreaterThan(0);
    for (const name of ADMIN_READ_TOOLS) expect(READ_TOOLS).toContain(name);
  });

  it('offers a skills officer the directory and no ticket tool at all', () => {
    const names = toolsFor(['skills_officer']).map((tool) => tool.name).sort();
    expect(names).toEqual([
      'create_person',
      'delete_view',
      'get_device',
      'get_person',
      'list_attachments',
      'list_devices',
      'list_notifications',
      'list_people',
      'mark_notifications_read',
      'save_view',
      'search_records',
      'set_preference',
      'update_person',
    ]);
    // Everything a ticket is made of, absent.
    for (const name of [
      'create_ticket',
      'claim_ticket',
      'add_note',
      'resolve_ticket',
      'log_work',
      'get_ticket',
      'list_queue',
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it('adds rather than replaces when somebody holds two roles', () => {
    expect(toolsFor(['netrider', 'skills_officer']).map((t) => t.name).sort()).toEqual(
      toolsFor(['netrider']).map((t) => t.name).sort(),
    );
    expect(toolsFor(['admin', 'skills_officer']).map((t) => t.name).sort()).toEqual(
      toolsFor(['admin']).map((t) => t.name).sort(),
    );
  });

  it('names the tools the brief requires', () => {
    for (const name of [
      'search_records',
      'get_ticket',
      'list_queue',
      'list_my_tickets',
      'list_people',
      'get_person',
      'list_devices',
      'get_device',
      'list_notifications',
      // Every tool added after the first pass belongs in this list too: the
      // point of the list is that "is this a change?" is answered from
      // something exhaustive rather than from a name that starts with `get_`.
      'get_today_briefing',
      'draft_ticket_from_text',
    ]) {
      expect(READ_TOOLS).toContain(name);
    }
    for (const name of [
      'create_ticket',
      'claim_ticket',
      'add_note',
      'set_priority',
      'set_category',
      'set_waiting',
      'resume_work',
      'resolve_ticket',
      'return_to_queue',
      'add_collaborator',
      'remove_collaborator',
      'log_work',
      'record_device_observation',
      'link_device_to_ticket',
      'create_person',
      'update_person',
      'create_device',
      'update_device',
      'assign_device',
      'return_device',
      'set_device_status',
      'move_device',
      'bulk_update_devices',
    ]) {
      expect(WRITE_TOOLS).toContain(name);
    }
    for (const name of [
      'reassign_ticket',
      'reopen_ticket',
      'cancel_ticket',
      'review_access_request',
      'create_invite',
      'set_roles',
    ]) {
      expect(ADMIN_TOOLS).toContain(name);
    }
  });

  it('never offers a model other than the one the product ships', () => {
    const serialised = JSON.stringify(toolsFor(['admin']));
    expect(serialised).not.toContain('gpt-5.3-codex-spark');
  });
});

describe('isWriteTool', () => {
  it('is false for every read tool', () => {
    for (const name of READ_TOOLS) expect(isWriteTool(name)).toBe(false);
  });
  it('is true for every write and admin tool', () => {
    for (const name of [...WRITE_TOOLS, ...ADMIN_TOOLS]) expect(isWriteTool(name)).toBe(true);
  });
  it('is false for a name that is not a tool', () => {
    expect(isWriteTool('drop_database')).toBe(false);
  });
});

describe('isWriteCall', () => {
  // import_csv was the one tool that was a read in one shape and a write in
  // another, and it is gone with the in-app importer. Nothing is now, so the
  // two questions have the same answer for every tool -- which is what this
  // pins, so a tool that grows a "check it first" mode has to say so here.
  it('agrees with isWriteTool for every tool', () => {
    for (const name of ALL) {
      expect(isWriteCall(name, {})).toBe(isWriteTool(name));
    }
  });
});

describe('tool definitions', () => {
  it('declares every tool strict, with a closed object schema', () => {
    for (const tool of toolsFor(['admin'])) {
      expect(tool.type).toBe('function');
      expect(tool.strict).toBe(true);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      // Strict function tools require every property to be listed as required;
      // an optional argument is expressed as a nullable type instead.
      expect([...tool.parameters.required].sort()).toEqual(
        Object.keys(tool.parameters.properties).sort(),
      );
    }
  });
});

describe('normaliseTicketNumber', () => {
  it('accepts the number as written', () => {
    expect(normaliseTicketNumber('EDT-1042')).toBe('EDT-1042');
    expect(normaliseTicketNumber('  edt-1042 ')).toBe('EDT-1042');
  });
  it('accepts bare digits', () => {
    expect(normaliseTicketNumber('1042')).toBe('EDT-1042');
  });
  it('accepts a missing hyphen', () => {
    expect(normaliseTicketNumber('EDT1042')).toBe('EDT-1042');
  });
  it('returns null for anything else', () => {
    expect(normaliseTicketNumber('a laptop')).toBeNull();
    expect(normaliseTicketNumber('')).toBeNull();
  });
});


/**
 * Names that are on `Object.prototype` rather than on the tool table. A plain
 * `TOOLS[name]` answers for all three, which made `isWriteTool` say true and
 * `validateArgs` reach into `Object.prototype.toString` as though it were a
 * tool specification.
 */
const INHERITED = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('inherited property names are not tools', () => {
  it('reports them as unknown rather than as writes', () => {
    for (const name of INHERITED) expect(isWriteTool(name)).toBe(false);
  });

  it('refuses them in the argument checker instead of throwing', () => {
    for (const name of INHERITED) {
      const result = validateArgs(name, {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a tool/i);
    }
  });

  it('never asks for approval for one', () => {
    for (const name of INHERITED) expect(requiresApproval(name, {}, true)).toBe(false);
  });

  it('describes one as its bare name', () => {
    for (const name of INHERITED) expect(describeCall(name, {})).toBe(name);
  });

  it('refuses to execute one, without reaching the database', () => {
    const ctx = {
      supabase: {
        rpc: () => {
          throw new Error('a tool that does not exist must never reach the database');
        },
      },
      actor: { id: 'a', displayName: 'Pat Example', roles: ['admin'] },
    } as unknown as ToolContext;

    return Promise.all(
      INHERITED.map(async (name) => {
        const result = await executeTool(name, {}, ctx);
        expect(result.ok).toBe(false);
        expect(result.summary).toMatch(/not a tool/i);
      }),
    );
  });
});

describe('requiresApproval', () => {
  it('asks for the irreversible administrator changes however the setting is set', () => {
    for (const name of ['set_roles', 'create_invite', 'review_access_request', 'cancel_ticket']) {
      expect(requiresApproval(name, {}, false)).toBe(true);
      expect(requiresApproval(name, {}, true)).toBe(true);
    }
  });

  it('asks for every administrator tool with confirmations off', () => {
    const admin = toolsFor(['admin'])
      .map((tool) => tool.name)
      .filter((name) => ADMIN_TOOLS.includes(name));
    expect(admin.sort()).toEqual([...ADMIN_TOOLS].sort());
    for (const name of admin) {
      expect(requiresApproval(name, {}, false)).toBe(true);
      expect(requiresApproval(name, {}, true)).toBe(true);
    }
  });

  it('follows the setting for ordinary work', () => {
    for (const name of ['claim_ticket', 'add_note', 'resolve_ticket', 'assign_device']) {
      expect(requiresApproval(name, {}, false)).toBe(false);
      expect(requiresApproval(name, {}, true)).toBe(true);
    }
  });

  it('never asks for a read, whatever the setting', () => {
    for (const name of READ_TOOLS) {
      expect(requiresApproval(name, {}, true)).toBe(false);
    }
  });

  it('leaves ordinary writes to the setting, and reads out of it entirely', () => {
    const known = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...ADMIN_TOOLS]);
    for (const name of ADMIN_TOOLS) expect(known.has(name)).toBe(true);
    for (const name of WRITE_TOOLS) expect(requiresApproval(name, {}, false)).toBe(false);
    for (const name of READ_TOOLS) expect(requiresApproval(name, {}, false)).toBe(false);
  });
});

describe('describeCall', () => {
  it('names a call in sentence case with its arguments', () => {
    expect(describeCall('claim_ticket', { ticket: 'EDT-1042' })).toBe(
      'Claim ticket (ticket: EDT-1042)',
    );
  });

  it('cuts any other long value', () => {
    const described = describeCall('add_note', { ticket: 'EDT-1042', body: 'x'.repeat(400) });
    expect(described.length).toBeLessThan(200);
    expect(described).toContain('\u2026');
  });

  it('summarises a long list rather than printing all of it', () => {
    const described = describeCall('bulk_update_devices', {
      device_ids: Array.from({ length: 40 }, (_, at) => `DEV-${at}`),
      status: 'retired',
    });
    expect(described).toContain('35 more');
  });
});

describe('what a failed tool tells the model', () => {
  function ctxThatThrows(error: unknown): ToolContext {
    return {
      supabase: {
        rpc: () => {
          throw error;
        },
      },
      actor: { id: 'a', displayName: 'Pat Example', roles: ['admin'] },
    } as unknown as ToolContext;
  }

  it('passes a ToolError message through, because it was written to be read', async () => {
    const result = await executeTool(
      'get_ticket',
      { ticket: 'EDT-1042' },
      ctxThatThrows(new ToolError('No ticket EDT-1042 is visible to you.', 'PGRST116', 'raw driver text')),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('No ticket EDT-1042 is visible to you.');
  });

  it('never forwards another error message verbatim', async () => {
    const leak = 'connect ECONNREFUSED 127.0.0.1:55322 while running select * from app_accounts';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await executeTool('get_ticket', { ticket: 'EDT-1042' }, ctxThatThrows(new Error(leak)));
      expect(result.ok).toBe(false);
      expect(result.summary).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(result.result)).not.toContain('ECONNREFUSED');
      // It is still findable by whoever runs the server.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the text an assistant may send', () => {
  it('refuses an overlong field and names it, with no ceiling above 4,000', () => {
    const checked = validateArgs('add_note', { ticket: 'EDT-1042', body: 'x'.repeat(4_001) });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatch(/body/);
    // The one field that carried a bigger ceiling was the pasted spreadsheet,
    // and it is gone with the importer.
    expect(validateArgs('add_note', { ticket: 'EDT-1042', body: 'x'.repeat(4_000) }).ok).toBe(true);
  });
});

describe('set_roles validates the role list itself', () => {
  function adminCtx(): ToolContext {
    return {
      supabase: {
        rpc: () => {
          throw new Error('an invalid role list must be refused before any RPC call');
        },
      },
      actor: { id: 'a', displayName: 'Pat Example', roles: ['admin'] },
    } as unknown as ToolContext;
  }

  it('names the unknown token rather than silently granting netrider', async () => {
    const result = await executeTool(
      'set_roles',
      { account: 'Dev Okafor', roles: 'admin, wizard' },
      adminCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/"wizard" is not a role/i);
  });

  it('refuses an empty role list instead of defaulting it', async () => {
    const result = await executeTool(
      'set_roles',
      { account: 'Dev Okafor', roles: '  ,  ' },
      adminCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/name at least one role/i);
  });
});
