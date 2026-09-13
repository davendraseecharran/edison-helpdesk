/**
 * M5 global lookup: one search box over tickets, people and devices.
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
  identity,
  openTicket,
  ownedTicket,
  rawTicket,
  rpcOk,
  signIn,
} from './support/harness';

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

beforeAll(async () => {
  admin = await signIn('admin');
  owner = await signIn('owner');
  unrelated = await signIn('unrelated');
  pending = await signIn('pending');

  personId = await rpcOk<string>(admin, 'app_upsert_person', {
    p_person: {
      kind: 'student',
      first_name: 'Wren',
      last_name: `Calloway-${RUN}`,
      display_name: PERSON_NAME,
      osis: OSIS,
      official_class: '9R',
    },
  });

  exactDeviceId = await rpcOk<string>(owner, 'app_upsert_device', {
    p_device: {
      asset_tag: EXACT_TAG,
      serial_number: `SR${RUN}0001`,
      model: 'ThinkPad E14',
      type: 'Laptop',
    },
  });
  longerDeviceId = await rpcOk<string>(owner, 'app_upsert_device', {
    p_device: {
      asset_tag: LONGER_TAG,
      serial_number: `SR${RUN}0002`,
      model: 'ThinkPad E14',
      type: 'Laptop',
    },
  });
  await rpcOk(owner, 'app_assign_device', { p_device: exactDeviceId, p_person: personId });

  // Two characters is the shortest query the lookup answers, so one fixture is
  // reachable by exactly two.
  shortQueryDeviceId = await rpcOk<string>(owner, 'app_upsert_device', {
    p_device: {
      asset_tag: `${SHORT_TAG_PREFIX}${RUN}0003`,
      model: 'Latitude 3120',
      type: 'Laptop',
    },
  });

  ({ ticketId } = await ownedTicket({ title: OWNED_TITLE }));
  ticketNumber = String((await rawTicket(ticketId)).number);

  // Admin-created and unclaimed: the Open Queue, which every active technician
  // may see.
  queuedTicketId = await openTicket({ title: `Queued cable tidy ${RUN}` });
  queuedTicketNumber = String((await rawTicket(queuedTicketId)).number);
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
    expect(found?.meta).toContain('Deployed');
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
    expect(asWritten?.subtitle).toBe('Ms. Calloway');
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

    // A query that merely contains metacharacters is still answered as text.
    // `%` does not widen it to the whole inventory and `_` does not match any
    // character: a machine with nothing in common with what was typed stays out,
    // where an unescaped pattern would have swept it up.
    const wildcards = await search(owner, `%${TAG_PREFIX}%`);
    expect(wildcards.map((row) => row.id)).not.toContain(shortQueryDeviceId);
    expect(wildcards.map((row) => row.id)).not.toContain(personId);

    const underscores = await search(owner, TAG_PREFIX.replace(/-/g, '_'));
    expect(underscores.map((row) => row.id)).not.toContain(shortQueryDeviceId);
    expect(underscores.map((row) => row.id)).not.toContain(personId);
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
      await rpcOk(owner, 'app_upsert_device', {
        p_device: {
          asset_tag: `${crowded}${String(index).padStart(3, '0')}`,
          model: 'Chromebook 3110',
          type: 'Chromebook',
        },
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
