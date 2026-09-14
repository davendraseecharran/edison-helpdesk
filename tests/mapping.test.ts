/**
 * SQL row → TypeScript domain mapping.
 *
 * `performed_via`/`ai_model` (and the ticket's `resolved_via`/`resolved_ai_model`)
 * are NOT NULL with a 'user' default in the database, but the fallback in each
 * mapper covers a payload shaped before attribution existed — these tests pin
 * down that both the AI-stamped and the absent-field cases resolve the same way
 * the database itself would.
 */

import { describe, expect, it } from 'vitest';
import { mapDevice, mapNote, mapTicket, mapWorkLog, type TicketRow } from '../src/lib/data/mapping';

const MODEL = 'gpt-5.6-luna';

describe('mapNote', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'note-1',
      ticket_id: 'ticket-1',
      author_id: 'acc-1',
      body: 'Reseated the RAM.',
      created_at: '2026-09-12T10:00:00Z',
      ...over,
    };
  }

  it('defaults to the person when the row carries no attribution', () => {
    const note = mapNote(row());
    expect(note.performedVia).toBe('user');
    expect(note.aiModel).toBeNull();
  });

  it("carries the model when written through the person's AI", () => {
    const note = mapNote(row({ performed_via: 'ai', ai_model: MODEL }));
    expect(note.performedVia).toBe('ai');
    expect(note.aiModel).toBe(MODEL);
  });
});

describe('mapWorkLog', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'log-1',
      ticket_id: 'ticket-1',
      contributor_id: 'acc-1',
      work_date: '2026-09-12',
      minutes: 20,
      description: null,
      created_at: '2026-09-12T10:00:00Z',
      ...over,
    };
  }

  it('defaults to the person when the row carries no attribution', () => {
    const log = mapWorkLog(row());
    expect(log.performedVia).toBe('user');
    expect(log.aiModel).toBeNull();
  });

  it("carries the model when logged through the person's AI", () => {
    const log = mapWorkLog(row({ performed_via: 'ai', ai_model: MODEL }));
    expect(log.performedVia).toBe('ai');
    expect(log.aiModel).toBe(MODEL);
  });
});

describe('mapDevice', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'device-1',
      ticket_id: 'ticket-1',
      device_type: 'Laptop',
      model: 'Dell Latitude 3440',
      os_version: null,
      serial_number: null,
      asset_tag: null,
      identifiers_not_applicable: false,
      recorded_by: 'acc-1',
      recorded_at: '2026-09-12T10:00:00Z',
      ...over,
    };
  }

  it('defaults to the person when the row carries no attribution', () => {
    const device = mapDevice(row());
    expect(device.performedVia).toBe('user');
    expect(device.aiModel).toBeNull();
  });

  it("carries the model when recorded through the person's AI", () => {
    const device = mapDevice(row({ performed_via: 'ai', ai_model: MODEL }));
    expect(device.performedVia).toBe('ai');
    expect(device.aiModel).toBe(MODEL);
  });
});

describe('mapTicket', () => {
  function row(over: Partial<TicketRow> = {}): TicketRow {
    return {
      id: 'ticket-1',
      number: 'EDT-1146',
      title: 'Projector will not wake',
      issue: 'The projector stays black after power-on.',
      requester_id: null,
      requester_unknown: true,
      location: 'Room 214',
      is_remote: false,
      channel: 'walk_in',
      priority: 'normal',
      status: 'resolved',
      category: 'projector_display',
      submitted_on: '2026-09-12',
      created_at: '2026-09-12T09:00:00Z',
      created_by: 'acc-1',
      owner_id: 'acc-1',
      assigned_at: '2026-09-12T09:05:00Z',
      waiting_reason: null,
      solution: 'Reseated the HDMI cable.',
      resolved_by: 'acc-1',
      resolved_at: '2026-09-12T10:00:00Z',
      cancel_reason: null,
      ...over,
    };
  }

  it('defaults the resolution to the person when the row carries no attribution', () => {
    const ticket = mapTicket(row());
    expect(ticket.resolvedVia).toBe('user');
    expect(ticket.resolvedAiModel).toBeNull();
  });

  it("carries the model when resolved through the person's AI", () => {
    const ticket = mapTicket(row({ resolved_via: 'ai', resolved_ai_model: MODEL }));
    expect(ticket.resolvedVia).toBe('ai');
    expect(ticket.resolvedAiModel).toBe(MODEL);
  });

  it('never treats an unrecognised value as AI', () => {
    const ticket = mapTicket(row({ resolved_via: 'robot' }));
    expect(ticket.resolvedVia).toBe('user');
  });
});
