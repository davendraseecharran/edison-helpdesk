/**
 * The desk's old spreadsheet, and the batch lookup that goes with it.
 *
 * `20260916100200_m5_import_resolved.sql` adds two functions, and each one
 * exists because an ordinary path cannot do the job:
 *
 * 1. app_import_resolved_ticket writes a FINISHED ticket. No sequence of
 *    ordinary calls can: app_create_ticket opens a ticket today, claim and
 *    resolve stamp now(), and `tickets_guard` freezes created_at the moment the
 *    row exists. So the whole row and its three history events go in at once,
 *    at the times they actually happened — which is exactly the power that has
 *    to be fenced, and the fence is what most of this file is about. Who may
 *    call it, whose name may be put on the work, and which dates are a history
 *    rather than a typo.
 *
 * 2. app_find_people answers up to two hundred keys in one round trip, for the
 *    skills officer holding a class list. It reads the district directory, the
 *    machine each person holds and whether they have anything open, so it is
 *    proven here against a seeded person rather than a real one.
 *
 * Every call goes through a real signed-in session: the actor is derived inside
 * the function from auth.uid(), and a test that arranged it any other way would
 * prove nothing about the application.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  identity,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  seedRequester,
  signIn,
} from './support/harness';

let netrider: SupabaseClient;
let admin: SupabaseClient;
let officer: SupabaseClient;

/** A moment in the recent past, so the three-year rule is never the reason a test fails. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const CALLED = daysAgo(30);
const RESOLVED = daysAgo(28);

interface ImportArgs {
  p_title?: string;
  p_issue?: string | null;
  p_called_at?: string;
  p_resolved_at?: string;
  p_resolved_by?: string | null;
  p_requester_id?: string | null;
  p_location?: string | null;
  p_category?: string | null;
  p_priority?: string | null;
}

function importArgs(overrides: ImportArgs = {}): Record<string, unknown> {
  return {
    p_title: 'Projector in 118 would not wake',
    p_issue: 'Called in during period 3; the podium laptop showed no signal.',
    p_called_at: CALLED,
    p_resolved_at: RESOLVED,
    ...overrides,
  };
}

function at(value: unknown): number {
  return Date.parse(String(value));
}

interface FoundPerson {
  key: string;
  found: string;
  matches: number;
  id: string | null;
  display_name: string | null;
  kind: string | null;
  group_label: string | null;
  device_count: number | null;
  open_ticket_count: number | null;
}

beforeAll(async () => {
  netrider = await signIn('owner');
  admin = await signIn('admin');
  officer = await signIn('skillsOfficer');
});

describe('app_import_resolved_ticket', () => {
  it('writes a finished ticket at the times it actually happened', async () => {
    const ticketId = await rpcOk<string>(netrider, 'app_import_resolved_ticket', importArgs());
    const ticket = await rawTicket(ticketId);

    expect(ticket.status).toBe('resolved');
    expect(at(ticket.created_at)).toBe(at(CALLED));
    expect(at(ticket.assigned_at)).toBe(at(CALLED));
    expect(at(ticket.resolved_at)).toBe(at(RESOLVED));
    // The importer did the work, so the importer owns it and resolved it.
    expect(ticket.owner_id).toBe(identity('owner').id);
    expect(ticket.resolved_by).toBe(identity('owner').id);
    expect(ticket.created_by).toBe(identity('owner').id);
    // The sheet is a record of calls, and nobody was named on this row.
    expect(ticket.channel).toBe('phone_call');
    expect(ticket.requester_unknown).toBe(true);
    expect(ticket.requester_id).toBeNull();
    // Defaults, exactly as app_create_ticket spells them.
    expect(ticket.category).toBe('other');
    expect(ticket.priority).toBe('normal');
    // A resolved ticket needs a solution, and the sheet does not carry one; the
    // row says so rather than leaving something nobody can tell from a real one.
    expect(String(ticket.solution)).toContain('did not record how');
  });

  it('leaves the three events the ordinary path would have left, in historic order', async () => {
    const ticketId = await rpcOk<string>(netrider, 'app_import_resolved_ticket', importArgs());
    const events = await rawEvents(ticketId);

    expect(events).toHaveLength(3);
    const kinds = events.map((event) => String(event.kind)).sort();
    expect(kinds).toEqual(['claimed', 'created', 'resolved']);

    const byKind = new Map(events.map((event) => [String(event.kind), event]));
    // Called in and taken on at the same moment: one line of a spreadsheet.
    expect(at(byKind.get('created')?.at)).toBe(at(CALLED));
    expect(at(byKind.get('claimed')?.at)).toBe(at(CALLED));
    expect(at(byKind.get('resolved')?.at)).toBe(at(RESOLVED));
    // And the resolution is genuinely last, not merely written last.
    expect(at(events[events.length - 1].at)).toBe(at(RESOLVED));

    // Nobody reading this history a year from now should mistake a spreadsheet
    // row for a ticket somebody worked here.
    for (const event of events) {
      expect(String(event.summary)).toContain("Imported from the desk's sheet");
    }
    expect(String(byKind.get('created')?.summary)).toContain(identity('owner').displayName);
  });

  it('records the requester, the room and the filing when the sheet has them', async () => {
    const person = await seedRequester('student');
    const ticketId = await rpcOk<string>(
      netrider,
      'app_import_resolved_ticket',
      importArgs({
        p_requester_id: person.id,
        p_location: 'Room 118',
        p_category: 'projector_display',
        p_priority: 'high',
      }),
    );
    const ticket = await rawTicket(ticketId);

    expect(ticket.requester_id).toBe(person.id);
    expect(ticket.requester_unknown).toBe(false);
    expect(ticket.location).toBe('Room 118');
    expect(ticket.category).toBe('projector_display');
    expect(ticket.priority).toBe('high');
  });

  it('takes the title as the issue when the sheet held only one sentence', async () => {
    const ticketId = await rpcOk<string>(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_title: 'Smartboard pen stopped writing', p_issue: '   ' }),
    );
    const ticket = await rawTicket(ticketId);
    expect(ticket.issue).toBe('Smartboard pen stopped writing');
  });

  it('refuses a NetRider who puts a colleague’s name on the work', async () => {
    const refused = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_resolved_by: identity('collaborator').id }),
    );
    expect(refused.message).toContain('Only an administrator');
  });

  it('lets an administrator import what somebody else resolved, and says whose it is', async () => {
    const ticketId = await rpcOk<string>(
      admin,
      'app_import_resolved_ticket',
      importArgs({ p_resolved_by: identity('collaborator').id }),
    );
    const ticket = await rawTicket(ticketId);

    expect(ticket.owner_id).toBe(identity('collaborator').id);
    expect(ticket.resolved_by).toBe(identity('collaborator').id);
    // The administrator did the importing, and the history says so.
    expect(ticket.created_by).toBe(identity('admin').id);

    const events = await rawEvents(ticketId);
    const kinds = events.map((event) => String(event.kind)).sort();
    // Somebody else's work is ASSIGNED, never "claimed": a claim is a thing a
    // person does for themselves.
    expect(kinds).toEqual(['assigned', 'created', 'resolved']);
    const assigned = events.find((event) => event.kind === 'assigned');
    expect(String(assigned?.summary)).toContain(identity('collaborator').displayName);
  });

  it('refuses a resolver who is not an active account that works tickets', async () => {
    const officerNamed = await rpcFails(
      admin,
      'app_import_resolved_ticket',
      importArgs({ p_resolved_by: identity('skillsOfficer').id }),
    );
    expect(officerNamed.message).toContain('active NetRider or administrator');

    const goneNamed = await rpcFails(
      admin,
      'app_import_resolved_ticket',
      importArgs({ p_resolved_by: identity('inactive').id }),
    );
    expect(goneNamed.message).toContain('active NetRider or administrator');
  });

  it('refuses dates that are not a history', async () => {
    const backwards = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_called_at: daysAgo(10), p_resolved_at: daysAgo(12) }),
    );
    expect(backwards.message).toContain('cannot be resolved before it was called in');

    const ahead = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_called_at: daysAgo(-1), p_resolved_at: daysAgo(-1) }),
    );
    expect(ahead.message).toContain('cannot be in the future');

    const ancient = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_called_at: daysAgo(1200), p_resolved_at: daysAgo(1199) }),
    );
    expect(ancient.message).toContain('three years');
  });

  it('refuses a category the queue does not know, rather than filing it under other', async () => {
    const refused = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_category: 'wifi' }),
    );
    expect(refused.message).toContain('Choose a category');
  });

  it('refuses a title that is not one', async () => {
    const tooShort = await rpcFails(netrider, 'app_import_resolved_ticket', importArgs({ p_title: 'AV' }));
    expect(tooShort.message).toContain('three characters');

    const tooLong = await rpcFails(
      netrider,
      'app_import_resolved_ticket',
      importArgs({ p_title: 'A'.repeat(121) }),
    );
    expect(tooLong.message).toContain('under 120 characters');
  });

  it('refuses a skills officer, who works the directory and not tickets', async () => {
    const refused = await rpcFails(officer, 'app_import_resolved_ticket', importArgs());
    expect(refused.message).toContain('Only a NetRider or an administrator');
  });

  it('returns the ticket already imported when the same row is sent again', async () => {
    const title = `Cart 3 charger missing ${Date.now()}`;
    const first = await rpcOk<string>(netrider, 'app_import_resolved_ticket', importArgs({ p_title: title }));
    const second = await rpcOk<string>(netrider, 'app_import_resolved_ticket', importArgs({ p_title: title }));
    expect(second).toBe(first);
    // Still one history, not two.
    expect((await rawEvents(first)).filter((event) => event.kind === 'created')).toHaveLength(1);
  });
});

describe('app_find_people', () => {
  it('finds a seeded person by their OSIS, with their class and what they hold', async () => {
    const person = await seedRequester('student', { official_class: '9A' });
    const found = await rpcOk<FoundPerson[]>(officer, 'app_find_people', {
      p_keys: [person.externalId],
    });

    expect(found).toHaveLength(1);
    expect(found[0].key).toBe(person.externalId);
    expect(found[0].found).toBe('match');
    expect(found[0].matches).toBe(1);
    expect(found[0].id).toBe(person.id);
    expect(found[0].display_name).toBe(person.displayName);
    expect(found[0].kind).toBe('student');
    expect(found[0].group_label).toBe('9A');
    expect(found[0].device_count).toBe(0);
    expect(found[0].open_ticket_count).toBe(0);
  });

  it('answers an unknown key with no match rather than with nothing', async () => {
    const found = await rpcOk<FoundPerson[]>(officer, 'app_find_people', {
      p_keys: ['nobody-in-this-directory'],
    });

    expect(found).toHaveLength(1);
    expect(found[0].found).toBe('none');
    expect(found[0].matches).toBe(0);
    expect(found[0].id).toBeNull();
  });

  it('answers every key, in the order it was given', async () => {
    const person = await seedRequester('staff');
    const found = await rpcOk<FoundPerson[]>(officer, 'app_find_people', {
      p_keys: ['nobody-in-this-directory', person.externalId, person.displayName],
    });

    expect(found.map((row) => row.found)).toEqual(['none', 'match', 'match']);
    expect(found[1].id).toBe(person.id);
    // A staff id is the local part of a school address, and a full name is a
    // whole name: both find the same person.
    expect(found[2].id).toBe(person.id);
  });

  it('says ambiguous, with the count, rather than picking one of two people', async () => {
    const shared = `Synthetic Twin ${crypto.randomUUID().slice(0, 8)}`;
    await seedRequester('student', { display_name: shared });
    await seedRequester('student', { display_name: shared });

    const found = await rpcOk<FoundPerson[]>(officer, 'app_find_people', { p_keys: [shared] });
    expect(found[0].found).toBe('ambiguous');
    expect(found[0].matches).toBe(2);
    expect(found[0].id).toBeNull();
  });

  it('refuses a list longer than it will answer', async () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => `key-${index}`);
    const refused = await rpcFails(officer, 'app_find_people', { p_keys: tooMany });
    expect(refused.message).toContain('at most 200');

    const none = await rpcFails(officer, 'app_find_people', { p_keys: [] });
    expect(none.message).toContain('at least one');
  });

  it('counts open tickets for a ticket worker only; a skills officer gets no number', async () => {
    const person = await seedRequester('student');
    const asOfficer = await rpcOk<FoundPerson[]>(officer, 'app_find_people', {
      p_keys: [person.externalId],
    });
    expect(asOfficer[0].found).toBe('match');
    expect(asOfficer[0].open_ticket_count).toBeNull();

    const asWorker = await rpcOk<FoundPerson[]>(netrider, 'app_find_people', {
      p_keys: [person.externalId],
    });
    expect(asWorker[0].open_ticket_count).toBe(0);
  });
});
