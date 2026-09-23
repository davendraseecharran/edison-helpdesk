/**
 * The two batch tools: a sheet of finished work, and a list of people.
 *
 * Both take a LIST, which is new here — every other tool takes one record at a
 * time — and a list is where an assistant can do the most damage per call. So
 * what is pinned is the arithmetic of a batch rather than the wording of any
 * one field:
 *
 *   1. The ceilings hold, and they hold BEFORE the database is asked. Fifty-one
 *      rows costs one sentence, not fifty round trips and a refusal.
 *   2. A row that cannot be right is refused while nothing has happened. Dates
 *      the wrong way round are the most likely thing on a hand-kept sheet, and
 *      they are checked for every row before the first one is written.
 *   3. Order is kept, and dates are normalised on the way in, so what reaches
 *      the RPC is one spelling of one instant whatever the sheet said.
 *   4. A failure halfway through SAYS SO — how many landed, which row stopped
 *      it — because those tickets are real now and somebody has to send the
 *      rest without importing anything twice.
 */

import { describe, expect, it } from 'vitest';
import { executeTool, historicInstant, validateArgs, type ToolContext } from '../../src/lib/ai/tools';
import { schoolDayStart } from '../../src/lib/format';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * The same stub `tools.test.ts` uses, with one addition: an RPC may be a
 * function, so a test can fail the third call and no other.
 */
function context(options: {
  results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  roles?: string[];
  fail?: (fn: string, at: number) => { code: string; message: string } | null;
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const failure = options.fail?.(fn, calls.filter((call) => call.fn === fn).length) ?? null;
        if (failure !== null) return { data: null, error: failure };
        const results = options.results ?? {};
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

function sheetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Projector in 118 would not wake',
    issue: 'Period 3; the podium laptop showed no signal.',
    called_at: '2026-03-02',
    resolved_at: '2026-03-04',
    ...overrides,
  };
}

/** A different id per call, so a batch does not look like one ticket fifty times. */
function ids(): (args: Record<string, unknown>) => string {
  let at = 0;
  return () => {
    at += 1;
    return `11111111-1111-4111-8111-00000000000${at}`;
  };
}

describe('historicInstant', () => {
  it('reads a plain day as that school day, not as midnight in London', () => {
    expect(historicInstant('2026-03-02')).toBe(schoolDayStart('2026-03-02'));
    // The point of the whole helper: sent as a bare timestamp the database
    // would have read this as the first of March in New York.
    expect(historicInstant('2026-03-02')).toBe('2026-03-02T05:00:00.000Z');
  });

  it('respects an instant that carries its own zone', () => {
    expect(historicInstant('2026-03-02T14:30:00Z')).toBe('2026-03-02T14:30:00.000Z');
    expect(historicInstant('2026-03-02T09:30:00-05:00')).toBe('2026-03-02T14:30:00.000Z');
  });

  it('reads a time with no zone as school-local', () => {
    expect(historicInstant('2026-03-02 09:30')).toBe('2026-03-02T14:30:00.000Z');
  });

  it('refuses anything that is not a date', () => {
    for (const value of ['2 March', 'last Tuesday', '03/02/2026', '2026-13-40', '']) {
      expect(historicInstant(value)).toBeNull();
    }
  });
});

describe('import_resolved_tickets: what the checker settles', () => {
  it('refuses 51 rows without asking the database anything', async () => {
    const { ctx, calls } = context();
    const rows = Array.from({ length: 51 }, (_, at) => sheetRow({ title: `Sheet row ${at + 1}` }));
    const result = await executeTool('import_resolved_tickets', { rows }, ctx);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/at most 50 rows/i);
    expect(calls).toEqual([]);
  });

  it('accepts 50, which is the row below the ceiling', () => {
    const rows = Array.from({ length: 50 }, (_, at) => sheetRow({ title: `Sheet row ${at + 1}` }));
    expect(validateArgs('import_resolved_tickets', { rows }).ok).toBe(true);
  });

  it('refuses an empty batch rather than reporting a successful import of nothing', async () => {
    const { ctx, calls } = context();
    const result = await executeTool('import_resolved_tickets', { rows: [] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/at least one row/i);
    expect(calls).toEqual([]);
  });

  it('names the row and the field when one row is wrong', () => {
    const checked = validateArgs('import_resolved_tickets', {
      rows: [sheetRow(), sheetRow({ called_at: 'last Tuesday' })],
    });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatch(/row 2/i);
    expect(checked.error).toMatch(/called_at/);
  });

  it('refuses a field the sheet invented', () => {
    const checked = validateArgs('import_resolved_tickets', {
      rows: [sheetRow({ resolved_by_initials: 'NE' })],
    });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatch(/resolved_by_initials/);
  });

  it('refuses a resolved date before the call, before anything is written', async () => {
    const { ctx, calls } = context({ results: { app_import_resolved_ticket: ids() } });
    const result = await executeTool(
      'import_resolved_tickets',
      { rows: [sheetRow(), sheetRow({ called_at: '2026-03-05', resolved_at: '2026-03-04' })] },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/row 2/i);
    // The first row is perfectly good and is STILL not written: a batch that
    // cannot finish must not start.
    expect(calls).toEqual([]);
  });

  it('allows a call and a fix on the same day', async () => {
    const { ctx, calls } = context({ results: { app_import_resolved_ticket: ids() } });
    const result = await executeTool(
      'import_resolved_tickets',
      { rows: [sheetRow({ called_at: '2026-03-02', resolved_at: '2026-03-02' })] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.fn === 'app_import_resolved_ticket')).toHaveLength(1);
  });
});

describe('import_resolved_tickets: what reaches the database', () => {
  it('sends every row in order, with the dates normalised and the defaults left null', async () => {
    const { ctx, calls } = context({
      results: {
        app_import_resolved_ticket: ids(),
        app_ticket_detail: { ticket: { number: 'EDT-1101' } },
      },
    });

    const result = await executeTool(
      'import_resolved_tickets',
      {
        rows: [
          sheetRow({ title: 'First' }),
          sheetRow({ title: 'Second', called_at: '2026-03-06', resolved_at: '2026-03-09T18:00:00Z' }),
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const imports = calls.filter((call) => call.fn === 'app_import_resolved_ticket');
    expect(imports).toHaveLength(2);
    expect(imports[0].args).toEqual({
      p_title: 'First',
      p_issue: 'Period 3; the podium laptop showed no signal.',
      p_called_at: '2026-03-02T05:00:00.000Z',
      p_resolved_at: '2026-03-04T05:00:00.000Z',
      p_resolved_by: null,
      p_requester_id: null,
      p_location: null,
      p_category: null,
      p_priority: null,
      p_solution: null,
    });
    expect(imports[1].args.p_title).toBe('Second');
    expect(imports[1].args.p_resolved_at).toBe('2026-03-09T18:00:00.000Z');
  });

  it('names the ticket numbers it wrote, from the first and the last', async () => {
    let read = 0;
    const { ctx } = context({
      results: {
        app_import_resolved_ticket: ids(),
        app_ticket_detail: () => {
          read += 1;
          return { ticket: { number: read === 1 ? 'EDT-1101' : 'EDT-1103' } };
        },
      },
    });

    const result = await executeTool(
      'import_resolved_tickets',
      { rows: [sheetRow({ title: 'One' }), sheetRow({ title: 'Two' }), sheetRow({ title: 'Three' })] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Imported 3 resolved tickets (EDT-1101 to EDT-1103)');
    // Two reads for three tickets, not one read each.
    expect(read).toBe(2);
  });

  it('resolves a repeated name once rather than once a row', async () => {
    const { ctx, calls } = context({
      results: {
        app_import_resolved_ticket: ids(),
        app_ticket_detail: { ticket: { number: 'EDT-1101' } },
        app_list_people: {
          rows: [{ id: 'person-1', displayName: 'Marcus Ellery', email: 'm@edison.example' }],
          total: 1,
        },
      },
    });

    const result = await executeTool(
      'import_resolved_tickets',
      {
        rows: [
          sheetRow({ title: 'One', requester: 'Marcus Ellery' }),
          sheetRow({ title: 'Two', requester: 'Marcus Ellery' }),
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    // app_list_people is asked once per KIND for one distinct name: two calls
    // for two rows, not four.
    expect(calls.filter((call) => call.fn === 'app_list_people')).toHaveLength(2);
    for (const call of calls.filter((c) => c.fn === 'app_import_resolved_ticket')) {
      expect(call.args.p_requester_id).toBe('person-1');
    }
  });

  it('says how many landed and which row stopped it', async () => {
    const { ctx, calls } = context({
      results: { app_import_resolved_ticket: ids() },
      fail: (fn, at) =>
        fn === 'app_import_resolved_ticket' && at === 3
          ? { code: '23514', message: 'The desk’s sheet only goes back three years.' }
          : null,
    });

    const result = await executeTool(
      'import_resolved_tickets',
      {
        rows: [
          sheetRow({ title: 'One' }),
          sheetRow({ title: 'Two' }),
          sheetRow({ title: 'Three' }),
          sheetRow({ title: 'Four' }),
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Imported 2 of 4 rows');
    expect(result.summary).toContain('row 3');
    expect(result.summary).toContain('three years');
    // It stopped: the fourth row was never attempted.
    expect(calls.filter((call) => call.fn === 'app_import_resolved_ticket')).toHaveLength(3);
    expect(result.result).toMatchObject({ imported: 2, failed_row: 3, remaining: 2 });
  });
});

describe('find_people', () => {
  it('sends every key in one call and keeps the order', async () => {
    const { ctx, calls } = context({
      results: {
        app_find_people: [
          {
            key: '258208622',
            found: 'match',
            matches: 1,
            id: 'person-1',
            display_name: 'Nia Okonkwo',
            kind: 'student',
            group_label: '9A',
            device_count: 1,
            open_ticket_count: 0,
          },
          { key: 'Marcus Ellery', found: 'ambiguous', matches: 3 },
          { key: 'nobody here', found: 'none', matches: 0 },
        ],
      },
    });

    const result = await executeTool(
      'find_people',
      { people: ['258208622', 'Marcus Ellery', 'nobody here'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { fn: 'app_find_people', args: { p_keys: ['258208622', 'Marcus Ellery', 'nobody here'] } },
    ]);
    expect(result.result).toEqual([
      {
        key: '258208622',
        id: 'person-1',
        name: 'Nia Okonkwo',
        kind: 'student',
        group: '9A',
        devices: 1,
        openTickets: 0,
      },
      { key: 'Marcus Ellery', match: 'ambiguous (3)' },
      { key: 'nobody here', match: 'no match' },
    ]);
    expect(result.summary).toBe('Looked up 3 people: 1 matched, 1 not found, 1 ambiguous.');
  });

  it('refuses more than 200 keys without asking the database', async () => {
    const { ctx, calls } = context();
    const people = Array.from({ length: 201 }, (_, at) => `Person ${at + 1}`);
    const result = await executeTool('find_people', { people }, ctx);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/at most 200 entries/i);
    expect(calls).toEqual([]);
  });

  it('is offered to a skills officer, who has no ticket tool at all', async () => {
    const { ctx } = context({ roles: ['skills_officer'], results: { app_find_people: [] } });
    const allowed = await executeTool('find_people', { people: ['258208622'] }, ctx);
    expect(allowed.ok).toBe(true);

    const refused = await executeTool(
      'import_resolved_tickets',
      { rows: [sheetRow()] },
      ctx,
    );
    expect(refused.ok).toBe(false);
    expect(refused.summary).toMatch(/works the directory, not tickets/i);
  });
});

describe('create_ticket and import_resolved_tickets: when it happened, and how it ended', () => {
  it('sends the opened moment, the solution and the resolved moment create_ticket was given', async () => {
    const { ctx, calls } = context({
      results: {
        app_create_ticket: 'ticket-1',
        app_ticket_detail: { ticket: { number: 'EDT-1200' } },
      },
    });
    const result = await executeTool(
      'create_ticket',
      {
        title: 'Chromebook will not charge',
        issue: 'Brought to the desk before first period.',
        channel: 'walk_in',
        opened_at: '2026-09-21 08:05',
        solution: 'Swapped the charger for a spare.',
        resolved_at: '2026-09-21 08:20',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Logged EDT-1200 as resolved: Chromebook will not charge');
    const created = calls.find((call) => call.fn === 'app_create_ticket')?.args ?? {};
    // School time: 8:05 in New York in September is 12:05Z.
    expect(created.p_opened_at).toBe('2026-09-21T12:05:00.000Z');
    expect(created.p_resolved_at).toBe('2026-09-21T12:20:00.000Z');
    expect(created.p_solution).toBe('Swapped the charger for a spare.');
  });

  it('leaves all three out when they were not given, so the function’s own now applies', async () => {
    const { ctx, calls } = context({
      results: { app_create_ticket: 'ticket-1', app_ticket_detail: { ticket: { number: 'EDT-1' } } },
    });
    await executeTool('create_ticket', { title: 'x', issue: 'y', channel: 'walk_in' }, ctx);
    const created = calls.find((call) => call.fn === 'app_create_ticket')?.args ?? {};
    expect('p_opened_at' in created).toBe(false);
    expect('p_solution' in created).toBe(false);
    expect('p_resolved_at' in created).toBe(false);
  });

  it('refuses an opened time that is not a moment', () => {
    expect(
      validateArgs('create_ticket', { title: 'x', issue: 'y', channel: 'walk_in', opened_at: 'this morning' }).ok,
    ).toBe(false);
  });

  it('carries the sheet’s own solution through the import', async () => {
    const { ctx, calls } = context({ results: { app_import_resolved_ticket: 'ticket-9' } });
    await executeTool(
      'import_resolved_tickets',
      { rows: [sheetRow({ solution: 'Reseated the HDMI cable.' })] },
      ctx,
    );
    const imported = calls.find((call) => call.fn === 'app_import_resolved_ticket')?.args ?? {};
    expect(imported.p_solution).toBe('Reseated the HDMI cable.');
  });
});
