/**
 * Workflows: the scan loop's database half.
 *
 * `20260923110000_workflows.sql` adds one RPC per beep, an undo, two reads and
 * two small shared tables. What is proven here, through real signed-in
 * sessions because every gate is written inside a SECURITY DEFINER body:
 *
 *   1. A scan does the job through the existing movement RPCs, so both
 *      histories are written exactly as a click writes them, and it answers
 *      with the state before and after.
 *   2. A machine that is already done is said to be, and NOTHING is written.
 *   3. Undo puts the machine back exactly, and refuses when somebody changed
 *      it after the scan.
 *   4. A hand-out recognises the next person's card mid-run.
 *   5. A skills officer can do none of it; shortcuts are shared by the desk
 *      and capped; runs are recorded with their counts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  identity,
  rawDevice,
  rawInventoryEvents,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
  signInWithHeaders,
} from './support/harness';

const RUN = String(Math.floor(Math.random() * 9000) + 1000);
const REFUSED = '42501';
const REJECTED = '23514';

interface State {
  location: string | null;
  status: string | null;
  holderId: string | null;
  holderName: string | null;
}

interface ScanAnswer {
  outcome: string;
  code: string;
  device?: { id: string; label: string };
  before?: State;
  after?: State;
  person?: { id: string; displayName: string; kind: string; holding: number };
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let aiNetrider: SupabaseClient;
let student: { id: string; displayName: string; externalId: string };
let staff: { id: string; displayName: string; externalId: string };

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  aiNetrider = await signInWithHeaders('owner', { 'x-edison-via': 'ai', 'x-edison-ai-model': 'gpt-5.6-luna' });
  student = await seedRequester('student', { display_name: `Juniper Vale-${RUN}` });
  staff = await seedRequester('staff', { display_name: `Mr. Okafor-${RUN}` });
});

function scan(
  client: SupabaseClient,
  code: string,
  action: string,
  target: Record<string, unknown> = {},
): Promise<ScanAnswer> {
  return rpcOk<ScanAnswer>(client, 'app_workflow_scan', { p_code: code, p_action: action, p_target: target });
}

describe('one scan, one job', () => {
  it('moves a machine by its asset tag, folded for case, and writes both histories', async () => {
    const device = await seedInventoryDevice({ location: `Library-${RUN}` });
    const answer = await scan(netrider, device.assetTag.toLowerCase(), 'move', { location: `Cart W${RUN}` });

    expect(answer.outcome).toBe('done');
    expect(answer.device?.id).toBe(device.id);
    expect(answer.before?.location).toBe(`Library-${RUN}`);
    expect(answer.after?.location).toBe(`Cart W${RUN}`);
    expect((await rawDevice(device.id)).location).toBe(`Cart W${RUN}`);

    expect(await rawInventoryEvents('device', device.id)).toHaveLength(1);
    const events = await rawRecordEvents('inventory_device', device.id);
    expect(events.map((event) => event.kind)).toEqual(['bulk_updated']);
  });

  it('says a machine is already there and writes nothing', async () => {
    const device = await seedInventoryDevice({ location: `Cart X${RUN}` });
    const answer = await scan(netrider, device.serialNumber, 'move', { location: `Cart X${RUN}` });

    expect(answer.outcome).toBe('already');
    expect(answer.before?.location).toBe(`Cart X${RUN}`);
    expect(await rawInventoryEvents('device', device.id)).toHaveLength(0);
    expect(await rawRecordEvents('inventory_device', device.id)).toHaveLength(0);
  });

  it('answers unknown for a code that names nothing and ambiguous for one that names two', async () => {
    expect((await scan(netrider, `NOPE-${RUN}-${crypto.randomUUID()}`, 'move', { location: 'Cart 1' })).outcome).toBe(
      'unknown',
    );

    const shared = `SHARED-${RUN}-${crypto.randomUUID().slice(0, 6)}`;
    await seedInventoryDevice({ asset_tag: shared });
    await seedInventoryDevice({ serial_number: shared });
    expect((await scan(netrider, shared, 'move', { location: 'Cart 1' })).outcome).toBe('ambiguous');
  });

  it('checks the target before it looks anything up', async () => {
    const device = await seedInventoryDevice();
    const noPlace = await rpcFails(netrider, 'app_workflow_scan', {
      p_code: device.assetTag,
      p_action: 'move',
      p_target: {},
    });
    expect(noPlace.code).toBe(REJECTED);
    expect(noPlace.message).toContain('Choose where');

    const assigned = await rpcFails(netrider, 'app_workflow_scan', {
      p_code: device.assetTag,
      p_action: 'status',
      p_target: { status: 'Assigned' },
    });
    expect(assigned.message).toContain('Hand the machines out');

    const unknownJob = await rpcFails(netrider, 'app_workflow_scan', {
      p_code: device.assetTag,
      p_action: 'delete',
      p_target: {},
    });
    expect(unknownJob.code).toBe(REJECTED);
  });

  it('sets a status, and leaves a machine somebody holds to be collected', async () => {
    const device = await seedInventoryDevice();
    const done = await scan(netrider, device.assetTag, 'status', { status: 'In repair' });
    expect(done.outcome).toBe('done');
    expect(done.after?.status).toBe('In repair');

    const held = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', { p_device: held.id, p_requester: student.id });
    const answer = await scan(netrider, held.assetTag, 'status', { status: 'In repair' });
    expect(answer.outcome).toBe('held');
    expect(answer.before?.holderName).toBe(student.displayName);
    expect((await rawDevice(held.id)).status).toBe('Assigned');
  });

  it('hands out, and recognises the next person’s card in the middle of a run', async () => {
    // A person of this test's own, so the count below is only what it handed out.
    const student = await seedRequester('student', { display_name: `Rowan Ashby-${RUN}` });
    const device = await seedInventoryDevice();
    const handed = await scan(netrider, device.assetTag, 'assign', { requester: student.id });
    expect(handed.outcome).toBe('done');
    expect(handed.after?.holderId).toBe(student.id);
    expect(handed.after?.status).toBe('Assigned');

    const again = await scan(netrider, device.assetTag, 'assign', { requester: student.id });
    expect(again.outcome).toBe('already');

    const card = await scan(netrider, staff.externalId.toUpperCase(), 'assign', { requester: student.id });
    expect(card.outcome).toBe('person');
    expect(card.person?.id).toBe(staff.id);

    const osis = await rpcOk<{ id: string; holding: number } | null>(netrider, 'app_workflow_find_person', {
      p_code: ` ${student.externalId} `,
    });
    expect(osis?.id).toBe(student.id);
    expect(osis?.holding).toBe(1);
    expect(await rpcOk(netrider, 'app_workflow_find_person', { p_code: 'nobody-at-all' })).toBeNull();
  });

  it('collects from whoever had it, into a place and a state', async () => {
    const device = await seedInventoryDevice({ location: `Room 204-${RUN}` });
    await rpcOk(netrider, 'app_assign_inventory_device', { p_device: device.id, p_requester: student.id });

    const answer = await scan(netrider, device.assetTag, 'collect', {
      status: 'Available',
      location: `Returns bin-${RUN}`,
    });
    expect(answer.outcome).toBe('done');
    expect(answer.before?.holderId).toBe(student.id);
    expect(answer.after?.holderId).toBeNull();
    expect(answer.after?.location).toBe(`Returns bin-${RUN}`);

    const onPerson = await rawRecordEvents('requester', student.id);
    expect(onPerson.map((event) => event.kind)).toContain('device_returned');

    // On the shelf, where the run puts returns, in the state it asks for.
    expect((await scan(netrider, device.assetTag, 'collect', { location: `Returns bin-${RUN}` })).outcome).toBe(
      'already',
    );
  });

  it('resolves without writing, for an audit', async () => {
    const device = await seedInventoryDevice({ location: `Room 118-${RUN}` });
    const answer = await scan(netrider, device.externalId, 'resolve');
    expect(answer.outcome).toBe('found');
    expect(answer.before?.location).toBe(`Room 118-${RUN}`);
    expect(await rawInventoryEvents('device', device.id)).toHaveLength(0);
  });

  it('attributes an assistant’s scan as the assistant’s', async () => {
    const device = await seedInventoryDevice();
    await scan(aiNetrider, device.assetTag, 'move', { location: `Cart AI${RUN}` });
    const events = await rawRecordEvents('inventory_device', device.id);
    expect(events[0].performed_via).toBe('ai');
  });
});

describe('undo', () => {
  it('puts a machine back exactly as it was', async () => {
    const device = await seedInventoryDevice({ location: `Lab-${RUN}` });
    await rpcOk(netrider, 'app_assign_inventory_device', { p_device: device.id, p_requester: staff.id });
    const answer = await scan(netrider, device.assetTag, 'collect', { location: `Returns-${RUN}` });

    const undone = await rpcOk<{ state: State }>(netrider, 'app_workflow_undo', {
      p_device: device.id,
      p_expect: answer.after,
      p_restore: answer.before,
    });
    expect(undone.state.holderId).toBe(staff.id);
    expect(undone.state.location).toBe(`Lab-${RUN}`);

    const row = await rawDevice(device.id);
    expect(row.assigned_requester_id).toBe(staff.id);
    expect(row.status).toBe('Assigned');
    expect(row.location).toBe(`Lab-${RUN}`);

    const events = await rawRecordEvents('inventory_device', device.id);
    expect(events.at(-1)?.kind).toBe('workflow_undone');
    const onPerson = await rawRecordEvents('requester', staff.id);
    expect(onPerson.at(-1)?.kind).toBe('device_assigned');
  });

  it('refuses when somebody changed the machine after the scan, and changes nothing', async () => {
    const device = await seedInventoryDevice({ location: `Lab-${RUN}` });
    const answer = await scan(netrider, device.assetTag, 'move', { location: `Cart Y${RUN}` });
    await rpcOk(admin, 'app_bulk_update_inventory', { p_ids: [device.id], p_patch: { location: 'Somewhere else' } });

    const refused = await rpcFails(netrider, 'app_workflow_undo', {
      p_device: device.id,
      p_expect: answer.after,
      p_restore: answer.before,
    });
    expect(refused.code).toBe(REJECTED);
    expect(refused.message).toContain('changed after the scan');
    expect((await rawDevice(device.id)).location).toBe('Somewhere else');
  });
});

describe('what is in one place', () => {
  it('lists the machines at a location, folded for case and trimmed', async () => {
    const place = `Room 312-${RUN}`;
    const first = await seedInventoryDevice({ location: place });
    const second = await seedInventoryDevice({ location: ` ${place.toLowerCase()} ` });
    await seedInventoryDevice({ location: `${place} annex` });

    const rows = await rpcOk<Array<{ id: string; state: State }>>(netrider, 'app_workflow_location_devices', {
      p_location: place.toUpperCase(),
    });
    expect(rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(rows[0].state).toHaveProperty('location');
  });
});

describe('who may', () => {
  it('refuses a skills officer every workflow function and shows them no shortcuts', async () => {
    const device = await seedInventoryDevice();
    for (const [fn, args] of [
      ['app_workflow_scan', { p_code: device.assetTag, p_action: 'resolve', p_target: {} }],
      ['app_workflow_location_devices', { p_location: 'Cart 4' }],
      ['app_workflow_find_person', { p_code: student.externalId }],
      ['app_workflow_undo', { p_device: device.id, p_expect: {}, p_restore: {} }],
      ['app_save_workflow_shortcut', { p_name: 'Nope', p_kind: 'move', p_location: 'Cart 1' }],
      ['app_record_workflow_run', { p_kind: 'move', p_label: 'Cart 1' }],
      ['app_list_workflow_runs', {}],
    ] as const) {
      const refused = await rpcFails(officer, fn, args);
      expect(refused.code, fn).toBe(REFUSED);
    }
    expect(await rpcOk<unknown[]>(officer, 'app_list_workflow_shortcuts')).toEqual([]);
  });

  it('gives the anonymous caller nothing at all', async () => {
    const { error } = await anonClient().rpc('app_workflow_scan', {
      p_code: 'X',
      p_action: 'resolve',
      p_target: {},
    });
    expect(error).not.toBeNull();
  });

  it('refuses a direct write to either table', async () => {
    const { error } = await netrider.from('workflow_shortcuts').insert({ name: 'Direct', kind: 'move' });
    expect(error).not.toBeNull();
    const { error: runError } = await netrider
      .from('workflow_runs')
      .insert({ kind: 'move', run_by: identity('owner').id });
    expect(runError).not.toBeNull();
  });
});

describe('shortcuts and runs', () => {
  it('are shared by the desk: one NetRider writes, an administrator edits and deletes', async () => {
    const name = `Load Cart ${RUN}`;
    const saved = await rpcOk<{ id: string; kind: string; status: string }>(netrider, 'app_save_workflow_shortcut', {
      p_name: name,
      p_kind: 'move',
      p_location: `Cart ${RUN}`,
      p_status: 'Available',
    });
    // A move keeps no status: a value that would silently do nothing is dropped.
    expect(saved.status).toBe('');

    const listed = await rpcOk<Array<{ id: string }>>(admin, 'app_list_workflow_shortcuts');
    expect(listed.map((row) => row.id)).toContain(saved.id);

    const duplicate = await rpcFails(admin, 'app_save_workflow_shortcut', {
      p_name: name.toUpperCase(),
      p_kind: 'audit',
      p_location: 'Room 1',
    });
    expect(duplicate.message).toContain('already exists');

    const edited = await rpcOk<{ name: string }>(admin, 'app_save_workflow_shortcut', {
      p_id: saved.id,
      p_name: `${name} (east)`,
      p_kind: 'move',
      p_location: `Cart ${RUN}`,
    });
    expect(edited.name).toBe(`${name} (east)`);

    await rpcOk(admin, 'app_delete_workflow_shortcut', { p_id: saved.id });
    const gone = await rpcFails(netrider, 'app_delete_workflow_shortcut', { p_id: saved.id });
    expect(gone.message).toContain('no longer there');
  });

  it('refuses a shortcut that is set up wrong', async () => {
    for (const args of [
      { p_name: '', p_kind: 'move', p_location: 'Cart 1' },
      { p_name: `No place ${RUN}`, p_kind: 'audit', p_location: '' },
      { p_name: `No status ${RUN}`, p_kind: 'status', p_status: '' },
      { p_name: `Hand ${RUN}`, p_kind: 'handout' },
      { p_name: `Assigned ${RUN}`, p_kind: 'status', p_status: 'Assigned' },
    ]) {
      expect((await rpcFails(netrider, 'app_save_workflow_shortcut', args)).code).toBe(REJECTED);
    }
  });

  it('records a finished run with its counts, and lists the newest first', async () => {
    const label = `Cart ${RUN}-${crypto.randomUUID().slice(0, 4)}`;
    const id = await rpcOk<string>(netrider, 'app_record_workflow_run', {
      p_kind: 'move',
      p_label: label,
      p_location: label,
      p_done: 28,
      p_skipped: 2,
      p_errors: 1,
      p_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const runs = await rpcOk<Array<{ id: string; label: string; done: number; runBy: string }>>(
      admin,
      'app_list_workflow_runs',
      { p_limit: 5 },
    );
    expect(runs[0].id).toBe(id);
    expect(runs[0].done).toBe(28);
    expect(runs[0].runBy).toBe(identity('owner').displayName);

    expect((await rpcFails(netrider, 'app_record_workflow_run', { p_kind: 'move', p_done: -1 })).code).toBe(
      REJECTED,
    );
  });
});
