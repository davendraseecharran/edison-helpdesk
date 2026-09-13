/**
 * M5 roster and inventory import: taking the school's spreadsheets into the
 * directory and the inventory without a technician retyping 2,800 people and
 * 7,500 machines.
 *
 * Three properties are what make an importer safe to hand an administrator, and
 * they are what this file proves.
 *
 * A dry run tells the truth and changes nothing. The counts an operator reads
 * before committing are computed by running the real writes inside a savepoint
 * and rolling it back, so "2 will be added" is not a second implementation that
 * can drift from the one that actually writes.
 *
 * One bad row does not lose the file. Every row is processed in its own nested
 * block, so a row that cannot be written is reported by its 1-based position in
 * the file the operator is looking at, and every other row still commits.
 *
 * The import cannot reach past what it is for. It never archives or restores a
 * person, it never invents a deployment with nobody holding the machine, and it
 * never lets a spreadsheet quietly move an identifier from one record to
 * another: a row whose OSIS, email or staff id already belongs to somebody else
 * is refused with the name of the identifier that collided.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, so no test proves something about a privileged path the
 * application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

/** insufficient_privilege and check_violation, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';

let service: SupabaseClient;
let admin: SupabaseClient;
let technician: SupabaseClient;

/** Fresh identifiers per run, so the suite survives a re-run without a reset. */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

function nextTag(): string {
  sequence += 1;
  return `${RUN_TAG}${String(sequence).padStart(4, '0')}`;
}

/** Nine digits: inside the 6-to-12 the OSIS check allows. */
function nextOsis(): string {
  return `9${nextTag()}`;
}

function nextStaffId(): string {
  return `EMP-${nextTag()}`;
}

function nextSerial(): string {
  return `SN${nextTag()}`;
}

function nextAssetTag(): string {
  return `DOE-LN${nextTag()}`;
}

// --- The row shapes src/lib/import/normalize.ts produces --------------------

interface PersonRow {
  kind: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  osis: string | null;
  staff_id: string | null;
  school_dbn: string | null;
  department: string | null;
  role_title: string | null;
  official_class: string | null;
  class_of: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  home_phone: string | null;
  address: string | null;
  notes: string | null;
}

interface DeviceHolder {
  kind: string | null;
  osis: string | null;
  staff_id: string | null;
  name: string | null;
}

interface DeviceRow {
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  status: string;
  location: string | null;
  notes: string | null;
  holder: DeviceHolder | null;
}

interface ImportResult {
  run_id: string | null;
  kind: string;
  mode: string;
  total: number;
  inserts: number;
  updates: number;
  unchanged: number;
  errors: Array<{ row: number; message: string }>;
  unmatched_holders: Array<{ row: number; holder: DeviceHolder }>;
  assignments_created: number;
}

interface ImportRunRow {
  id: string;
  kind: string;
  mode: string;
  actor_id: string;
  actor_name: string | null;
  at: string;
  row_count: number;
  inserted: number;
  updated: number;
  unchanged: number;
  error_count: number;
  summary: ImportResult;
}

/** A student row with a fresh OSIS, every other column blank as a sheet gives it. */
function personRow(over: Partial<PersonRow> = {}): PersonRow {
  const tag = nextTag();
  return {
    kind: 'student',
    first_name: 'Ada',
    last_name: `Quill ${tag}`,
    display_name: `Ada Quill ${tag}`,
    email: null,
    osis: `9${tag}`,
    staff_id: null,
    school_dbn: null,
    department: null,
    role_title: null,
    official_class: null,
    class_of: null,
    parent_name: null,
    parent_phone: null,
    home_phone: null,
    address: null,
    notes: null,
    ...over,
  };
}

function deviceRow(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: null,
    serial_number: nextSerial(),
    asset_tag: null,
    type: 'Laptop',
    manufacturer: 'Dell',
    model: 'Latitude 3440',
    os: 'WIN',
    status: 'in_stock',
    location: 'Room 212',
    notes: null,
    holder: null,
    ...over,
  };
}

function holder(over: Partial<DeviceHolder> = {}): DeviceHolder {
  return { kind: 'student', osis: null, staff_id: null, name: null, ...over };
}

async function runImport(
  client: SupabaseClient,
  kind: 'people' | 'devices',
  rows: unknown[],
  mode: 'dry_run' | 'commit',
): Promise<ImportResult> {
  return rpcOk<ImportResult>(client, 'app_admin_import', {
    p_kind: kind,
    p_rows: rows,
    p_mode: mode,
  });
}

/** Creates a directory record through the real RPC, so `source` is 'manual'. */
async function makePerson(over: Record<string, unknown> = {}): Promise<{
  id: string;
  osis: string | null;
  staff_id: string | null;
  display_name: string;
}> {
  const tag = nextTag();
  const person: Record<string, unknown> = {
    kind: 'student',
    first_name: 'Rae',
    last_name: `Nolan ${tag}`,
    display_name: `Rae Nolan ${tag}`,
    osis: `9${tag}`,
    ...over,
  };
  const id = await rpcOk<string>(admin, 'app_upsert_person', { p_person: person });
  return {
    id,
    osis: (person.osis as string | null) ?? null,
    staff_id: (person.staff_id as string | null) ?? null,
    display_name: person.display_name as string,
  };
}

async function rawPerson(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from('people').select('*').eq('id', id).single();
  if (error) throw new Error(`Could not read person ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function personByOsis(osis: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await service.from('people').select('*').eq('osis', osis).maybeSingle();
  if (error) throw new Error(`Could not read person by OSIS: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

async function deviceBySerial(serial: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await service
    .from('devices')
    .select('*')
    .eq('serial_number', serial)
    .maybeSingle();
  if (error) throw new Error(`Could not read device by serial: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

async function openAssignment(deviceId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await service
    .from('device_assignments')
    .select('*')
    .eq('device_id', deviceId)
    .is('returned_at', null)
    .maybeSingle();
  if (error) throw new Error(`Could not read assignment: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

async function assignmentCount(deviceId: string): Promise<number> {
  const { count, error } = await service
    .from('device_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('device_id', deviceId);
  if (error) throw new Error(`Could not count assignments: ${error.message}`);
  return count ?? 0;
}

async function importRunCount(): Promise<number> {
  const { count, error } = await service
    .from('import_runs')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`Could not count import runs: ${error.message}`);
  return count ?? 0;
}

async function recordEvents(
  entityType: string,
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('record_events')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read record events: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  service = adminServiceClient();
  admin = await signIn('admin');
  technician = await signIn('owner');
});

// ---------------------------------------------------------------------------

describe('who may import', () => {
  it('refuses a technician', async () => {
    const failure = await rpcFails(technician, 'app_admin_import', {
      p_kind: 'people',
      p_rows: [personRow()],
      p_mode: 'dry_run',
    });
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toContain('administrator');
  });

  it('refuses an anonymous caller', async () => {
    const failure = await rpcFails(anonClient(), 'app_admin_import', {
      p_kind: 'people',
      p_rows: [personRow()],
      p_mode: 'dry_run',
    });
    expect(failure.code).toBe(REFUSED);
  });

  it('refuses a technician the list of runs', async () => {
    const failure = await rpcFails(technician, 'app_admin_import_runs', {});
    expect(failure.code).toBe(REFUSED);
  });

  it('shows a technician no import runs through the table', async () => {
    const { data, error } = await technician.from('import_runs').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('refuses an insert into import_runs from an administrator session', async () => {
    const { error } = await admin.from('import_runs').insert({
      kind: 'people',
      mode: 'commit',
      actor_id: identity('admin').id,
      row_count: 1,
    });
    expect(error).not.toBeNull();
  });
});

describe('what the call will accept', () => {
  it('refuses a kind that is not people or devices', async () => {
    const failure = await rpcFails(admin, 'app_admin_import', {
      p_kind: 'teachers',
      p_rows: [],
      p_mode: 'dry_run',
    });
    expect(failure.code).toBe(REJECTED);
  });

  it('refuses rows that are not a list', async () => {
    const failure = await rpcFails(admin, 'app_admin_import', {
      p_kind: 'people',
      p_rows: { kind: 'student' },
      p_mode: 'dry_run',
    });
    expect(failure.code).toBe(REJECTED);
  });

  it('refuses more than 5000 rows', async () => {
    const rows = Array.from({ length: 5001 }, () => ({}));
    const failure = await rpcFails(admin, 'app_admin_import', {
      p_kind: 'people',
      p_rows: rows,
      p_mode: 'dry_run',
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toContain('5000');
  });

  it('accepts an empty file and reports nothing to do', async () => {
    const result = await runImport(admin, 'people', [], 'dry_run');
    expect(result.total).toBe(0);
    expect(result.inserts).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('importing people', () => {
  it('reports a dry run and writes nothing', async () => {
    const rows = [personRow(), personRow()];
    const before = await importRunCount();

    const result = await runImport(admin, 'people', rows, 'dry_run');

    expect(result.mode).toBe('dry_run');
    expect(result.kind).toBe('people');
    expect(result.run_id).toBeNull();
    expect(result.total).toBe(2);
    expect(result.inserts).toBe(2);
    expect(result.updates).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toEqual([]);

    expect(await personByOsis(rows[0].osis as string)).toBeNull();
    expect(await personByOsis(rows[1].osis as string)).toBeNull();
    expect(await importRunCount()).toBe(before);
  });

  it('commits the rows a dry run promised, marked as imported', async () => {
    const rows = [
      personRow({ department: 'Science' }),
      personRow({ kind: 'staff', osis: null, staff_id: nextStaffId(), department: 'Science' }),
    ];

    const dry = await runImport(admin, 'people', rows, 'dry_run');
    expect(dry.inserts).toBe(2);

    const result = await runImport(admin, 'people', rows, 'commit');
    expect(result.mode).toBe('commit');
    expect(result.inserts).toBe(2);
    expect(result.run_id).not.toBeNull();

    const student = await personByOsis(rows[0].osis as string);
    expect(student).not.toBeNull();
    expect(student?.source).toBe('import');
    expect(student?.display_name).toBe(rows[0].display_name);
    expect(student?.department).toBe('Science');
    expect(student?.active).toBe(true);
  });

  it('reports the same rows as unchanged the second time', async () => {
    const rows = [personRow(), personRow()];
    await runImport(admin, 'people', rows, 'commit');

    const again = await runImport(admin, 'people', rows, 'commit');
    expect(again.inserts).toBe(0);
    expect(again.updates).toBe(0);
    expect(again.unchanged).toBe(2);
  });

  it('counts only the row whose field changed as updated', async () => {
    const first = personRow({ department: 'Science' });
    const second = personRow({ department: 'Science' });
    await runImport(admin, 'people', [first, second], 'commit');

    const result = await runImport(
      admin,
      'people',
      [{ ...first, department: 'Mathematics' }, second],
      'commit',
    );
    expect(result.updates).toBe(1);
    expect(result.unchanged).toBe(1);

    const changed = await personByOsis(first.osis as string);
    expect(changed?.department).toBe('Mathematics');
  });

  it('leaves a field the sheet left blank alone', async () => {
    const row = personRow({ department: 'Science', notes: 'Lost a charger.' });
    await runImport(admin, 'people', [row], 'commit');

    const result = await runImport(
      admin,
      'people',
      [{ ...row, notes: null, department: 'Mathematics' }],
      'commit',
    );
    expect(result.updates).toBe(1);

    const person = await personByOsis(row.osis as string);
    expect(person?.notes).toBe('Lost a charger.');
    expect(person?.department).toBe('Mathematics');
  });

  it('normalises identifiers the way the directory stores them', async () => {
    const tag = nextTag();
    const row = personRow({
      kind: ' Staff ',
      osis: null,
      staff_id: ` emp-${tag} `,
      email: `  Jo.Fielding.${tag}@Edison.Example `,
    });

    await runImport(admin, 'people', [row], 'commit');

    const { data } = await service
      .from('people')
      .select('*')
      .eq('staff_id', `EMP-${tag}`)
      .maybeSingle();
    expect(data).not.toBeNull();
    expect(data?.kind).toBe('staff');
    expect(data?.email).toBe(`jo.fielding.${tag}@edison.example`);
  });

  it('strips the separators a spreadsheet puts in an OSIS', async () => {
    const osis = nextOsis();
    const spaced = `${osis.slice(0, 3)},${osis.slice(3, 6)},${osis.slice(6)}`;
    await runImport(admin, 'people', [personRow({ osis: spaced })], 'commit');
    expect(await personByOsis(osis)).not.toBeNull();
  });

  it('reports a bad row by its position and still commits the others', async () => {
    const rows = [personRow(), personRow({ kind: 'faculty' }), personRow()];

    const result = await runImport(admin, 'people', rows, 'commit');

    expect(result.total).toBe(3);
    expect(result.inserts).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(2);
    expect(result.errors[0].message).toContain('student or staff');

    expect(await personByOsis(rows[0].osis as string)).not.toBeNull();
    expect(await personByOsis(rows[1].osis as string)).toBeNull();
    expect(await personByOsis(rows[2].osis as string)).not.toBeNull();
  });

  it('reports a row with no name', async () => {
    const result = await runImport(
      admin,
      'people',
      [personRow({ first_name: null, last_name: null, display_name: null })],
      'commit',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('name');
    expect(result.inserts).toBe(0);
  });

  it('reports a row with no identifier to match on', async () => {
    const result = await runImport(
      admin,
      'people',
      [personRow({ osis: null, staff_id: null, email: null })],
      'commit',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(1);
    expect(result.inserts).toBe(0);
  });

  it('refuses a row whose email already belongs to another person', async () => {
    const tag = nextTag();
    const email = `taylor.mendez.${tag}@edison.example`;
    const other = await makePerson({ email });
    const row = personRow({ email });

    const result = await runImport(admin, 'people', [row], 'commit');

    expect(result.inserts).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('already has the address');
    expect(await personByOsis(row.osis as string)).toBeNull();

    const untouched = await rawPerson(other.id);
    expect(untouched.email).toBe(email);
  });

  it('refuses a row whose OSIS belongs to a different record than its staff id', async () => {
    const student = await makePerson();
    const staffId = nextStaffId();
    await makePerson({ kind: 'staff', osis: null, staff_id: staffId });

    const result = await runImport(
      admin,
      'people',
      [personRow({ kind: 'staff', osis: student.osis, staff_id: staffId })],
      'commit',
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('staff id');
    expect(result.updates).toBe(0);
  });

  it('never changes whether a person is archived', async () => {
    const row = personRow({ department: 'Science' });
    await runImport(admin, 'people', [row], 'commit');
    const person = await personByOsis(row.osis as string);
    await rpcOk(admin, 'app_set_person_active', {
      p_person: person?.id as string,
      p_active: false,
    });

    const result = await runImport(
      admin,
      'people',
      [{ ...row, department: 'Mathematics' }],
      'commit',
    );
    expect(result.updates).toBe(1);

    const after = await rawPerson(person?.id as string);
    expect(after.active).toBe(false);
    expect(after.department).toBe('Mathematics');
  });

  it('refuses a row that tries to archive somebody', async () => {
    const result = await runImport(
      admin,
      'people',
      [{ ...personRow(), active: false }],
      'commit',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('administrator');
    expect(result.inserts).toBe(0);
  });

  it('leaves a hand-entered record marked manual when it corrects it', async () => {
    const person = await makePerson({ department: 'Science' });

    const result = await runImport(
      admin,
      'people',
      [personRow({ osis: person.osis, display_name: person.display_name, department: 'Art' })],
      'commit',
    );
    expect(result.updates).toBe(1);

    const after = await rawPerson(person.id);
    expect(after.source).toBe('manual');
    expect(after.department).toBe('Art');
  });

  it('records what changed in the person history by field name', async () => {
    const row = personRow({ address: '19 Beech Lane' });
    await runImport(admin, 'people', [row], 'commit');
    const person = await personByOsis(row.osis as string);

    const events = await recordEvents('person', person?.id as string);
    expect(events.map((event) => event.kind)).toContain('created');
    const detail = events.map((event) => String(event.detail ?? '')).join(' ');
    expect(detail).toContain('address');
    expect(detail).not.toContain('19 Beech Lane');
  });
});

describe('importing devices', () => {
  it('reports a dry run and writes nothing', async () => {
    const row = deviceRow();
    const result = await runImport(admin, 'devices', [row], 'dry_run');

    expect(result.kind).toBe('devices');
    expect(result.inserts).toBe(1);
    expect(result.run_id).toBeNull();
    expect(await deviceBySerial(row.serial_number as string)).toBeNull();
  });

  it('commits a device marked as imported', async () => {
    const row = deviceRow({ asset_tag: nextAssetTag() });
    const result = await runImport(admin, 'devices', [row], 'commit');
    expect(result.inserts).toBe(1);

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.source).toBe('import');
    expect(device?.status).toBe('in_stock');
    expect(device?.asset_tag).toBe(row.asset_tag);
  });

  it('matches a device again by serial whatever case the sheet used', async () => {
    const row = deviceRow();
    await runImport(admin, 'devices', [row], 'commit');

    const again = await runImport(
      admin,
      'devices',
      [{ ...row, serial_number: (row.serial_number as string).toLowerCase() }],
      'commit',
    );
    expect(again.inserts).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it('refuses a row whose serial already belongs to another machine', async () => {
    const first = deviceRow();
    await runImport(admin, 'devices', [first], 'commit');

    const result = await runImport(
      admin,
      'devices',
      [deviceRow({ device_id: `PW${nextTag()}-WIN`, serial_number: first.serial_number })],
      'commit',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('serial number');
    expect(result.inserts).toBe(0);
  });

  it('reports a row with no identifier at all', async () => {
    const result = await runImport(
      admin,
      'devices',
      [deviceRow({ serial_number: null })],
      'commit',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('asset tag');
  });

  it('assigns the machine to the student the holder column names', async () => {
    const student = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: student.osis }),
    });

    const result = await runImport(admin, 'devices', [row], 'commit');

    expect(result.inserts).toBe(1);
    expect(result.assignments_created).toBe(1);
    expect(result.unmatched_holders).toEqual([]);

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('deployed');

    const assignment = await openAssignment(device?.id as string);
    expect(assignment?.person_id).toBe(student.id);
    expect(assignment?.assigned_by).toBe(identity('admin').id);
    expect(assignment?.note).toBe('Imported from spreadsheet');

    const deviceEvents = await recordEvents('device', device?.id as string);
    expect(deviceEvents.map((event) => event.kind)).toContain('assigned');
    const personEvents = await recordEvents('person', student.id);
    expect(personEvents.map((event) => event.kind)).toContain('device_assigned');
  });

  it('assigns a staff machine by staff id', async () => {
    const staffId = nextStaffId();
    const person = await makePerson({ kind: 'staff', osis: null, staff_id: staffId });
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'staff', staff_id: staffId.toLowerCase() }),
    });

    const result = await runImport(admin, 'devices', [row], 'commit');
    expect(result.assignments_created).toBe(1);

    const device = await deviceBySerial(row.serial_number as string);
    const assignment = await openAssignment(device?.id as string);
    expect(assignment?.person_id).toBe(person.id);
  });

  it('matches a holder by name when the sheet gives no identifier', async () => {
    const person = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', name: person.display_name.toUpperCase() }),
    });

    const result = await runImport(admin, 'devices', [row], 'commit');
    expect(result.assignments_created).toBe(1);

    const device = await deviceBySerial(row.serial_number as string);
    const assignment = await openAssignment(device?.id as string);
    expect(assignment?.person_id).toBe(person.id);
  });

  it('leaves an ambiguous name unmatched rather than guessing', async () => {
    const tag = nextTag();
    const name = `Jamie Torres ${tag}`;
    await makePerson({ display_name: name });
    await makePerson({ display_name: name });

    const row = deviceRow({ status: 'deployed', holder: holder({ name }) });
    const result = await runImport(admin, 'devices', [row], 'commit');

    expect(result.assignments_created).toBe(0);
    expect(result.unmatched_holders).toHaveLength(1);
    expect(result.unmatched_holders[0].row).toBe(1);
    expect(result.errors).toEqual([]);

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('in_stock');
  });

  it('lists an unknown holder and still imports the machine', async () => {
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: nextOsis(), name: 'Nobody In The Directory' }),
    });

    const result = await runImport(admin, 'devices', [row], 'commit');

    expect(result.inserts).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.assignments_created).toBe(0);
    expect(result.unmatched_holders).toHaveLength(1);
    expect(result.unmatched_holders[0].holder.name).toBe('Nobody In The Directory');

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('in_stock');
    expect(await assignmentCount(device?.id as string)).toBe(0);
  });

  it('stores a deployed row with no holder as in stock', async () => {
    const row = deviceRow({ status: 'deployed', holder: null });
    const result = await runImport(admin, 'devices', [row], 'commit');

    expect(result.errors).toEqual([]);
    expect(result.unmatched_holders).toEqual([]);

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('in_stock');
  });

  it('does not assign the machine twice to the same person', async () => {
    const student = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: student.osis }),
    });
    await runImport(admin, 'devices', [row], 'commit');

    const again = await runImport(admin, 'devices', [row], 'commit');
    expect(again.assignments_created).toBe(0);
    expect(again.unchanged).toBe(1);

    const device = await deviceBySerial(row.serial_number as string);
    expect(await assignmentCount(device?.id as string)).toBe(1);
  });

  it('hands the machine over when the sheet names a different holder', async () => {
    const first = await makePerson();
    const second = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: first.osis }),
    });
    await runImport(admin, 'devices', [row], 'commit');

    const result = await runImport(
      admin,
      'devices',
      [{ ...row, holder: holder({ kind: 'student', osis: second.osis }) }],
      'commit',
    );
    expect(result.assignments_created).toBe(1);
    expect(result.updates).toBe(1);

    const device = await deviceBySerial(row.serial_number as string);
    const open = await openAssignment(device?.id as string);
    expect(open?.person_id).toBe(second.id);
    expect(await assignmentCount(device?.id as string)).toBe(2);

    const events = await recordEvents('person', first.id);
    expect(events.map((event) => event.kind)).toContain('device_returned');
  });

  it('does not take a machine back because the sheet left the holder blank', async () => {
    const student = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: student.osis }),
    });
    await runImport(admin, 'devices', [row], 'commit');

    await runImport(
      admin,
      'devices',
      [{ ...row, status: 'in_stock', holder: null }],
      'commit',
    );

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('deployed');
    const open = await openAssignment(device?.id as string);
    expect(open?.person_id).toBe(student.id);
  });

  it('writes nothing at all on a dry run that would assign', async () => {
    const student = await makePerson();
    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: student.osis }),
    });

    const result = await runImport(admin, 'devices', [row], 'dry_run');
    expect(result.assignments_created).toBe(1);
    expect(await deviceBySerial(row.serial_number as string)).toBeNull();

    const events = await recordEvents('person', student.id);
    expect(events.map((event) => event.kind)).not.toContain('device_assigned');
  });

  it('will not hold a machine for an archived person', async () => {
    const student = await makePerson();
    await rpcOk(admin, 'app_set_person_active', { p_person: student.id, p_active: false });

    const row = deviceRow({
      status: 'deployed',
      holder: holder({ kind: 'student', osis: student.osis }),
    });
    const result = await runImport(admin, 'devices', [row], 'commit');

    expect(result.assignments_created).toBe(0);
    expect(result.unmatched_holders).toHaveLength(1);

    const device = await deviceBySerial(row.serial_number as string);
    expect(device?.status).toBe('in_stock');
  });
});

describe('the record of what was imported', () => {
  it('records a committed run with its counts and its summary', async () => {
    const rows = [personRow(), personRow({ kind: 'faculty' })];
    const result = await runImport(admin, 'people', rows, 'commit');

    const runs = await rpcOk<ImportRunRow[]>(admin, 'app_admin_import_runs', { p_limit: 5 });
    const run = runs.find((entry) => entry.id === result.run_id);
    expect(run).toBeDefined();
    expect(run?.kind).toBe('people');
    expect(run?.mode).toBe('commit');
    expect(run?.actor_id).toBe(identity('admin').id);
    expect(run?.actor_name).toBe(identity('admin').displayName);
    expect(run?.row_count).toBe(2);
    expect(run?.inserted).toBe(1);
    expect(run?.error_count).toBe(1);
    expect(run?.summary.errors).toHaveLength(1);
    expect(run?.summary.run_id).toBe(result.run_id);
  });

  it('lists the newest run first', async () => {
    await runImport(admin, 'people', [personRow()], 'commit');
    const last = await runImport(admin, 'devices', [deviceRow()], 'commit');

    const runs = await rpcOk<ImportRunRow[]>(admin, 'app_admin_import_runs', { p_limit: 5 });
    expect(runs[0].id).toBe(last.run_id);
    expect(runs[0].kind).toBe('devices');
  });

  it('writes one import event naming what was brought in', async () => {
    const result = await runImport(admin, 'people', [personRow(), personRow()], 'commit');
    const events = await recordEvents('import', result.run_id as string);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('committed');
    expect(String(events[0].summary)).toContain('2');
    expect(events[0].actor_id).toBe(identity('admin').id);
  });

  it('records no run and no event for a dry run', async () => {
    const before = await importRunCount();
    await runImport(admin, 'people', [personRow()], 'dry_run');
    expect(await importRunCount()).toBe(before);
  });
});
