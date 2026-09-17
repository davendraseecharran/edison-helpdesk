/**
 * The bulk tools that take a sheet: new calls, a list of ticket numbers, a
 * list of people, and a cart of machines.
 *
 * What is pinned is the arithmetic of a batch, the same four things
 * `import-tool.test.ts` pins for a sheet of history:
 *
 *   1. The ceilings hold before the database is asked.
 *   2. What reaches the RPC per row is exactly what the single tool sends.
 *   3. A refused row is NAMED, with its number and its reason, and — for a
 *      sheet whose rows are independent, like new calls or people — the rest
 *      still land; for a walk that has an order to keep, like a cart, the
 *      first failure stops the rest and the count before it is reported.
 *   4. Repeating an import of people updates rather than duplicates: the
 *      identifier is the key, and the version travels with the update.
 */

import { describe, expect, it } from 'vitest';
import { describeCall, executeTool, validateArgs, type ToolContext } from '../../src/lib/ai/tools';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(options: {
  results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  roles?: string[];
  fail?: (fn: string, at: number, args: Record<string, unknown>) => { code: string; message: string } | null;
} = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const failure = options.fail?.(fn, calls.filter((call) => call.fn === fn).length, args) ?? null;
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

const ARI = 'cccccccc-1111-4111-8111-111111111111';
const NIA = 'cccccccc-2222-4222-8222-222222222222';
const DEVICE_A = '22222222-2222-4222-8222-222222222222';
const DEVICE_B = '22222222-3333-4333-8333-333333333333';

/** The directory, as `app_list_people` answers a search for one name. */
function directory(args: Record<string, unknown>): unknown {
  const query = String(args.p_query ?? '').toLowerCase();
  const people = [
    { id: ARI, kind: 'student', displayName: 'Ari Example', email: 'ari@edison.example', externalId: '230020049' },
    { id: NIA, kind: 'staff', displayName: 'Nia Teacher', email: 'nia@edison.example', externalId: 'nia' },
  ].filter((person) => person.kind === args.p_kind && person.displayName.toLowerCase().includes(query));
  return { rows: people, total: people.length, page: 1, pageSize: 50 };
}

/** Each ticket's detail, by the id the create answered with. */
function ticketDetail(args: Record<string, unknown>): unknown {
  const id = String(args.p_ticket);
  const digits = id.replace(/\D/g, '').slice(-4);
  return { ticket: { number: `EDT-${digits}`, title: 'A title' } };
}

describe('create_tickets', () => {
  const rows = [
    { title: 'Projector in 118', issue: 'No signal.', channel: 'walk_in', person: 'Ari Example', location: '118' },
    { title: 'Chromebook cracked', issue: 'Screen cracked.', channel: 'walk_in', category: 'chromebook', claim: true },
    { title: 'Printer jam', issue: 'Paper jam in the library.', channel: 'walk_in', person: 'Nobody Known' },
  ];

  it('opens every row it can and names the one it could not, in one answer', async () => {
    let created = 0;
    const { ctx, calls } = context({
      results: {
        app_list_people: directory,
        app_create_ticket: () => `ticket-${1100 + (created += 1)}`,
        app_ticket_detail: ticketDetail,
      },
    });
    const result = await executeTool('create_tickets', { rows }, ctx);
    // Two of three landed, so the call is a success with a refusal named in it.
    expect(result.ok).toBe(true);
    const creates = calls.filter((call) => call.fn === 'app_create_ticket');
    expect(creates).toHaveLength(2);
    // Row one: the requester resolved, the rest exactly as create_ticket sends it.
    expect(creates[0].args).toEqual({
      p_title: 'Projector in 118',
      p_issue: 'No signal.',
      p_channel: 'walk_in',
      p_priority: 'normal',
      p_requester_id: ARI,
      p_requester_unknown: false,
      p_location: '118',
      p_owner_id: null,
      p_category: 'other',
    });
    // Row two: claimed by the actor, nobody named.
    expect(creates[1].args.p_owner_id).toBe('actor-1');
    expect(creates[1].args.p_requester_unknown).toBe(true);
    expect(creates[1].args.p_category).toBe('chromebook');

    const payload = result.result as { opened: number; refused: number; refusals: { row: number; error: string }[] };
    expect(payload.opened).toBe(2);
    expect(payload.refused).toBe(1);
    expect(payload.refusals[0].row).toBe(3);
    expect(payload.refusals[0].error).toMatch(/Nobody in the directory matches "Nobody Known"/);
    expect(result.summary).toBe(
      'Opened 2 of 3 tickets (EDT-1101 to EDT-1102); 1 refused: row 3 Nobody in the directory matches "Nobody Known".',
    );
  });

  it('resolves a repeated name once, not once per row', async () => {
    const { ctx, calls } = context({
      results: {
        app_list_people: directory,
        app_create_ticket: () => 'ticket-1',
        app_ticket_detail: ticketDetail,
      },
    });
    await executeTool(
      'create_tickets',
      { rows: [rows[0], { ...rows[0], title: 'Second call' }, { ...rows[0], title: 'Third call' }] },
      ctx,
    );
    // Two kinds, one search each, for one name asked three times.
    expect(calls.filter((call) => call.fn === 'app_list_people')).toHaveLength(2);
  });

  it('is not ok when nothing was opened, and says why', async () => {
    const { ctx } = context({
      fail: (fn) => (fn === 'app_create_ticket' ? { code: '23514', message: 'A short title is required.' } : null),
    });
    const result = await executeTool('create_tickets', { rows: [rows[1]] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('Nothing was opened; 1 refused: row 1 A short title is required.');
  });

  it('holds the sheet to fifty rows, and every row to the single tool’s fields', () => {
    const many = Array.from({ length: 51 }, () => rows[1]);
    expect(validateArgs('create_tickets', { rows: many }).error).toMatch(/at most 50 rows/);
    expect(validateArgs('create_tickets', { rows: [{ ...rows[1], owner: 'Dev' }] }).error).toMatch(
      /row 1 does not take owner/,
    );
    expect(validateArgs('create_tickets', { rows: [{ title: 'x', issue: 'y' }] }).error).toMatch(/row 1 needs channel/);
    expect(validateArgs('create_tickets', { rows: [] }).error).toMatch(/at least one row/);
  });

  it('is described on the approval card by its count and its first title', () => {
    expect(describeCall('create_tickets', { rows })).toBe('Create tickets (rows: 3 rows, starting "Projector in 118")');
  });
});

describe('claim_tickets', () => {
  const search = (args: Record<string, unknown>) => {
    const number = String(args.p_query);
    return [{ kind: 'ticket', id: `id-${number.slice(-4)}`, title: `${number} Something` }];
  };

  it('claims each in order and names them all', async () => {
    const { ctx, calls } = context({ results: { app_search: search } });
    const result = await executeTool('claim_tickets', { tickets: ['EDT-1042', '1043', 'edt1044'] }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.fn === 'app_claim_ticket').map((call) => call.args.p_ticket)).toEqual([
      'id-1042',
      'id-1043',
      'id-1044',
    ]);
    expect(result.summary).toBe('Claimed 3 tickets: EDT-1042, EDT-1043, EDT-1044');
  });

  it('stops at the first that cannot be claimed and says how many were', async () => {
    const { ctx, calls } = context({
      results: { app_search: search },
      fail: (fn, at) => (fn === 'app_claim_ticket' && at === 2 ? { code: 'P0001', message: 'That ticket is already claimed.' } : null),
    });
    const result = await executeTool('claim_tickets', { tickets: ['EDT-1042', 'EDT-1043', 'EDT-1044'] }, ctx);
    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.fn === 'app_claim_ticket')).toHaveLength(2);
    expect(result.summary).toBe(
      'Claimed 1 of 3 (EDT-1042), then EDT-1043 could not be: That ticket is already claimed.',
    );
  });

  it('claims the same ticket once however many times it is listed', async () => {
    const { ctx, calls } = context({ results: { app_search: search } });
    await executeTool('claim_tickets', { tickets: ['EDT-1042', 'edt-1042'] }, ctx);
    expect(calls.filter((call) => call.fn === 'app_claim_ticket')).toHaveLength(1);
  });

  it('takes at most fifty', () => {
    expect(validateArgs('claim_tickets', { tickets: Array.from({ length: 51 }, () => 'EDT-1') }).ok).toBe(false);
  });
});

describe('import_people', () => {
  const ARI_RECORD = {
    id: ARI,
    kind: 'student',
    displayName: 'Ari Example',
    externalId: '230020049',
    email: 'ari@edison.example',
    officialClass: '9A',
    guardianName: '',
    guardianPhone: '',
    version: 3,
  };

  const findPeople = (args: Record<string, unknown>) =>
    (args.p_keys as string[]).map((key) =>
      key === '230020049'
        ? { key, found: 'match', matches: 1, id: ARI, display_name: 'Ari Example', kind: 'student' }
        : key === 'shared name'
          ? { key, found: 'ambiguous', matches: 2, id: null, display_name: null, kind: null }
          : { key, found: 'none', matches: 0, id: null, display_name: null, kind: null },
    );

  it('updates a row the directory has, adds one it does not, and refuses one it cannot read', async () => {
    const { ctx, calls } = context({
      results: {
        app_find_people: findPeople,
        app_get_person: ARI_RECORD,
        app_save_person: 'saved-id',
      },
    });
    const result = await executeTool(
      'import_people',
      {
        rows: [
          { kind: 'student', external_id: '230020049', guardian_phone: '212 555 0100', official_class: '9B' },
          { kind: 'student', external_id: '230020050', first_name: 'Dev', last_name: 'Okafor', official_class: '9A' },
          { kind: 'staff', first_name: 'No', last_name: 'Email' },
          { kind: 'staff', email: 'new.staff@edison.example', display_name: 'New Staff', department: 'Science' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);

    // One lookup for the whole sheet, under each row's own identifier.
    const lookups = calls.filter((call) => call.fn === 'app_find_people');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].args.p_keys).toEqual(['230020049', '230020050', 'new.staff@edison.example']);

    const saves = calls.filter((call) => call.fn === 'app_save_person');
    expect(saves).toHaveLength(3);
    // The update: the current record with only the sheet's fields laid over
    // it, and the version so a concurrent edit is refused rather than lost.
    expect(saves[0].args.p_id).toBe(ARI);
    expect(saves[0].args.p_version).toBe(3);
    const updated = saves[0].args.p_data as Record<string, unknown>;
    expect(updated.guardianPhone).toBe('212 555 0100');
    expect(updated.officialClass).toBe('9B');
    expect(updated.email).toBe('ari@edison.example');
    // The add: a name made from the two halves when none was given.
    expect(saves[1].args.p_id).toBeNull();
    expect((saves[1].args.p_data as Record<string, unknown>).displayName).toBe('Dev Okafor');
    expect((saves[1].args.p_data as Record<string, unknown>).kind).toBe('student');
    expect((saves[2].args.p_data as Record<string, unknown>).department).toBe('Science');

    const payload = result.result as { created: number; updated: number; refused: number; refusals: { row: number; error: string }[] };
    expect(payload).toMatchObject({ created: 2, updated: 1, refused: 1 });
    expect(payload.refusals).toEqual([{ row: 3, error: 'needs an email address.' }]);
    expect(result.summary).toBe('Imported 4 rows: 2 added, 1 updated, 1 refused: row 3 needs an email address.');
  });

  it('refuses a key that matches two records rather than picking one', async () => {
    const { ctx, calls } = context({ results: { app_find_people: findPeople } });
    const result = await executeTool(
      'import_people',
      { rows: [{ kind: 'student', external_id: 'shared name', display_name: 'Somebody' }] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.fn)).not.toContain('app_save_person');
    expect(result.summary).toMatch(/row 1 "shared name" matches more than one record/);
  });

  it('refuses a row whose identifier belongs to the other list', async () => {
    const { ctx, calls } = context({
      results: { app_find_people: findPeople, app_get_person: ARI_RECORD },
    });
    const result = await executeTool(
      'import_people',
      { rows: [{ kind: 'staff', email: '230020049', display_name: 'Wrong Kind' }] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.fn)).not.toContain('app_save_person');
    expect(result.summary).toMatch(/already in the directory as student, not staff/);
  });

  it('carries on past a row the database refuses, and reports the sentence', async () => {
    const { ctx } = context({
      results: { app_find_people: findPeople, app_save_person: 'new' },
      fail: (fn, at) =>
        fn === 'app_save_person' && at === 1 ? { code: '23514', message: 'OSIS must contain numbers only.' } : null,
    });
    const result = await executeTool(
      'import_people',
      {
        rows: [
          { kind: 'student', external_id: 'abc', display_name: 'Bad Osis' },
          { kind: 'student', external_id: '230020051', display_name: 'Good Osis' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Imported 2 rows: 1 added, 0 updated, 1 refused: row 1 OSIS must contain numbers only.');
  });

  it('holds the sheet to two hundred rows and each row to the person fields', () => {
    const many = Array.from({ length: 201 }, () => ({ kind: 'student', external_id: '1' }));
    expect(validateArgs('import_people', { rows: many }).error).toMatch(/at most 200 rows/);
    expect(validateArgs('import_people', { rows: [{ kind: 'student', osis: '1' }] }).error).toMatch(
      /row 1 does not take osis/,
    );
    expect(validateArgs('import_people', { rows: [{ external_id: '1' }] }).error).toMatch(/row 1 needs kind/);
    expect(validateArgs('import_people', { rows: [{ kind: 'student', student_status: 'expelled' }] }).ok).toBe(false);
  });

  it('is described on the approval card by its count and its first name', () => {
    expect(
      describeCall('import_people', {
        rows: [{ kind: 'student', first_name: 'Ari', last_name: 'Example' }, { kind: 'student', external_id: '2' }],
      }),
    ).toBe('Import people (rows: 2 rows, starting "Ari Example")');
  });
});

describe('bulk_assign_devices and bulk_return_devices', () => {
  // The scanner's lookup folds case, as the function does.
  const lookup = (args: Record<string, unknown>) => {
    const code = String(args.p_code).toUpperCase();
    if (code === 'EDI-0007') return [{ id: DEVICE_A, label: 'EDI-0007' }];
    if (code === 'EDI-0008') return [{ id: DEVICE_B, label: 'EDI-0008' }];
    return [];
  };

  it('hands each machine over in turn, with the note on every one', async () => {
    const { ctx, calls } = context({
      results: { app_lookup_inventory_code: lookup, app_list_people: directory },
    });
    const result = await executeTool(
      'bulk_assign_devices',
      { devices: ['EDI-0007', 'EDI-0008', 'edi-0007'], person: 'Ari Example', note: 'Cart 3, term loan' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const assigns = calls.filter((call) => call.fn === 'app_assign_inventory_device');
    // The same machine named twice is handed over once.
    expect(assigns.map((call) => call.args)).toEqual([
      { p_device: DEVICE_A, p_requester: ARI, p_note: 'Cart 3, term loan' },
      { p_device: DEVICE_B, p_requester: ARI, p_note: 'Cart 3, term loan' },
    ]);
    expect(result.summary).toBe('Assigned 2 devices to Ari Example');
  });

  it('stops at the first refusal and says how many went before it', async () => {
    const { ctx, calls } = context({
      results: { app_lookup_inventory_code: lookup, app_list_people: directory },
      fail: (fn, at) =>
        fn === 'app_assign_inventory_device' && at === 2
          ? { code: 'P0001', message: 'That machine is already assigned.' }
          : null,
    });
    const result = await executeTool(
      'bulk_assign_devices',
      { devices: ['EDI-0007', 'EDI-0008'], person: 'Ari Example' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.fn === 'app_assign_inventory_device')).toHaveLength(2);
    expect(result.summary).toBe(
      'Assigned 1 of 2 to Ari Example, then EDI-0008 could not be: That machine is already assigned.',
    );
  });

  it('resolves every machine before the first is touched', async () => {
    const { ctx, calls } = context({
      results: { app_lookup_inventory_code: lookup, app_list_people: directory, app_list_inventory: { rows: [], total: 0 } },
    });
    const result = await executeTool(
      'bulk_assign_devices',
      { devices: ['EDI-0007', 'EDI-9999'], person: 'Ari Example' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/No device matches "EDI-9999"/);
    expect(calls.map((call) => call.fn)).not.toContain('app_assign_inventory_device');
  });

  it('takes each machine back as the status given, Available by default', async () => {
    const { ctx, calls } = context({ results: { app_lookup_inventory_code: lookup } });
    const result = await executeTool('bulk_return_devices', { devices: ['EDI-0007', 'EDI-0008'] }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.fn === 'app_return_inventory_device').map((call) => call.args)).toEqual([
      { p_device: DEVICE_A, p_status: 'Available', p_note: null },
      { p_device: DEVICE_B, p_status: 'Available', p_note: null },
    ]);
    expect(result.summary).toBe('Took back 2 devices as available');

    const repair = context({ results: { app_lookup_inventory_code: lookup } });
    await executeTool('bulk_return_devices', { devices: ['EDI-0007'], status: 'In repair', note: 'Hinge' }, repair.ctx);
    expect(repair.calls.find((call) => call.fn === 'app_return_inventory_device')?.args).toEqual({
      p_device: DEVICE_A,
      p_status: 'In repair',
      p_note: 'Hinge',
    });
  });

  it('holds both to two hundred machines', () => {
    const many = Array.from({ length: 201 }, (_, at) => `EDI-${at}`);
    expect(validateArgs('bulk_assign_devices', { devices: many, person: 'Ari' }).ok).toBe(false);
    expect(validateArgs('bulk_return_devices', { devices: many }).ok).toBe(false);
    expect(validateArgs('bulk_assign_devices', { devices: ['EDI-1'] }).error).toMatch(/person/);
  });
});

describe('create_ticket, with what the intake form also sends', () => {
  const DIRECTORY = [
    { id: '55555555-5555-4555-8555-555555555555', display_name: 'Dev Okafor' },
    { id: '66666666-6666-4666-8666-666666666666', display_name: 'Nia Example' },
  ];

  it('sends collaborators, linked machines and a submission date the way the form does', async () => {
    const { ctx, calls } = context({
      roles: ['admin'],
      results: {
        app_directory: DIRECTORY,
        app_lookup_inventory_code: () => [{ id: DEVICE_A, label: 'EDI-0007' }],
        app_create_ticket: 'ticket-1',
        app_ticket_detail: { ticket: { number: 'EDT-1200', title: 'Projector' } },
      },
    });
    const result = await executeTool(
      'create_ticket',
      {
        title: 'Projector',
        issue: 'Dead.',
        channel: 'email',
        submitted_on: '2026-09-14',
        collaborators: ['Dev Okafor'],
        devices: ['EDI-0007'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const created = calls.find((call) => call.fn === 'app_create_ticket')?.args;
    expect(created?.p_submitted_on).toBe('2026-09-14');
    expect(created?.p_collaborator_ids).toEqual([DIRECTORY[0].id]);
    expect(created?.p_device_ids).toEqual([DEVICE_A]);
  });

  it('leaves the date out entirely when none is given, so the function’s own default applies', async () => {
    const { ctx, calls } = context({
      results: { app_create_ticket: 'ticket-1', app_ticket_detail: { ticket: { number: 'EDT-1', title: 'x' } } },
    });
    await executeTool('create_ticket', { title: 'x', issue: 'y', channel: 'walk_in' }, ctx);
    const created = calls.find((call) => call.fn === 'app_create_ticket')?.args ?? {};
    expect('p_submitted_on' in created).toBe(false);
    expect(created.p_collaborator_ids).toEqual([]);
    expect(created.p_device_ids).toEqual([]);
  });

  it('refuses a date that is not one', () => {
    expect(validateArgs('create_ticket', { title: 'x', issue: 'y', channel: 'walk_in', submitted_on: 'Monday' }).ok).toBe(false);
  });
});
