/**
 * M5 row attribution: the rows the timeline does not cover.
 *
 * `activity_events` and `record_events` have said since the M5 foundation
 * whether a change was made by a person or by that person's AI assistant, so
 * the ticket timeline and the record histories already read "Priya Raman's AI
 * started work". The rows those events describe did not carry the same fact, so
 * the note card, the work-log line, the device observation, the attachment tile,
 * the import-run row and the "Resolved by" line all named the person even when
 * their assistant did the work.
 *
 * Three things are proven here, all through the surface the application uses:
 *
 *   1. Every one of those rows now carries `performed_via` and `ai_model` (the
 *      ticket carries `resolved_via` and `resolved_ai_model` for its
 *      resolution), stamped from the REQUEST headers rather than from any
 *      argument. A request that declares `x-edison-via: ai` is recorded as the
 *      account's assistant; anything else is recorded as the person.
 *   2. The read RPCs hand those columns to the screens that render them —
 *      `app_ticket_detail` and `app_list_attachments` — without losing a key
 *      any existing caller reads.
 *   3. Attribution never widens or narrows access. A forged header cannot make
 *      an AI action look like a person's, a forged value cannot be stored at
 *      all, and none of these rows became readable to anyone who could not
 *      already see them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  openTicket,
  ownedTicket,
  rpcOk,
  signIn,
  signInWithHeaders,
  stack,
  seedRequester,
} from './support/harness';

/** The model an assistant declares, and the two headers it sends with it. */
const MODEL = 'gpt-6-luna';
const AI_HEADERS = { 'x-edison-via': 'ai', 'x-edison-ai-model': MODEL };

/** check_violation, as PostgREST reports it. */
const REJECTED = '23514';

const NOTE = 'Swapped the podium HDMI cable and confirmed the projector syncs.';
const SOLUTION = 'Replaced the cable and confirmed the projector syncs.';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let unrelated: SupabaseClient;

/** The same account, signed in through a client that declares an assistant. */
let aiOwner: SupabaseClient;
let aiAdmin: SupabaseClient;

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, unrelated, aiOwner, aiAdmin] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('unrelated'),
    signInWithHeaders('owner', AI_HEADERS),
    signInWithHeaders('admin', AI_HEADERS),
  ]);
});

/**
 * The upload endpoint's client.
 *
 * Registration is service-role only, and the endpoint forwards the assistant
 * headers on the client it builds for that call, which is how the request-header
 * mechanism reaches a trusted function. Built per test, never cached, so one
 * test's headers cannot leak into another's.
 */
function serviceWithHeaders(headers: Record<string, string>): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

/** Ground truth straight from the table, bypassing every read path under test. */
async function rawRow(table: string, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from(table).select('*').eq('id', id).single();
  if (error) throw new Error(`Could not read ${table} ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

interface TicketDetail {
  ticket: Record<string, unknown>;
  notes: Array<Record<string, unknown>>;
  work_logs: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
}

async function detail(client: SupabaseClient, ticketId: string): Promise<TicketDetail> {
  return rpcOk<TicketDetail>(client, 'app_ticket_detail', { p_ticket: ticketId });
}

async function registerAttachment(
  client: SupabaseClient,
  ticketId: string,
  filename: string,
): Promise<string> {
  return rpcOk<string>(client, 'app_trusted_register_attachment', {
    p_actor: identity('owner').id,
    p_ticket: ticketId,
    p_device: null,
    p_path: `ticket/${ticketId}/${filename}`,
    p_filename: filename,
    p_mime: 'image/png',
    p_bytes: 24_576,
  });
}

describe('work notes', () => {
  it('records an ordinary session as the person, with no model', async () => {
    const { ticketId } = await ownedTicket();
    const noteId = await rpcOk<string>(owner, 'app_add_note', {
      p_ticket: ticketId,
      p_body: NOTE,
    });

    const note = await rawRow('notes', noteId);
    expect(note.performed_via).toBe('user');
    expect(note.ai_model).toBeNull();
    expect(note.author_id).toBe(identity('owner').id);
  });

  it('records the assistant and its model when the request declares one', async () => {
    const { ticketId } = await ownedTicket();
    const noteId = await rpcOk<string>(aiOwner, 'app_add_note', {
      p_ticket: ticketId,
      p_body: NOTE,
    });

    const note = await rawRow('notes', noteId);
    expect(note.performed_via).toBe('ai');
    expect(note.ai_model).toBe(MODEL);
    // Attribution never replaces identity: the person is still responsible.
    expect(note.author_id).toBe(identity('owner').id);
  });

  it('hands the note card both facts, and everything it already read', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });

    const [note] = (await detail(owner, ticketId)).notes;
    expect(note.performed_via).toBe('ai');
    expect(note.ai_model).toBe(MODEL);
    expect(note.body).toBe(NOTE);
    expect(note.author_id).toBe(identity('owner').id);
    expect(note.created_at).toBeTruthy();
  });
});

describe('work logs', () => {
  it('records an ordinary session as the person, with no model', async () => {
    const { ticketId } = await ownedTicket();
    const logId = await rpcOk<string>(owner, 'app_log_work', {
      p_ticket: ticketId,
      p_minutes: 25,
    });

    const log = await rawRow('work_logs', logId);
    expect(log.performed_via).toBe('user');
    expect(log.ai_model).toBeNull();
  });

  it('records the assistant and its model when the request declares one', async () => {
    const { ticketId } = await ownedTicket();
    const logId = await rpcOk<string>(aiOwner, 'app_log_work', {
      p_ticket: ticketId,
      p_minutes: 25,
      p_description: 'Cable swap and projector test.',
    });

    const log = await rawRow('work_logs', logId);
    expect(log.performed_via).toBe('ai');
    expect(log.ai_model).toBe(MODEL);
    expect(log.contributor_id).toBe(identity('owner').id);
  });

  it('hands the work-log line both facts, and everything it already read', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_log_work', { p_ticket: ticketId, p_minutes: 25 });

    const [log] = (await detail(owner, ticketId)).work_logs;
    expect(log.performed_via).toBe('ai');
    expect(log.ai_model).toBe(MODEL);
    expect(log.minutes).toBe(25);
    expect(log.contributor_id).toBe(identity('owner').id);
    expect(log.work_date).toBeTruthy();
  });
});

describe('device observations', () => {
  it('records an ordinary session as the person, with no model', async () => {
    const { ticketId } = await ownedTicket();
    const deviceId = await rpcOk<string>(owner, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Projector',
    });

    const observation = await rawRow('device_observations', deviceId);
    expect(observation.performed_via).toBe('user');
    expect(observation.ai_model).toBeNull();
  });

  it('records the assistant and its model when the request declares one', async () => {
    const { ticketId } = await ownedTicket();
    const deviceId = await rpcOk<string>(aiOwner, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Projector',
      p_model: 'Epson EB-2250U',
    });

    const observation = await rawRow('device_observations', deviceId);
    expect(observation.performed_via).toBe('ai');
    expect(observation.ai_model).toBe(MODEL);
    expect(observation.recorded_by).toBe(identity('owner').id);
  });

  /**
   * Intake writes observations too. A ticket raised through somebody's
   * assistant carries the machines it described, so those rows have to say so
   * for the same reason the ones added later do.
   */
  it('marks the machines an assistant described at intake', async () => {
    const requester = await seedRequester('staff', { display_name: 'Ms. Calloway' });
    const ticketId = await rpcOk<string>(aiAdmin, 'app_create_ticket', {
      p_title: 'Projector will not display',
      p_issue: 'Reported during first period; podium laptop shows no signal.',
      p_channel: 'walk_in',
      p_priority: 'normal',
      p_requester_id: requester.id,
      p_location: 'Room 212',
      // No manufacturer, so this is a free-text observation of something the
      // inventory does not hold rather than a claim about a catalogued machine.
      p_devices: [{ deviceType: 'Projector', model: 'Epson EB-2250U' }],
    });

    const [observation] = (await detail(admin, ticketId)).devices;
    expect(observation.performed_via).toBe('ai');
    expect(observation.ai_model).toBe(MODEL);
    expect(observation.device_type).toBe('Projector');
  });
});

describe('attachments', () => {
  it('records an ordinary upload as the person, with no model', async () => {
    const { ticketId } = await ownedTicket();
    const id = await registerAttachment(service, ticketId, 'podium.png');

    const attachment = await rawRow('attachments', id);
    expect(attachment.performed_via).toBe('user');
    expect(attachment.ai_model).toBeNull();
  });

  /**
   * The trusted function takes the actor as an argument because the endpoint
   * has already verified the session; attribution is deliberately NOT an
   * argument, so it has to arrive the same way it does everywhere else — in the
   * request headers the endpoint forwards on its service-role client.
   */
  it('records the assistant and its model when the endpoint forwards the headers', async () => {
    const { ticketId } = await ownedTicket();
    const assisted = serviceWithHeaders(AI_HEADERS);
    const id = await registerAttachment(assisted, ticketId, 'podium.png');

    const attachment = await rawRow('attachments', id);
    expect(attachment.performed_via).toBe('ai');
    expect(attachment.ai_model).toBe(MODEL);
    expect(attachment.uploaded_by).toBe(identity('owner').id);
  });

  it('hands the attachment tile both facts, and everything it already read', async () => {
    const { ticketId } = await ownedTicket();
    const assisted = serviceWithHeaders(AI_HEADERS);
    await registerAttachment(assisted, ticketId, 'podium.png');

    const rows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_list_attachments', {
      p_ticket: ticketId,
      p_device: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].performed_via).toBe('ai');
    expect(rows[0].ai_model).toBe(MODEL);
    expect(rows[0].filename).toBe('podium.png');
    expect(rows[0].uploaded_by).toBe(identity('owner').id);
  });
});

describe('resolutions', () => {
  it('records an ordinary resolution as the person, with no model', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: SOLUTION });

    const ticket = await rawRow('tickets', ticketId);
    expect(ticket.resolved_via).toBe('user');
    expect(ticket.resolved_ai_model).toBeNull();
    expect(ticket.resolved_by).toBe(identity('owner').id);
  });

  it('records the assistant and its model when the request declares one', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: SOLUTION });

    const ticket = await rawRow('tickets', ticketId);
    expect(ticket.resolved_via).toBe('ai');
    expect(ticket.resolved_ai_model).toBe(MODEL);
    // The resolver is the account, exactly as before.
    expect(ticket.resolved_by).toBe(identity('owner').id);
  });

  it('hands the "Resolved by" line both facts at the top level', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: SOLUTION });

    const { ticket } = await detail(owner, ticketId);
    expect(ticket.resolved_via).toBe('ai');
    expect(ticket.resolved_ai_model).toBe(MODEL);
    expect(ticket.resolver_name).toBe(identity('owner').displayName);
    expect(ticket.solution).toBe(SOLUTION);
  });

  it('clears the resolution attribution when the ticket is reopened', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: SOLUTION });
    await rpcOk(admin, 'app_reopen_ticket', {
      p_ticket: ticketId,
      p_reason: 'The projector failed again the next morning.',
    });

    const ticket = await rawRow('tickets', ticketId);
    // A reopened ticket has no resolver, so it cannot have a resolver's assistant.
    expect(ticket.resolved_by).toBeNull();
    expect(ticket.resolved_via).toBe('user');
    expect(ticket.resolved_ai_model).toBeNull();
    // The previous solution is still there, as it always was.
    expect(ticket.solution).toBe(SOLUTION);
  });
});

describe('claims', () => {
  /**
   * `ticket_claimed` is the one notification title in this schema that names the
   * actor, and it now writes "<name>'s AI" when the request declares one. The
   * notice itself is unreachable today — `app_claim_ticket` accepts an OPEN,
   * UNOWNED ticket and the schema keeps no previous-owner column, so there is
   * never anybody to tell — so what a claim can be held to here is the
   * attribution the timeline reads, which is written on the same request.
   */
  it('marks a claim made through an assistant', async () => {
    const ticketId = await openTicket();
    await rpcOk(aiOwner, 'app_claim_ticket', { p_ticket: ticketId });

    const claimed = (await detail(owner, ticketId)).activity.filter(
      (event) => event.kind === 'claimed',
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0].performed_via).toBe('ai');
    expect(claimed[0].ai_model).toBe(MODEL);
    expect(claimed[0].actor_id).toBe(identity('owner').id);
  });

  it('leaves an ordinary claim attributed to the person', async () => {
    const ticketId = await openTicket();
    await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticketId });

    const claimed = (await detail(owner, ticketId)).activity.filter(
      (event) => event.kind === 'claimed',
    );
    expect(claimed[0].performed_via).toBe('user');
    expect(claimed[0].ai_model).toBeNull();
  });
});

// Import runs used to be attributed here too. The in-app CSV importer is gone
// with the tables it wrote: the district's directory arrives through the
// owner's one-time preparation scripts, and every later change to it goes
// through app_save_person or app_save_inventory_device, which write their own
// audit rows into public.inventory_events.

describe('what attribution cannot do', () => {
  it('treats any header other than "ai" as the person acting', async () => {
    const { ticketId } = await ownedTicket();
    const forged = await signInWithHeaders('owner', {
      'x-edison-via': 'assistant',
      'x-edison-ai-model': MODEL,
    });
    const noteId = await rpcOk<string>(forged, 'app_add_note', {
      p_ticket: ticketId,
      p_body: NOTE,
    });

    // Fails closed: attribution can only ever be ADDED by the exact declared
    // value, never removed or invented by a header nobody recognises.
    const note = await rawRow('notes', noteId);
    expect(note.performed_via).toBe('user');
    expect(note.ai_model).toBeNull();
  });

  it('ignores a declared model when the request did not declare an assistant', async () => {
    const { ticketId } = await ownedTicket();
    const modelOnly = await signInWithHeaders('owner', { 'x-edison-ai-model': MODEL });
    const logId = await rpcOk<string>(modelOnly, 'app_log_work', {
      p_ticket: ticketId,
      p_minutes: 10,
    });

    const log = await rawRow('work_logs', logId);
    expect(log.performed_via).toBe('user');
    expect(log.ai_model).toBeNull();
  });

  it('refuses a value that is neither a person nor an assistant', async () => {
    const { ticketId } = await ownedTicket();
    const { error } = await service.from('notes').insert({
      ticket_id: ticketId,
      author_id: identity('owner').id,
      body: NOTE,
      performed_via: 'robot',
    });

    expect(error?.code).toBe(REJECTED);
  });

  it('keeps the rows readable exactly where they were readable before', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(aiOwner, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });
    await rpcOk(aiOwner, 'app_log_work', { p_ticket: ticketId, p_minutes: 25 });
    await rpcOk(aiOwner, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Projector',
    });
    await registerAttachment(serviceWithHeaders(AI_HEADERS), ticketId, 'podium.png');

    for (const table of ['notes', 'work_logs', 'device_observations', 'attachments']) {
      const { data, error } = await unrelated.from(table).select('*').eq('ticket_id', ticketId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }

    // And the whole detail view is still nothing at all to them.
    expect(await detail(unrelated, ticketId)).toBeNull();

    const anon = anonClient();
    const { data } = await anon.from('notes').select('*').eq('ticket_id', ticketId);
    expect(data ?? []).toEqual([]);
  });
});
