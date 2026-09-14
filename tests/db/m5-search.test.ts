/**
 * M5 global lookup: one search box over tickets, the directory and the
 * inventory.
 *
 * Two properties matter more than the matching itself.
 *
 * The lookup is SECURITY INVOKER, so it can only ever return what the caller
 * could already read. A technician who types a colleague's ticket number gets
 * nothing back for that ticket and is told nothing about its existence, while
 * the same query still finds the device and the person, because those are shared
 * helpdesk records. An account that is not active gets nothing at all.
 *
 * And what an operator types into a search box is TEXT. A percent sign is a
 * percent sign, not "match everything", and an underscore is an underscore. The
 * lookup escapes both rather than handing the pattern to LIKE unguarded.
 *
 * Everything is arranged through real signed-in sessions, so no test proves
 * something about a privileged path the application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  identity,
  openTicket,
  ownedTicket,
  rawTicket,
  rpcFails,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
} from './support/harness';

interface CandidateRow {
  kind: 'ticket' | 'person' | 'device';
  id: string;
}

interface SearchRow {
  kind: 'ticket' | 'person' | 'device';
  id: string;
  title: string;
  subtitle: string | null;
  meta: string | null;
  rank: number;
}

/**
 * Fresh identifiers per run, so the suite can be re-run against a database that
 * was not reset. Shaped like the school's real asset tags and OSIS numbers
 * without colliding with any of them.
 */
const RUN = String(Math.floor(Math.random() * 9000) + 1000);
const OSIS = `99${RUN}0001`;
const TAG_PREFIX = `DOE-SR${RUN}`;
/** One tag is the whole query; the other merely starts with it. */
const EXACT_TAG = `${TAG_PREFIX}7`;
const LONGER_TAG = `${TAG_PREFIX}77`;
const PERSON_NAME = `Wren Calloway-${RUN}`;
/** A two-character query nobody else in the fixtures answers to. */
const SHORT_TAG_PREFIX = 'ZQ';
const OWNED_TITLE = `Smartboard pen missing ${RUN}`;
/** One owned ticket, distinctive on every arm the lookup searches. */
const SECRET_TITLE = `Confidential swap ${RUN}`;
const SECRET_ISSUE = `Chassis cracked along the hinge, reported quietly ${RUN}.`;
const SECRET_REQUESTER = `Marisol Ferreira-${RUN}`;

let admin: SupabaseClient;
let owner: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;

let personId: string;
let exactDeviceId: string;
let longerDeviceId: string;
let shortQueryDeviceId: string;
let ticketId: string;
let ticketNumber: string;
let queuedTicketId: string;
let queuedTicketNumber: string;
let secretTicketId: string;
let secretTicketNumber: string;

async function search(
  client: SupabaseClient,
  query: string,
  limit?: number,
): Promise<SearchRow[]> {
  const args: Record<string, unknown> = { p_query: query };
  if (limit !== undefined) args.p_limit = limit;
  return rpcOk<SearchRow[]>(client, 'app_search', args);
}

function ofKind(rows: SearchRow[], kind: SearchRow['kind']): SearchRow[] {
  return rows.filter((row) => row.kind === kind);
}

/** The trusted id-only half, called directly rather than through app_search. */
async function candidates(
  client: SupabaseClient,
  query: string,
): Promise<CandidateRow[]> {
  return rpcOk<CandidateRow[]>(client, 'app_search_candidates', { p_query: query });
}

function candidateIds(rows: CandidateRow[], kind: CandidateRow['kind']): string[] {
  return rows.filter((row) => row.kind === kind).map((row) => row.id);
}

beforeAll(async () => {
  admin = await signIn('admin');
  owner = await signIn('owner');
  unrelated = await signIn('unrelated');
  pending = await signIn('pending');

  ({ id: personId } = await seedRequester('student', {
    display_name: PERSON_NAME,
    first_name: 'Wren',
    last_name: `Calloway-${RUN}`,
    external_id: OSIS,
    source_external_id: OSIS,
    official_class: '9R',
  }));

  ({ id: exactDeviceId } = await seedInventoryDevice({
    asset_tag: EXACT_TAG,
    serial_number: `SR${RUN}0001`,
    model: 'ThinkPad E14',
    device_type: 'Laptop',
  }));
  ({ id: longerDeviceId } = await seedInventoryDevice({
    asset_tag: LONGER_TAG,
    serial_number: `SR${RUN}0002`,
    model: 'ThinkPad E14',
    device_type: 'Laptop',
  }));
  await rpcOk(owner, 'app_assign_inventory_device', {
    p_device: exactDeviceId,
    p_requester: personId,
  });

  // Two characters is the shortest query the lookup answers, so one fixture is
  // reachable by exactly two.
  ({ id: shortQueryDeviceId } = await seedInventoryDevice({
    asset_tag: `${SHORT_TAG_PREFIX}${RUN}0003`,
    model: 'Latitude 3120',
    device_type: 'Laptop',
  }));

  // Named explicitly: a ticket with no requester is the harness default, and
  // this ticket's whole job below is to prove that a ticket found by number
  // carries its requester's name as the subtitle.
  const staff = await seedRequester('staff', { display_name: `Ms. Calloway-${RUN}` });
  ({ ticketId } = await ownedTicket({ title: OWNED_TITLE, requesterId: staff.id }));
  ticketNumber = String((await rawTicket(ticketId)).number);

  // Admin-created and unclaimed: the Open Queue, which every active technician
  // may see.
  queuedTicketId = await openTicket({ title: `Queued cable tidy ${RUN}` });
  queuedTicketNumber = String((await rawTicket(queuedTicketId)).number);

  const secretRequester = await seedRequester('staff', { display_name: SECRET_REQUESTER });
  ({ ticketId: secretTicketId } = await ownedTicket({
    title: SECRET_TITLE,
    issue: SECRET_ISSUE,
    requesterId: secretRequester.id,
  }));
  secretTicketNumber = String((await rawTicket(secretTicketId)).number);
});

describe('what the lookup finds', () => {
  it('finds a device from the start of its asset tag', async () => {
    const devices = ofKind(await search(owner, TAG_PREFIX), 'device');

    const found = devices.find((row) => row.id === exactDeviceId);
    expect(found).toBeDefined();
    expect(found?.title).toBe(EXACT_TAG);
    // Model and type, so two identical-looking tags are still distinguishable.
    expect(found?.subtitle).toContain('ThinkPad E14');
    expect(found?.subtitle).toContain('Laptop');
    // Status plus whoever is holding it right now.
    expect(found?.meta).toContain('Assigned');
    expect(found?.meta).toContain(PERSON_NAME);
  });

  it('finds a person from their OSIS', async () => {
    const people = ofKind(await search(owner, OSIS), 'person');

    const found = people.find((row) => row.id === personId);
    expect(found).toBeDefined();
    expect(found?.title).toBe(PERSON_NAME);
    expect(found?.subtitle).toContain('Student');
    expect(found?.subtitle).toContain('9R');
    expect(found?.meta).toBe(OSIS);
  });

  it('finds a person from a misspelling of their name', async () => {
    // Trigram similarity, not a prefix: an operator who types what they heard
    // still gets the record.
    const people = ofKind(await search(owner, `Wren Caloway-${RUN}`), 'person');
    expect(people.map((row) => row.id)).toContain(personId);
  });

  it('finds a ticket from its number, written in full or as bare digits', async () => {
    const full = ofKind(await search(owner, ticketNumber), 'ticket');
    const asWritten = full.find((row) => row.id === ticketId);
    expect(asWritten).toBeDefined();
    expect(asWritten?.title).toContain(ticketNumber);
    expect(asWritten?.title).toContain(`Smartboard pen missing ${RUN}`);
    expect(asWritten?.subtitle).toBe(`Ms. Calloway-${RUN}`);
    // Rendered text, like every other kind's `meta`: not the `assigned` the
    // column stores.
    expect(asWritten?.meta).toBe('Assigned');

    // "1042" is how a technician reads a number off a printout.
    const digits = ticketNumber.replace('EDT-', '');
    const bare = ofKind(await search(owner, digits), 'ticket');
    expect(bare.map((row) => row.id)).toContain(ticketId);
  });

  it('names an unknown requester rather than leaving the line blank', async () => {
    const { ticketId: anonymous } = await ownedTicket({
      title: `Unlabelled cart ${RUN}`,
      requesterUnknown: true,
    });
    const number = String((await rawTicket(anonymous)).number);

    const rows = ofKind(await search(owner, number), 'ticket');
    expect(rows.find((row) => row.id === anonymous)?.subtitle).toBe('Requester unknown');
  });
});

describe('the lookup returns only what the caller could already read', () => {
  it('hides another technician’s ticket while still finding the shared records', async () => {
    const rows = await search(unrelated, ticketNumber);
    // The ticket is owned by `owner`, so RLS removes it. Nothing in the result
    // says it exists.
    expect(ofKind(rows, 'ticket').map((row) => row.id)).not.toContain(ticketId);

    // The inventory and the directory are shared, so the same account still
    // finds them.
    const devices = ofKind(await search(unrelated, TAG_PREFIX), 'device');
    expect(devices.map((row) => row.id)).toContain(exactDeviceId);
    const people = ofKind(await search(unrelated, OSIS), 'person');
    expect(people.map((row) => row.id)).toContain(personId);
  });

  it('hides an owned ticket through the title path as well as the number', async () => {
    // The number arm is a prefix match and the title arm is a trigram match, and
    // they are separate subqueries. RLS has to remove the ticket from both, or a
    // technician could confirm a colleague's work by searching its title.
    const mine = ofKind(await search(owner, OWNED_TITLE), 'ticket');
    expect(mine.map((row) => row.id)).toContain(ticketId);

    const theirs = ofKind(await search(unrelated, OWNED_TITLE), 'ticket');
    expect(theirs.map((row) => row.id)).not.toContain(ticketId);
  });

  it('hides an owned ticket through every arm the lookup searches', async () => {
    // Candidate ids are found without RLS, by design, and the rows are fetched
    // back through the policies. That only holds if EVERY arm is covered, so
    // each one is tried separately: the number, the title, the issue text and
    // the requester's name are four different subqueries.
    const arms: Array<[string, string]> = [
      ['number', secretTicketNumber],
      ['bare digits', secretTicketNumber.replace('EDT-', '')],
      ['title', SECRET_TITLE],
      ['issue', SECRET_ISSUE],
      ['requester name', SECRET_REQUESTER],
    ];

    for (const [arm, query] of arms) {
      // The owner finds their own ticket through this arm, so the arm is known
      // to work before the negative below means anything.
      const mine = ofKind(await search(owner, query), 'ticket');
      expect(mine.map((row) => row.id), `owner via ${arm}`).toContain(secretTicketId);

      const theirs = ofKind(await search(unrelated, query), 'ticket');
      expect(theirs.map((row) => row.id), `unrelated via ${arm}`).not.toContain(secretTicketId);
    }
  });

  it('shows an Open Queue ticket to every active technician', async () => {
    // The Open Queue is shared work: tickets_select_visible lets any active
    // account see an open, unowned ticket, so the lookup must too.
    const rows = ofKind(await search(unrelated, queuedTicketNumber), 'ticket');
    const found = rows.find((row) => row.id === queuedTicketId);
    expect(found).toBeDefined();
    expect(found?.meta).toBe('Open');
  });

  it('returns nothing at all to an account that is not active', async () => {
    for (const query of [TAG_PREFIX, OSIS, ticketNumber]) {
      expect(await search(pending, query)).toHaveLength(0);
    }
  });
});

describe('the query is text, not a pattern', () => {
  it('returns nothing for a query shorter than two characters', async () => {
    expect(await search(owner, 'D')).toHaveLength(0);
    expect(await search(owner, '%')).toHaveLength(0);
    expect(await search(owner, '   ')).toHaveLength(0);
    expect(await search(owner, '')).toHaveLength(0);
  });

  it('answers a two-character query, which is the boundary', async () => {
    // One character short of this returns nothing; this one has to work, or the
    // rule would be "three characters" with a misleading comment beside it.
    expect(SHORT_TAG_PREFIX).toHaveLength(2);
    const devices = ofKind(await search(owner, SHORT_TAG_PREFIX), 'device');
    expect(devices.map((row) => row.id)).toContain(shortQueryDeviceId);

    expect(await search(owner, SHORT_TAG_PREFIX.slice(0, 1))).toHaveLength(0);
  });

  it('treats LIKE metacharacters as literal text instead of failing', async () => {
    // The positive control first, so the assertions below are about the escaping
    // rather than about a query that never matched anything.
    const plain = await search(owner, TAG_PREFIX);
    expect(plain.map((row) => row.id)).toContain(exactDeviceId);

    // As patterns these would match every row of three tables. As text they
    // match nothing, and none of them raises.
    expect(await search(owner, '%%')).toHaveLength(0);
    expect(await search(owner, '%_%')).toHaveLength(0);
    expect(await search(owner, '___')).toHaveLength(0);

    // The discriminating pair. `%DOE-SR1234%` and `DOE_SR1234` are each one
    // metacharacter away from the query that finds DOE-SR12347 above, and
    // neither finds it: `%` does not stand for the rest of the tag and `_` does
    // not stand for the hyphen. No trigram arm covers a device identifier — the
    // only device trigram arm is over `model` — so there is nothing else for
    // these to match on either.
    const wildcards = await search(owner, `%${TAG_PREFIX}%`);
    expect(wildcards.map((row) => row.id)).not.toContain(exactDeviceId);
    expect(wildcards.map((row) => row.id)).not.toContain(shortQueryDeviceId);

    const underscores = await search(owner, TAG_PREFIX.replace(/-/g, '_'));
    expect(underscores.map((row) => row.id)).not.toContain(exactDeviceId);
    expect(underscores.map((row) => row.id)).not.toContain(shortQueryDeviceId);
  });
});

describe('the trusted id-only half, called directly', () => {
  // app_search_candidates has to be granted to `authenticated`, because
  // app_search is SECURITY INVOKER and could not otherwise call it. So it is
  // reachable from a session, and what it hands out is tested here rather than
  // only through the wrapper.

  it('does not hand a hidden ticket\u2019s id to an unrelated technician', async () => {
    // The owner reaches it through the title arm, so the arm works.
    expect(candidateIds(await candidates(owner, SECRET_TITLE), 'ticket')).toContain(
      secretTicketId,
    );
    // The same call by someone with no claim on the ticket returns no id for it:
    // a uuid would already answer "does a ticket matching this exist".
    expect(candidateIds(await candidates(unrelated, SECRET_TITLE), 'ticket')).not.toContain(
      secretTicketId,
    );
  });

  it('returns nothing to an account that is not active', async () => {
    for (const query of [TAG_PREFIX, OSIS, ticketNumber, SECRET_TITLE]) {
      expect(await candidates(pending, query)).toHaveLength(0);
    }
  });

  it('is not callable without a session at all', async () => {
    const failure = await rpcFails(anonClient(), 'app_search_candidates', {
      p_query: TAG_PREFIX,
    });
    expect(failure.message).toMatch(/permission denied/i);
  });

  it('treats the shared ticket-number prefix as no number at all', async () => {
    // Every ticket number starts EDT-, so an ungated `number ilike 'EDT%'` arm
    // matched the whole table and ran the visibility predicate once per row of
    // it. A bare prefix now yields no number candidates.
    const bare = candidateIds(await candidates(owner, 'EDT'), 'ticket');
    for (const id of [ticketId, queuedTicketId, secretTicketId]) {
      expect(bare).not.toContain(id);
    }

    // One digit is enough to make it a number search again, and every seeded
    // ticket number is EDT-1xxx.
    const withDigit = candidateIds(await candidates(owner, 'EDT-1'), 'ticket');
    expect(withDigit).toContain(ticketId);
    expect(withDigit).toContain(queuedTicketId);
  });

  it('caps what one call can enumerate', async () => {
    // The cap is per kind and far above anything a real lookup returns; this
    // asserts the bound exists rather than trying to exceed it.
    const rows = await candidates(owner, 'EDT-1');
    expect(candidateIds(rows, 'ticket').length).toBeLessThanOrEqual(200);
    expect(candidateIds(rows, 'person').length).toBeLessThanOrEqual(200);
    expect(candidateIds(rows, 'device').length).toBeLessThanOrEqual(200);
  });
});

describe('ranking and limits', () => {
  it('puts an exact identifier above one the query merely starts', async () => {
    const devices = ofKind(await search(owner, EXACT_TAG), 'device');

    const exact = devices.find((row) => row.id === exactDeviceId);
    const longer = devices.find((row) => row.id === longerDeviceId);
    expect(exact).toBeDefined();
    expect(longer).toBeDefined();
    expect(exact!.rank).toBeGreaterThan(longer!.rank);
    expect(devices.indexOf(exact!)).toBeLessThan(devices.indexOf(longer!));
  });

  it('caps each kind separately, so one crowded kind cannot crowd out another', async () => {
    const rows = await search(owner, TAG_PREFIX, 1);
    expect(ofKind(rows, 'device')).toHaveLength(1);
  });

  it('clamps p_limit at 25 however many a caller asks for', async () => {
    // Twenty-six machines answering to one prefix, so the ceiling is the thing
    // under test rather than the size of the fixture.
    const crowded = `DOE-CP${RUN}`;
    for (let index = 0; index < 26; index += 1) {
      await seedInventoryDevice({
        asset_tag: `${crowded}${String(index).padStart(3, '0')}`,
        model: 'Chromebook 3110',
        device_type: 'Chromebook',
      });
    }

    expect(ofKind(await search(owner, crowded, 100), 'device')).toHaveLength(25);
    // A caller asking for no rows is asking for no rows.
    expect(await search(owner, crowded, 0)).toHaveLength(0);
  });

  it('is callable by every signed-in account and by nobody else', async () => {
    // The seeded admin is an ordinary caller here: the lookup is not admin-only.
    const rows = await search(admin, OSIS);
    expect(ofKind(rows, 'person').map((row) => row.id)).toContain(personId);
    expect(identity('admin').role).toBe('admin');
  });
});
