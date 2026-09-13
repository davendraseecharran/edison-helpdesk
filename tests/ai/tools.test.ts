import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOOLS,
  isWriteCall,
  isWriteTool,
  normaliseTicketNumber,
  READ_TOOLS,
  toolsFor,
  WRITE_TOOLS,
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
    const unclassified = toolsFor('admin')
      .map((tool) => tool.name)
      .filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('offers an administrator exactly the three lists', () => {
    expect(toolsFor('admin').map((tool) => tool.name).sort()).toEqual([...ALL].sort());
  });

  it('excludes every admin tool from a technician', () => {
    const names = new Set(toolsFor('technician').map((tool) => tool.name));
    for (const name of ADMIN_TOOLS) expect(names.has(name)).toBe(false);
  });

  it('offers a technician every read and write tool', () => {
    expect(toolsFor('technician').map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
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
      'get_insights',
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
      'set_role',
      'import_csv',
    ]) {
      expect(ADMIN_TOOLS).toContain(name);
    }
  });

  it('never offers a model other than the one the product ships', () => {
    const serialised = JSON.stringify(toolsFor('admin'));
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
  it('treats an import dry run as a read and a commit as a write', () => {
    expect(isWriteCall('import_csv', { kind: 'people', csv_text: 'a', mode: 'dry_run' })).toBe(false);
    expect(isWriteCall('import_csv', { kind: 'people', csv_text: 'a', mode: 'commit' })).toBe(true);
  });
  it('agrees with isWriteTool everywhere else', () => {
    for (const name of ALL) {
      if (name === 'import_csv') continue;
      expect(isWriteCall(name, {})).toBe(isWriteTool(name));
    }
  });
});

describe('tool definitions', () => {
  it('declares every tool strict, with a closed object schema', () => {
    for (const tool of toolsFor('admin')) {
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
