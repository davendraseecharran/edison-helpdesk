/**
 * M5 foundation: notifications, record events, and AI attribution.
 *
 * Three things are proven here, all through the same surface a browser reaches:
 *
 *   1. Attribution is taken from the REQUEST, not from the caller's arguments.
 *      A client that declares `x-edison-via: ai` has every activity event it
 *      causes stamped `performed_via = 'ai'` together with the declared model,
 *      and any other header value falls back to `user` — so attribution can
 *      never be *removed* by a forged header, only added.
 *   2. Notifications are private to their account and reach it only through the
 *      read RPCs; writing one is a trusted, server-side operation.
 *   3. Record events are readable by active accounts, with account-scoped
 *      history reserved for admins, and are never writable from a session.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  ownedTicket,
  rawEvents,
  rpcFails,
  rpcOk,
  signIn,
  signInWithHeaders,
  type IdentityKey,
} from './support/harness';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;

const NOTE = 'Swapped the podium HDMI cable and confirmed the projector syncs.';

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, unrelated, pending] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('unrelated'),
    signIn('pending'),
  ]);
});

/** The activity event written by the most recent `app_add_note` on a ticket. */
async function lastNoteEvent(ticketId: string): Promise<Record<string, unknown>> {
  const events = (await rawEvents(ticketId)).filter((event) => event.kind === 'note_added');
  const last = events.at(-1);
  if (!last) throw new Error(`No note_added event on ticket ${ticketId}`);
  return last;
}

describe('AI attribution on activity events', () => {
  it('records an ordinary session as performed by a user, with no model', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });

    const event = await lastNoteEvent(ticketId);
    expect(event.performed_via).toBe('user');
    expect(event.ai_model).toBeNull();
  });

  it('stamps the declared assistant and model when the request says so', async () => {
    const { ticketId } = await ownedTicket();
    const assisted = await signInWithHeaders('owner', {
      'x-edison-via': 'ai',
      'x-edison-ai-model': 'gpt-5.6-luna',
    });
    await rpcOk(assisted, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });

    const event = await lastNoteEvent(ticketId);
    expect(event.performed_via).toBe('ai');
    expect(event.ai_model).toBe('gpt-5.6-luna');
    // Attribution never replaces identity: the human account is still the actor.
    expect(event.actor_id).toBe(identity('owner').id);
  });

  it('treats any other header value as an ordinary user action', async () => {
    const { ticketId } = await ownedTicket();
    const spoofed = await signInWithHeaders('owner', {
      'x-edison-via': 'AI',
      'x-edison-ai-model': 'must-not-be-recorded',
    });
    await rpcOk(spoofed, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });

    const event = await lastNoteEvent(ticketId);
    expect(event.performed_via).toBe('user');
    // The model is dropped with the claim that produced it.
    expect(event.ai_model).toBeNull();
  });

  it('truncates an over-long model name rather than storing it whole', async () => {
    const { ticketId } = await ownedTicket();
    const assisted = await signInWithHeaders('owner', {
      'x-edison-via': 'ai',
      'x-edison-ai-model': 'm'.repeat(400),
    });
    await rpcOk(assisted, 'app_add_note', { p_ticket: ticketId, p_body: NOTE });

    const event = await lastNoteEvent(ticketId);
    expect(String(event.ai_model)).toHaveLength(80);
  });

  it('keeps performed_via out of reach of a forged column write', async () => {
    const { ticketId } = await ownedTicket();
    const { error } = await owner
      .from('activity_events')
      .update({ performed_via: 'ai', ai_model: 'forged' })
      .eq('ticket_id', ticketId);
    expect(error?.message).toMatch(/permission denied/i);
  });
});

describe('trusted writers are unreachable from a session', () => {
  const unreachable: Array<[string, Record<string, unknown>]> = [
    ['app_notify', { p_account: null, p_kind: 'test', p_title: 'Forged' }],
    ['app_notify_admins', { p_kind: 'test', p_title: 'Forged' }],
    [
      'app_log_record_event',
      {
        p_entity_type: 'requester',
        p_entity_id: '00000000-0000-0000-0000-000000000000',
        p_kind: 'forged',
        p_actor: null,
        p_summary: 'Forged',
      },
    ],
  ];

  it('refuses every notification and record writer for an admin session', async () => {
    for (const [fn, args] of unreachable) {
      const failure = await rpcFails(admin, fn, args);
      expect(failure.message, `${fn} must not be callable`).toMatch(/permission denied/i);
    }
  });

  it('refuses them for an ordinary technician too', async () => {
    for (const [fn, args] of unreachable) {
      const failure = await rpcFails(owner, fn, args);
      expect(failure.message, `${fn} must not be callable`).toMatch(/permission denied/i);
    }
  });

  it('refuses them for the service role as well', async () => {
    for (const [fn, args] of unreachable) {
      const { error } = await service.rpc(fn, args);
      expect(error?.message, `${fn} must not be callable`).toMatch(/permission denied/i);
    }
  });
});

describe('notifications', () => {
  async function clearNotifications(): Promise<void> {
    const { error } = await service
      .from('notifications')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw new Error(`Could not clear notifications: ${error.message}`);
  }

  /** Trusted insert: notifications are written by the server, never by a session. */
  async function notify(key: IdentityKey, title: string, readAt: string | null = null) {
    const { error } = await service.from('notifications').insert({
      account_id: identity(key).id,
      kind: 'ticket_assigned',
      title,
      body: 'Room 212 projector will not display.',
      href: '/tickets',
      read_at: readAt,
    });
    if (error) throw new Error(`Could not seed notification: ${error.message}`);
  }

  beforeEach(async () => {
    await clearNotifications();
  });

  it('shows an account only its own notifications, newest first', async () => {
    await notify('owner', 'Older notice');
    await notify('owner', 'Newer notice');
    await notify('unrelated', 'Someone else');

    const mine = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_notifications');
    expect(mine.map((row) => row.title)).toEqual(['Newer notice', 'Older notice']);
    expect(await rpcOk<number>(owner, 'app_unread_notification_count')).toBe(2);

    const theirs = await rpcOk<Array<Record<string, unknown>>>(unrelated, 'app_notifications');
    expect(theirs.map((row) => row.title)).toEqual(['Someone else']);

    // The table itself is just as private as the RPC.
    const direct = await unrelated.from('notifications').select('id, title');
    expect(direct.error).toBeNull();
    expect(direct.data ?? []).toHaveLength(1);
  });

  it('marks everything read, then reports nothing outstanding', async () => {
    await notify('owner', 'First notice');
    await notify('owner', 'Second notice');
    await notify('unrelated', 'Not yours');

    expect(await rpcOk<number>(owner, 'app_mark_notifications_read', { p_ids: null })).toBe(2);
    expect(await rpcOk<number>(owner, 'app_unread_notification_count')).toBe(0);
    // Marking again changes nothing, and never reaches another account's rows.
    expect(await rpcOk<number>(owner, 'app_mark_notifications_read', { p_ids: null })).toBe(0);
    expect(await rpcOk<number>(unrelated, 'app_unread_notification_count')).toBe(1);
  });

  it('marks only the named notifications, and never someone else’s', async () => {
    await notify('owner', 'Keep unread');
    await notify('owner', 'Mark this one');
    await notify('unrelated', 'Not yours');

    const rows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_notifications');
    const target = rows.find((row) => row.title === 'Mark this one');
    const foreign = (await rpcOk<Array<Record<string, unknown>>>(unrelated, 'app_notifications'))[0];

    const marked = await rpcOk<number>(owner, 'app_mark_notifications_read', {
      p_ids: [target?.id, foreign?.id],
    });
    expect(marked).toBe(1);
    expect(await rpcOk<number>(owner, 'app_unread_notification_count')).toBe(1);
    expect(await rpcOk<number>(unrelated, 'app_unread_notification_count')).toBe(1);
  });

  it('filters to unread and honours the limit', async () => {
    await notify('owner', 'Already read', new Date().toISOString());
    await notify('owner', 'Still unread');

    const unread = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_notifications', {
      p_unread_only: true,
    });
    expect(unread.map((row) => row.title)).toEqual(['Still unread']);

    const limited = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_notifications', {
      p_limit: 1,
    });
    expect(limited).toHaveLength(1);
  });

  it('gives an account awaiting setup nothing at all', async () => {
    await notify('pending', 'Should stay invisible');

    expect(await rpcOk<Array<Record<string, unknown>>>(pending, 'app_notifications')).toEqual([]);
    expect(await rpcOk<number>(pending, 'app_unread_notification_count')).toBe(0);

    const failure = await rpcFails(pending, 'app_mark_notifications_read', { p_ids: null });
    expect(failure.code).toBe('42501');
  });

  it('refuses anonymous reads and every session-side write', async () => {
    await notify('owner', 'Private notice');

    const anon = anonClient();
    const anonRead = await anon.from('notifications').select('id');
    expect(anonRead.error?.message).toMatch(/permission denied/i);
    const anonRpc = await anon.rpc('app_notifications');
    expect(anonRpc.error?.message).toMatch(/permission denied|function|schema cache/i);

    const insert = await owner
      .from('notifications')
      .insert({ account_id: identity('owner').id, kind: 'forged', title: 'Forged notice' });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const rewrite = await owner
      .from('notifications')
      .update({ title: 'Rewritten' })
      .eq('account_id', identity('owner').id);
    expect(rewrite.error?.message).toMatch(/permission denied/i);

    const erase = await admin.from('notifications').delete().eq('account_id', identity('owner').id);
    expect(erase.error?.message).toMatch(/permission denied/i);
  });
});

describe('record events', () => {
  // Fresh ids per run: the table is append-only, so a rerun without a database
  // reset must not collide with rows an earlier run already wrote.
  const personId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const accountEntityId = crypto.randomUUID();

  beforeAll(async () => {
    // Two inserts, not one: PostgREST sends a single column list for a batch, so
    // a row that omits `performed_via` would be given an explicit NULL instead of
    // the column default. Splitting them also proves the default applies.
    const plain = await service.from('record_events').insert([
      {
        entity_type: 'requester',
        entity_id: personId,
        kind: 'person_created',
        actor_id: identity('admin').id,
        summary: 'Added Rowan Vance to the directory',
      },
      {
        entity_type: 'account',
        entity_id: accountEntityId,
        kind: 'account_provisioned',
        actor_id: identity('admin').id,
        summary: 'Provisioned a technician account',
      },
    ]);
    if (plain.error) throw new Error(`Could not seed record events: ${plain.error.message}`);

    const assisted = await service.from('record_events').insert({
      entity_type: 'inventory_device',
      entity_id: deviceId,
      kind: 'device_created',
      actor_id: identity('admin').id,
      summary: 'Added Chromebook C-1042',
      performed_via: 'ai',
      ai_model: 'gpt-5.6-luna',
    });
    if (assisted.error) throw new Error(`Could not seed record events: ${assisted.error.message}`);
  });

  it('defaults an unattributed record event to a user action', async () => {
    const { data } = await service
      .from('record_events')
      .select('performed_via, ai_model')
      .eq('entity_id', personId)
      .single();
    expect(data?.performed_via).toBe('user');
    expect(data?.ai_model).toBeNull();
  });

  it('lets an active technician read person and device history only', async () => {
    const { data, error } = await owner.from('record_events').select('entity_type, entity_id');
    expect(error).toBeNull();
    const types = new Set((data ?? []).map((row) => row.entity_type));
    expect(types).toEqual(new Set(['requester', 'inventory_device']));
  });

  it('lets an admin read account history too', async () => {
    const { data, error } = await admin.from('record_events').select('entity_type');
    expect(error).toBeNull();
    const types = new Set((data ?? []).map((row) => row.entity_type));
    // Everything the technician above can see, plus the entity types reserved
    // for administrators. The exact set is asserted on the TECHNICIAN, which is
    // where the confidentiality rule lives; asserting it here as well would make
    // this file depend on which other suite happened to run first, because
    // record events are append-only and other M5 suites write admin-only kinds
    // (invites, imports) into the same table.
    expect(types).toContain('requester');
    expect(types).toContain('inventory_device');
    expect(types).toContain('account');
  });

  it('keeps AI attribution on a record event', async () => {
    const { data } = await owner
      .from('record_events')
      .select('performed_via, ai_model')
      .eq('entity_id', deviceId)
      .single();
    expect(data?.performed_via).toBe('ai');
    expect(data?.ai_model).toBe('gpt-5.6-luna');
  });

  it('shows nothing to an account awaiting setup or to anonymous callers', async () => {
    const pendingRead = await pending.from('record_events').select('id');
    expect(pendingRead.error).toBeNull();
    expect(pendingRead.data ?? []).toHaveLength(0);

    const anonRead = await anonClient().from('record_events').select('id');
    expect(anonRead.error?.message).toMatch(/permission denied/i);
  });

  it('cannot be written, rewritten or erased from a session', async () => {
    const insert = await admin.from('record_events').insert({
      entity_type: 'requester',
      entity_id: personId,
      kind: 'forged',
      summary: 'Fabricated history',
    });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await admin
      .from('record_events')
      .update({ summary: 'Rewritten history' })
      .eq('entity_id', personId);
    expect(update.error?.message).toMatch(/permission denied/i);

    const remove = await admin.from('record_events').delete().eq('entity_id', personId);
    expect(remove.error?.message).toMatch(/permission denied/i);
  });

  it('is append-only even for the service role', async () => {
    const rewrite = await service
      .from('record_events')
      .update({ summary: 'Rewritten history' })
      .eq('entity_id', personId);
    expect(rewrite.error?.message).toMatch(/append-only/i);

    const erase = await service.from('record_events').delete().eq('entity_id', personId);
    expect(erase.error?.message).toMatch(/append-only/i);
  });

  it('refuses an unknown entity type and an unknown attribution, even for the service role', async () => {
    const badType = await service.from('record_events').insert({
      entity_type: 'ticket',
      entity_id: personId,
      kind: 'person_created',
      summary: 'Wrong entity type',
    });
    expect(badType.error?.message).toMatch(/record_events_entity_type_valid/);

    const badVia = await service.from('record_events').insert({
      entity_type: 'requester',
      entity_id: personId,
      kind: 'person_created',
      summary: 'Wrong attribution',
      performed_via: 'robot',
    });
    expect(badVia.error?.message).toMatch(/record_events_performed_via_valid/);
  });
});
