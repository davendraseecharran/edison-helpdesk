import { describe, expect, it } from 'vitest';
import { ADMIN_TOOLS, READ_TOOLS, toolsFor, validateArgs, WRITE_TOOLS } from '../../src/lib/ai/tools';

describe('validateArgs', () => {
  it('refuses a tool it does not know', () => {
    const result = validateArgs('drop_database', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a tool/i);
  });

  it('refuses arguments that are not an object', () => {
    expect(validateArgs('claim_ticket', null).ok).toBe(false);
    expect(validateArgs('claim_ticket', ['EDT-1042']).ok).toBe(false);
    expect(validateArgs('claim_ticket', 'EDT-1042').ok).toBe(false);
  });

  it('accepts a call with only the required fields', () => {
    const result = validateArgs('claim_ticket', { ticket: 'EDT-1042' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ ticket: 'EDT-1042' });
  });

  it('refuses an unknown field', () => {
    const result = validateArgs('claim_ticket', { ticket: 'EDT-1042', force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/force/);
  });

  it('refuses a missing required field', () => {
    const result = validateArgs('claim_ticket', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ticket/);
  });

  it('refuses a required field of the wrong type', () => {
    expect(validateArgs('claim_ticket', { ticket: 42 }).ok).toBe(false);
    expect(validateArgs('add_note', { ticket: 'EDT-1042', body: ['hi'] }).ok).toBe(false);
  });

  it('refuses an empty string where text is required', () => {
    expect(validateArgs('add_note', { ticket: 'EDT-1042', body: '   ' }).ok).toBe(false);
  });

  it('drops an optional field sent as null', () => {
    const result = validateArgs('search_records', { query: 'laptop', limit: null });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ query: 'laptop' });
  });

  it('keeps an optional field that is present', () => {
    const result = validateArgs('search_records', { query: 'laptop', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ query: 'laptop', limit: 5 });
  });

  it('treats an absent optional field the same as null', () => {
    const result = validateArgs('search_records', { query: 'laptop' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ query: 'laptop' });
  });

  it('refuses a value outside a fixed vocabulary', () => {
    expect(validateArgs('set_priority', { ticket: 'EDT-1042', priority: 'urgent' }).ok).toBe(true);
    const result = validateArgs('set_priority', { ticket: 'EDT-1042', priority: 'emergency' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/priority/);
  });

  it('refuses a non-integer where whole minutes are wanted', () => {
    expect(validateArgs('log_work', { ticket: 'EDT-1042', minutes: 30 }).ok).toBe(true);
    expect(validateArgs('log_work', { ticket: 'EDT-1042', minutes: 30.5 }).ok).toBe(false);
    expect(validateArgs('log_work', { ticket: 'EDT-1042', minutes: '30' }).ok).toBe(false);
  });

  it('refuses a boolean sent as a string', () => {
    const result = validateArgs('return_device', { device: 'DOE-1', status: null, note: null });
    expect(result.ok).toBe(true);
    expect(
      validateArgs('record_device_observation', {
        ticket: 'EDT-1042',
        device_type: 'Chromebook',
        identifiers_not_applicable: 'yes',
      }).ok,
    ).toBe(false);
  });

  it('refuses a list that is not a list of strings', () => {
    expect(validateArgs('bulk_update_devices', { device_ids: ['a', 'b'], status: 'retired' }).ok).toBe(
      true,
    );
    expect(validateArgs('bulk_update_devices', { device_ids: 'a', status: 'retired' }).ok).toBe(false);
    expect(validateArgs('bulk_update_devices', { device_ids: [1, 2], status: 'retired' }).ok).toBe(
      false,
    );
  });

  it('refuses an empty list where at least one entry is required', () => {
    expect(validateArgs('bulk_update_devices', { device_ids: [], status: 'retired' }).ok).toBe(false);
  });

  it('refuses a date that is not a plain calendar date', () => {
    expect(
      validateArgs('log_work', { ticket: 'EDT-1042', minutes: 15, work_date: '2026-09-13' }).ok,
    ).toBe(true);
    expect(
      validateArgs('log_work', { ticket: 'EDT-1042', minutes: 15, work_date: '13/09/2026' }).ok,
    ).toBe(false);
  });

  it('accepts every tool called with only its required fields', () => {
    // Every schema has to be satisfiable: a tool whose required set cannot be
    // filled is a tool the model can never call.
    for (const tool of toolsFor('admin')) {
      const args: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(tool.parameters.properties)) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (types.includes('null')) continue;
        if (schema.enum) args[name] = schema.enum[0];
        else if (types.includes('string')) args[name] = 'x';
        else if (types.includes('integer') || types.includes('number')) args[name] = 1;
        else if (types.includes('boolean')) args[name] = true;
        else if (types.includes('array')) args[name] = ['x'];
      }
      const result = validateArgs(tool.name, args);
      expect(result.ok, `${tool.name}: ${result.error ?? ''}`).toBe(true);
    }
  });

  it('has a schema for every classified tool', () => {
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS, ...ADMIN_TOOLS]) {
      expect(validateArgs(name, {}).error ?? '').not.toMatch(/not a tool/i);
    }
  });
});
