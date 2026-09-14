/**
 * M5 people directory: the roster the helpdesk looks a requester up in.
 *
 * The directory is not helpdesk paperwork — it is a list of children, with their
 * home addresses and their parents' phone numbers in it. So the rules proven
 * here are about who may see it and who may change it, not only about whether
 * the columns are correct:
 *
 *   1. Only an ACTIVE account reads the directory. Anonymous callers are refused
 *      outright; an account awaiting setup, awaiting an access decision, denied,
 *      or deactivated sees an empty directory rather than an error, because the
 *      row-level policy — not a filter in the application — is what hides it.
 *   2. Any active technician may add and correct a person, because keeping the
 *      roster right is the ordinary work of the helpdesk. Archiving a record is
 *      not: `app_set_person_active` is administrators only, and sending `active`
 *      to the upsert is refused rather than quietly ignored, because a no-op
 *      that returns a person id reports success for a change that did not
 *      happen.
 *   3. The table takes no session writes at all. Every change goes through the
 *      RPCs, so every change is attributed and recorded.
 *   4. What changed is recorded by FIELD NAME. Person history is readable by
 *      every technician, so writing the old and new value of `home_phone` into
 *      it would quietly publish the very thing the directory is careful about.
 *   5. Identifiers arrive from spreadsheets, so they are normalised (an OSIS
 *      with thousands separators, an address typed in capitals) and a collision
 *      is reported in words an operator can act on rather than as an index name.
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
let owner: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let inactive: SupabaseClient;
let pendingApproval: SupabaseClient;
let denied: SupabaseClient;

/** The OSIS the brief names, used by the one test that must own it exactly. */
const BRIEF_OSIS = '240000123';
const DEPARTMENT = 'Technology';
const CLASS_OF = '2027';

/**
 * Fresh identifiers per run so the suite can be re-run against a database that
 * was not reset. OSIS numbers are nine digits, like the real ones, but the
 * leading `2` plus a per-run tag keeps them out of any plausible real range.
 */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

function nextOsis(): string {
  sequence += 1;
  return `2${RUN_TAG}${String(sequence).padStart(4, '0')}`;
}

function nextEmail(name: string): string {
  sequence += 1;
  return `${name}.${RUN_TAG}${sequence}@edison.example`;
}

interface PersonListRow {
  id: string;
  kind: string;
  display_name: string;
  email: string | null;
  osis: string | null;
  staff_id: string | null;
  department: string | null;
  role_title: string | null;
  official_class: string | null;
  class_of: string | null;
  active: boolean;
  device_count: number;
  open_ticket_count: number;
  total_count: number;
}

interface PersonDetail {
  person: Record<string, unknown>;
  devices: unknown[];
  tickets: unknown[];
  events: Array<Record<string, unknown>>;
}

interface Facets {
  departments: string[];
  class_years: string[];
}

async function upsert(
  client: SupabaseClient,
  person: Record<string, unknown>,
): Promise<string> {
  return rpcOk<string>(client, 'app_upsert_person', { p_person: person });
}

async function list(
  client: SupabaseClient,
  args: Record<string, unknown> = {},
): Promise<PersonListRow[]> {
  return rpcOk<PersonListRow[]>(client, 'app_list_people_m5', args);
}

/** Ground truth straight from the table, bypassing every read path under test. */
async function rawPerson(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from('people').select('*').eq('id', id).single();
  if (error) throw new Error(`Could not read person ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function personEvents(id: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('record_events')
    .select('*')
    .eq('entity_type', 'person')
    .eq('entity_id', id)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read person history: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** A complete, ordinary student, unique to this call unless overridden. */
function student(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'student',
    first_name: 'Rowan',
    last_name: 'Vance',
    osis: nextOsis(),
    email: nextEmail('rowan.vance'),
    official_class: '10A',
    class_of: CLASS_OF,
    ...overrides,
  };
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, unrelated, pending, inactive, pendingApproval, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('inactive'),
    signIn('pendingApproval'),
    signIn('denied'),
  ]);

  // The one fixed identifier this suite uses has to be free even on a re-run
  // against a database that was not reset.
  await service.from('people').delete().eq('osis', BRIEF_OSIS);
});

describe('adding a person', () => {
  it('lets a technician add a student and find them by OSIS', async () => {
    const personId = await upsert(owner, {
      kind: 'student',
      first_name: 'Rowan',
      last_name: 'Vance',
      osis: BRIEF_OSIS,
      email: nextEmail('rowan.vance'),
      official_class: '10A',
      class_of: CLASS_OF,
    });

    const rows = await list(owner, { p_query: BRIEF_OSIS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(personId);
    expect(rows[0]?.display_name).toBe('Rowan Vance');
    expect(rows[0]?.kind).toBe('student');
    expect(rows[0]?.active).toBe(true);
    expect(Number(rows[0]?.total_count)).toBe(1);
    // Task 9 and Task 10 fill these in; the columns exist now so the shape the
    // UI reads does not change under it later.
    expect(rows[0]?.device_count).toBe(0);
    expect(rows[0]?.open_ticket_count).toBe(0);
  });

  it('records who added them, and says so in the person history', async () => {
    const personId = await upsert(owner, student({ first_name: 'Imogen', last_name: 'Ruiz' }));

    const events = await personEvents(personId);
    expect(events.map((event) => event.kind)).toEqual(['created']);
    expect(events[0]?.actor_id).toBe(identity('owner').id);
    expect(String(events[0]?.summary)).toContain('Imogen Ruiz');
    expect(events[0]?.performed_via).toBe('user');
  });

  it('derives the display name from the first and last name when none is given', async () => {
    const personId = await upsert(owner, student({ first_name: '  Iris ', last_name: ' Nakamura ' }));
    expect((await rawPerson(personId)).display_name).toBe('Iris Nakamura');
  });

  it('keeps a display name that was given, rather than rebuilding it', async () => {
    const personId = await upsert(
      owner,
      student({ first_name: 'Theodore', last_name: 'Ashby', display_name: 'Teddy Ashby' }),
    );
    expect((await rawPerson(personId)).display_name).toBe('Teddy Ashby');
  });

  it('normalises what a spreadsheet hands over: case, padding and separators', async () => {
    const osis = nextOsis();
    const spaced = `${osis.slice(0, 3)},${osis.slice(3, 6)} ${osis.slice(6)}`;
    const email = nextEmail('harper.quinn');
    const personId = await upsert(owner, {
      kind: 'STAFF',
      first_name: 'Harper',
      last_name: 'Quinn',
      osis: spaced,
      email: `  ${email.toUpperCase()}  `,
      department: '   ',
      notes: '',
    });

    const row = await rawPerson(personId);
    expect(row.kind).toBe('staff');
    expect(row.osis).toBe(osis);
    expect(row.email).toBe(email);
    // An empty cell is an absent value, not the empty string.
    expect(row.department).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.source).toBe('manual');
  });

  it('folds a staff id, so two spellings of it are one identifier', async () => {
    const staffId = `EMP-${RUN_TAG}-F`;
    const personId = await upsert(owner, {
      kind: 'staff',
      first_name: 'Odette',
      last_name: 'Marchetti',
      staff_id: `  ${staffId.toLowerCase()}  `,
    });
    expect((await rawPerson(personId)).staff_id).toBe(staffId);

    const clash = await rpcFails(owner, 'app_upsert_person', {
      p_person: {
        kind: 'staff',
        first_name: 'Second',
        last_name: 'Claim',
        staff_id: staffId.toLowerCase(),
      },
    });
    expect(clash.message).toMatch(/already has staff id/i);
  });

  it('refuses a second person with the same OSIS, in words an operator can act on', async () => {
    const failure = await rpcFails(owner, 'app_upsert_person', {
      p_person: {
        kind: 'student',
        first_name: 'Different',
        last_name: 'Student',
        osis: BRIEF_OSIS,
      },
    });

    expect(failure.message).toMatch(/already has OSIS/i);
    expect(failure.message).toContain(BRIEF_OSIS);
    // Never the raw index name.
    expect(failure.message).not.toMatch(/people_osis_idx|duplicate key/i);
  });

  it('refuses a duplicate email address and a duplicate staff id too', async () => {
    const email = nextEmail('dup.address');
    const staffId = `EMP-${RUN_TAG}-A`;
    await upsert(owner, {
      kind: 'staff',
      first_name: 'Original',
      last_name: 'Record',
      email,
      staff_id: staffId,
    });

    const sameEmail = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'staff', first_name: 'Second', last_name: 'Record', email },
    });
    expect(sameEmail.message).toMatch(/already/i);
    expect(sameEmail.message).not.toMatch(/people_email_idx|duplicate key/i);

    const sameStaffId = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'staff', first_name: 'Third', last_name: 'Record', staff_id: staffId },
    });
    expect(sameStaffId.message).toMatch(/already/i);
    expect(sameStaffId.message).not.toMatch(/people_staff_id_idx|duplicate key/i);
  });

  it('requires a kind, a name, a believable OSIS and a believable email', async () => {
    const noKind = await rpcFails(owner, 'app_upsert_person', {
      p_person: { first_name: 'Nameless', last_name: 'Kindless' },
    });
    expect(noKind.code).toBe(REJECTED);
    expect(noKind.message).toMatch(/student or staff/i);

    const wrongKind = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'parent', first_name: 'Wrong', last_name: 'Kind' },
    });
    expect(wrongKind.code).toBe(REJECTED);

    const noName = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'student', first_name: '  ', last_name: '' },
    });
    expect(noName.code).toBe(REJECTED);
    expect(noName.message).toMatch(/name/i);

    const badOsis = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'student', first_name: 'Bad', last_name: 'Osis', osis: '12A45' },
    });
    expect(badOsis.code).toBe(REJECTED);
    expect(badOsis.message).toMatch(/digits/i);

    const badEmail = await rpcFails(owner, 'app_upsert_person', {
      p_person: { kind: 'staff', first_name: 'Bad', last_name: 'Email', email: 'not-an-address' },
    });
    expect(badEmail.code).toBe(REJECTED);
    expect(badEmail.message).toMatch(/email/i);
  });
});

describe('correcting a person', () => {
  it('changes only the fields that were sent, and records them by name', async () => {
    const personId = await upsert(
      owner,
      student({ first_name: 'Marisol', last_name: 'Ferrer', department: 'Science' }),
    );
    const before = await rawPerson(personId);

    await upsert(owner, {
      id: personId,
      role_title: 'Peer tutor',
      department: DEPARTMENT,
      // Not a directory column: ignored rather than refused, so a richer import
      // row does not fail over a field the directory does not keep.
      homeroom_teacher: 'Ms. Calloway',
    });

    const after = await rawPerson(personId);
    expect(after.role_title).toBe('Peer tutor');
    expect(after.department).toBe(DEPARTMENT);
    // Untouched keys keep their values.
    expect(after.display_name).toBe(before.display_name);
    expect(after.osis).toBe(before.osis);
    expect(after.class_of).toBe(before.class_of);
    expect(String(after.updated_at) > String(before.updated_at)).toBe(true);

    const events = await personEvents(personId);
    expect(events.map((event) => event.kind)).toEqual(['created', 'updated']);
    const detail = String(events.at(-1)?.detail);
    expect(detail).toContain('department');
    expect(detail).toContain('role_title');
    // Field names only: the values themselves are never copied into history.
    expect(detail).not.toContain('Peer tutor');
    expect(detail).not.toContain(DEPARTMENT);
  });

  it('clears a field when it is sent empty', async () => {
    const personId = await upsert(owner, student({ home_phone: '212-555-0143' }));
    await upsert(owner, { id: personId, home_phone: '' });

    expect((await rawPerson(personId)).home_phone).toBeNull();
    expect(String((await personEvents(personId)).at(-1)?.detail)).toContain('home_phone');
  });

  it('writes no history for an update that changes nothing', async () => {
    const personId = await upsert(owner, student({ first_name: 'Unchanged', last_name: 'Record' }));
    await upsert(owner, { id: personId, first_name: 'Unchanged' });

    expect((await personEvents(personId)).map((event) => event.kind)).toEqual(['created']);
  });

  it('refuses an id that is not in the directory', async () => {
    const failure = await rpcFails(owner, 'app_upsert_person', {
      p_person: { id: '00000000-0000-0000-0000-000000000000', first_name: 'Ghost' },
    });
    expect(failure.message).toMatch(/not in the directory/i);
  });

  it('refuses an upsert that sends active, and says where archiving is done', async () => {
    const personId = await upsert(owner, student({ first_name: 'Still', last_name: 'Enrolled' }));

    for (const [label, client] of [
      ['a technician', owner],
      ['an administrator', admin],
    ] as const) {
      const failure = await rpcFails(client, 'app_upsert_person', {
        p_person: { id: personId, active: false, role_title: 'Student' },
      });
      expect(failure.code, label).toBe(REJECTED);
      expect(failure.message, label).toMatch(/administrator/i);
    }

    const row = await rawPerson(personId);
    expect(row.active).toBe(true);
    // Refused outright rather than partially applied: a silent no-op would have
    // reported success for a change that did not happen.
    expect(row.role_title).toBeNull();
  });

  it('leaves the source alone when it is sent empty', async () => {
    const personId = await upsert(owner, student({ source: 'import' }));
    expect((await rawPerson(personId)).source).toBe('import');

    await upsert(owner, { id: personId, source: '', role_title: 'Transfer' });

    const row = await rawPerson(personId);
    // An empty source is no instruction at all, not an instruction to forget
    // that this record came from a roster import.
    expect(row.source).toBe('import');
    expect(row.role_title).toBe('Transfer');
  });
});

describe('archiving a person', () => {
  it('takes an archived person out of the default list and back in on request', async () => {
    const osis = nextOsis();
    const personId = await upsert(owner, student({ osis, first_name: 'Devon', last_name: 'Blake' }));

    await rpcOk(admin, 'app_set_person_active', { p_person: personId, p_active: false });

    expect(await list(owner, { p_query: osis })).toHaveLength(0);

    const everyone = await list(owner, { p_query: osis, p_active: null });
    expect(everyone.map((row) => row.id)).toEqual([personId]);
    expect(everyone[0]?.active).toBe(false);

    const archived = await list(owner, { p_query: osis, p_active: false });
    expect(archived.map((row) => row.id)).toEqual([personId]);

    const events = await personEvents(personId);
    expect(events.map((event) => event.kind)).toContain('deactivated');
    expect(events.at(-1)?.actor_id).toBe(identity('admin').id);

    await rpcOk(admin, 'app_set_person_active', { p_person: personId, p_active: true });
    expect(await list(owner, { p_query: osis })).toHaveLength(1);
    expect((await personEvents(personId)).map((event) => event.kind)).toContain('reactivated');
  });

  it('is closed to a technician', async () => {
    const personId = await upsert(owner, student({ first_name: 'Protected', last_name: 'Record' }));

    const failure = await rpcFails(owner, 'app_set_person_active', {
      p_person: personId,
      p_active: false,
    });
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/administrator/i);
    expect((await rawPerson(personId)).active).toBe(true);
  });
});

describe('searching and paging', () => {
  it('matches a name anywhere, and an identifier from its start', async () => {
    const osis = nextOsis();
    const staffId = `EMP-${RUN_TAG}-B`;
    const email = nextEmail('lucia.moreau');
    const personId = await upsert(owner, {
      kind: 'staff',
      first_name: 'Lucia',
      last_name: 'Moreau',
      osis,
      staff_id: staffId,
      email,
      department: DEPARTMENT,
      role_title: 'Librarian',
    });

    const byNameFragment = await list(owner, { p_query: 'ucia Mor' });
    expect(byNameFragment.map((row) => row.id)).toContain(personId);

    const byOsisPrefix = await list(owner, { p_query: osis.slice(0, 6) });
    expect(byOsisPrefix.map((row) => row.id)).toContain(personId);

    const byStaffIdPrefix = await list(owner, { p_query: staffId.slice(0, 8) });
    expect(byStaffIdPrefix.map((row) => row.id)).toContain(personId);

    const byEmailPrefix = await list(owner, { p_query: email.slice(0, 9) });
    expect(byEmailPrefix.map((row) => row.id)).toContain(personId);

    // An identifier matches from its START only, so a search does not turn into
    // a scan over every address in the school. The run tag sits in the middle of
    // this person's address and their OSIS without starting either, so it finds
    // neither.
    const byIdentifierMiddle = await list(owner, { p_query: RUN_TAG });
    expect(byIdentifierMiddle.map((row) => row.id)).not.toContain(personId);
  });

  it('treats a wildcard typed into the search box as text', async () => {
    const personId = await upsert(owner, student({ first_name: 'Percy', last_name: 'Underwood' }));
    // Sanity: the person is findable by an ordinary search.
    expect((await list(owner, { p_query: 'Underwood' })).map((row) => row.id)).toContain(personId);

    // `%` used to mean "every person in the school"; `_` used to mean "any
    // character". They are now literal, and nobody has one in their name.
    expect(await list(owner, { p_query: '%' })).toHaveLength(0);
    expect(await list(owner, { p_query: '_nderwood' })).toHaveLength(0);
    expect(await list(owner, { p_query: '\\' })).toHaveLength(0);
    expect(await list(owner, { p_query: 'Under%wood' })).toHaveLength(0);
  });

  it('filters by kind, department and class year', async () => {
    const department = `Facilities ${RUN_TAG}`;
    const staffId = await upsert(owner, {
      kind: 'staff',
      first_name: 'Bertram',
      last_name: 'Oyelaran',
      department,
      staff_id: `EMP-${RUN_TAG}-C`,
    });
    // A class year no other test in this file uses, and not the shared one.
    const classOf = `18${RUN_TAG.slice(0, 2)}`;
    const studentId = await upsert(owner, student({ class_of: classOf }));

    expect((await list(owner, { p_department: department })).map((row) => row.id)).toEqual([
      staffId,
    ]);
    expect((await list(owner, { p_class_of: classOf })).map((row) => row.id)).toEqual([studentId]);
    expect(
      (await list(owner, { p_kind: 'student', p_department: department })).map((row) => row.id),
    ).toEqual([]);
  });

  it('orders by display name and counts the whole filtered set, not the page', async () => {
    const department = `Counselling ${RUN_TAG}`;
    for (const [first, last] of [
      ['Zara', 'Abiodun'],
      ['Amos', 'Winterbourne'],
      ['Nadia', 'Krall'],
    ]) {
      await upsert(owner, {
        kind: 'staff',
        first_name: first,
        last_name: last,
        department,
        staff_id: `EMP-${RUN_TAG}-${first}`,
      });
    }

    const page = await list(owner, { p_department: department, p_limit: 2 });
    expect(page.map((row) => row.display_name)).toEqual(['Amos Winterbourne', 'Nadia Krall']);
    expect(Number(page[0]?.total_count)).toBe(3);

    const nextPage = await list(owner, { p_department: department, p_limit: 2, p_offset: 2 });
    expect(nextPage.map((row) => row.display_name)).toEqual(['Zara Abiodun']);
    expect(Number(nextPage[0]?.total_count)).toBe(3);

    // Asking for no rows gets no rows, rather than being rounded up to one.
    expect(await list(owner, { p_department: department, p_limit: 0 })).toHaveLength(0);
  });
});

describe('facets', () => {
  it('offers the departments and class years that active people actually have', async () => {
    // Everything this test asserts on is seeded by this test, so it does not
    // depend on which describe above it happened to run first.
    const liveDepartment = `Music ${RUN_TAG}`;
    const secondDepartment = `Robotics ${RUN_TAG}`;
    const archivedDepartment = `Archive ${RUN_TAG}`;
    const classOf = `19${RUN_TAG.slice(0, 2)}`;
    const secondClassOf = `17${RUN_TAG.slice(0, 2)}`;

    await upsert(owner, {
      kind: 'staff',
      first_name: 'Cleo',
      last_name: 'Barnaby',
      department: liveDepartment,
      staff_id: `EMP-${RUN_TAG}-D`,
    });
    await upsert(owner, {
      kind: 'staff',
      first_name: 'Ines',
      last_name: 'Fontaine',
      department: secondDepartment,
      staff_id: `EMP-${RUN_TAG}-G`,
    });
    await upsert(owner, student({ class_of: classOf }));
    await upsert(owner, student({ class_of: secondClassOf }));
    const retiredId = await upsert(owner, {
      kind: 'staff',
      first_name: 'Wendell',
      last_name: 'Pike',
      department: archivedDepartment,
      staff_id: `EMP-${RUN_TAG}-E`,
    });
    await rpcOk(admin, 'app_set_person_active', { p_person: retiredId, p_active: false });

    const facets = await rpcOk<Facets>(owner, 'app_people_facets');
    expect(facets.departments).toContain(liveDepartment);
    expect(facets.departments).toContain(secondDepartment);
    expect(facets.class_years).toContain(classOf);
    expect(facets.class_years).toContain(secondClassOf);
    // An archived person no longer offers a filter nobody can use.
    expect(facets.departments).not.toContain(archivedDepartment);
    // Sorted, and with no empty entries.
    expect(facets.departments).toEqual([...facets.departments].sort());
    expect(facets.departments).not.toContain(null);
  });
});

describe('person detail', () => {
  it('returns the person, their history, and the places devices and tickets will go', async () => {
    const personId = await upsert(
      owner,
      student({ first_name: 'Solomon', last_name: 'Adeyemi', department: DEPARTMENT }),
    );
    await upsert(owner, { id: personId, role_title: 'Lab monitor' });

    const detail = await rpcOk<PersonDetail>(owner, 'app_person_detail', { p_person: personId });
    expect(detail.person.id).toBe(personId);
    expect(detail.person.display_name).toBe('Solomon Adeyemi');
    expect(detail.person.department).toBe(DEPARTMENT);
    // Task 9 recreates this function with the device join; Task 10 adds the
    // requester link that fills in tickets. Both are empty, never absent.
    expect(detail.devices).toEqual([]);
    expect(detail.tickets).toEqual([]);
    expect(detail.events.map((event) => event.kind)).toEqual(['created', 'updated']);
  });

  it('returns nothing for a person who is not there', async () => {
    const detail = await rpcOk<PersonDetail | null>(owner, 'app_person_detail', {
      p_person: '00000000-0000-0000-0000-000000000000',
    });
    expect(detail).toBeNull();
  });
});

describe('who may reach the directory', () => {
  let existingId = '';

  beforeAll(async () => {
    existingId = await upsert(owner, student({ first_name: 'Visible', last_name: 'Record' }));
  });

  it('shows an active technician the directory', async () => {
    const { data, error } = await unrelated.from('people').select('id').limit(1);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('shows nothing to an account that is not active', async () => {
    for (const [label, client] of [
      ['awaiting setup', pending],
      ['deactivated', inactive],
      ['awaiting an access decision', pendingApproval],
      ['denied', denied],
    ] as const) {
      const direct = await client.from('people').select('id');
      expect(direct.error, `${label} must not error`).toBeNull();
      expect(direct.data ?? [], `${label} must see no people`).toHaveLength(0);

      expect(await list(client), `${label} must list nothing`).toEqual([]);
      expect(
        await rpcOk<PersonDetail | null>(client, 'app_person_detail', { p_person: existingId }),
        `${label} must see no detail`,
      ).toBeNull();

      const facets = await rpcOk<Facets>(client, 'app_people_facets');
      expect(facets.departments, `${label} must see no facets`).toEqual([]);
      expect(facets.class_years, `${label} must see no facets`).toEqual([]);
    }
  });

  it('refuses every write from an account that is not active', async () => {
    for (const client of [pending, inactive, pendingApproval, denied]) {
      const write = await rpcFails(client, 'app_upsert_person', {
        p_person: { kind: 'student', first_name: 'Forged', last_name: 'Entry' },
      });
      expect(write.code).toBe(REFUSED);

      const archive = await rpcFails(client, 'app_set_person_active', {
        p_person: existingId,
        p_active: false,
      });
      expect(archive.code).toBe(REFUSED);
    }
  });

  it('refuses anonymous callers outright', async () => {
    const anon = anonClient();

    const read = await anon.from('people').select('id');
    expect(read.error?.message).toMatch(/permission denied/i);

    for (const fn of ['app_list_people_m5', 'app_people_facets']) {
      const { error } = await anon.rpc(fn);
      expect(error?.message, fn).toMatch(/permission denied|function|schema cache/i);
    }

    const detail = await anon.rpc('app_person_detail', { p_person: existingId });
    expect(detail.error?.message).toMatch(/permission denied|function|schema cache/i);

    const write = await anon.rpc('app_upsert_person', {
      p_person: { kind: 'student', first_name: 'Forged', last_name: 'Entry' },
    });
    expect(write.error?.message).toMatch(/permission denied|function|schema cache/i);
  });

  it('takes no write from a session, not even an administrator’s', async () => {
    const insert = await admin
      .from('people')
      .insert({ kind: 'student', display_name: 'Forged Entry' });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await admin
      .from('people')
      .update({ display_name: 'Rewritten' })
      .eq('id', existingId);
    expect(update.error?.message).toMatch(/permission denied/i);

    const remove = await admin.from('people').delete().eq('id', existingId);
    expect(remove.error?.message).toMatch(/permission denied/i);

    expect((await rawPerson(existingId)).display_name).toBe('Visible Record');
  });
});
