/**
 * M5 audit log and ticket notifications.
 *
 * Two halves of the same idea: the desk should be able to see what happened, and
 * the people it happened to should be told.
 *
 * The audit log is one administrator-only read across three append-only tables —
 * ticket activity, account events and record events — so "who changed what, when,
 * and was an assistant involved" is one question rather than three. It is
 * SECURITY DEFINER and refuses a technician outright rather than quietly
 * returning an empty page, because an empty page is indistinguishable from a
 * quiet desk and would hide the refusal.
 *
 * The notifications are the other half. A technician learns they were handed a
 * ticket without having to poll the queue. Nobody is ever told about their own
 * action: an administrator who adds themselves to a ticket, or an owner who puts
 * their own ticket back in the queue, gets nothing.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, so no test proves something about a privileged path the
 * application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  identity,
  openTicket,
  ownedTicket,
  rawTicket,
  rpcFails,
  rpcOk,
  signIn,
  signInWithHeaders,
} from './support/harness';

/** insufficient_privilege, as PostgREST reports it. */
const REFUSED = '42501';

interface AuditRow {
  source: string;
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  performed_via: string;
  ai_model: string | null;
  kind: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  summary: string;
  detail: string | null;
  total_count: number;
}

interface NotificationRow {
  id: string;
  account_id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
}

const RUN = String(Math.floor(Math.random() * 9000) + 1000);

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;

async function auditLog(
  client: SupabaseClient,
  args: Record<string, unknown> = {},
): Promise<AuditRow[]> {
  return rpcOk<AuditRow[]>(client, 'app_audit_log', args);
}

/** Every notice a given account holds about a given ticket, oldest first. */
async function noticesFor(accountId: string, ticketId: string): Promise<NotificationRow[]> {
  const { data, error } = await service
    .from('notifications')
    .select('*')
    .eq('account_id', accountId)
    .eq('href', `/tickets/${ticketId}`)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read notifications: ${error.message}`);
  return (data ?? []) as NotificationRow[];
}

beforeAll(async () => {
  service = adminServiceClient();
  admin = await signIn('admin');
  owner = await signIn('owner');
});

describe('a technician is told when a ticket becomes theirs', () => {
  it('notifies the new owner of a reassignment, and nobody else', async () => {
    const { ticketId } = await ownedTicket({ title: `Docking station dead ${RUN}` });
    const number = String((await rawTicket(ticketId)).number);

    await rpcOk(admin, 'app_reassign_ticket', {
      p_ticket: ticketId,
      p_new_owner: identity('collaborator').id,
    });

    const notices = await noticesFor(identity('collaborator').id, ticketId);
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('ticket_assigned');
    expect(notices[0].title).toBe(`You were assigned ${number}`);
    expect(notices[0].body).toContain(`Docking station dead ${RUN}`);
    expect(notices[0].href).toBe(`/tickets/${ticketId}`);

    // The administrator who made the change is not told about their own action,
    // and the previous owner is not told they were assigned anything.
    expect(await noticesFor(identity('admin').id, ticketId)).toHaveLength(0);
    expect(
      (await noticesFor(identity('owner').id, ticketId)).map((row) => row.kind),
    ).not.toContain('ticket_assigned');
  });

  it('notifies an account added as a collaborator', async () => {
    const { ticketId } = await ownedTicket({ title: `Cart wheel seized ${RUN}` });

    await rpcOk(owner, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });

    const notices = await noticesFor(identity('collaborator').id, ticketId);
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('collaborator_added');
    expect(notices[0].href).toBe(`/tickets/${ticketId}`);
  });

  it('tells nobody when an administrator adds themselves as a collaborator', async () => {
    const { ticketId } = await ownedTicket({ title: `Beamer lamp flickers ${RUN}` });

    await rpcOk(admin, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('admin').id,
    });

    expect(await noticesFor(identity('admin').id, ticketId)).toHaveLength(0);
  });

  it('tells the owner when their resolved ticket is reopened', async () => {
    const { ticketId } = await ownedTicket({ title: `Label printer jams ${RUN}` });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Cleared the jam and reseated the roller.',
    });

    await rpcOk(admin, 'app_reopen_ticket', {
      p_ticket: ticketId,
      p_reason: 'It jammed again the next morning.',
    });

    const notices = await noticesFor(identity('owner').id, ticketId);
    expect(notices.map((row) => row.kind)).toContain('ticket_reopened');
  });
});

describe('the desk is told when a ticket comes back to the queue', () => {
  it('notifies administrators but not the owner who returned it', async () => {
    const { ticketId } = await ownedTicket({ title: `Chromebook wont charge ${RUN}` });

    await rpcOk(owner, 'app_return_ticket_to_queue', { p_ticket: ticketId });

    const forAdmin = await noticesFor(identity('admin').id, ticketId);
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0].kind).toBe('ticket_returned');
    expect(forAdmin[0].href).toBe(`/tickets/${ticketId}`);

    // Nobody is told about their own action.
    expect(await noticesFor(identity('owner').id, ticketId)).toHaveLength(0);
  });
});

describe('the audit log is administrator-only', () => {
  it('refuses a technician instead of returning an empty page', async () => {
    const failure = await rpcFails(owner, 'app_audit_log', {});
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/administrator/i);
  });
});

describe('what the audit log shows', () => {
  it('carries a ticket note with its attribution and the ticket number', async () => {
    const { ticketId } = await ownedTicket({ title: `Keyboard keys missing ${RUN}` });
    const number = String((await rawTicket(ticketId)).number);
    await rpcOk(owner, 'app_add_note', {
      p_ticket: ticketId,
      p_body: `Ordered replacement caps ${RUN}.`,
    });

    const rows = await auditLog(admin, { p_entity: 'ticket', p_limit: 200 });
    const note = rows.find((row) => row.entity_id === ticketId && row.kind === 'note_added');

    expect(note).toBeDefined();
    expect(note?.source).toBe('activity');
    expect(note?.entity_type).toBe('ticket');
    expect(note?.entity_label).toBe(number);
    expect(note?.actor_id).toBe(identity('owner').id);
    expect(note?.actor_name).toBe(identity('owner').displayName);
    expect(note?.performed_via).toBe('user');
    expect(note?.ai_model).toBeNull();
    expect(note?.detail).toContain(`Ordered replacement caps ${RUN}.`);
  });

  it('separates assistant-performed work from work a person did directly', async () => {
    const { ticketId } = await ownedTicket({ title: `Smart board drifts ${RUN}` });
    const assisted = await signInWithHeaders('owner', {
      'x-edison-via': 'ai',
      'x-edison-ai-model': 'gpt-5.6-luna',
    });
    await rpcOk(assisted, 'app_add_note', {
      p_ticket: ticketId,
      p_body: `Recalibrated from the assistant ${RUN}.`,
    });

    const aiRows = await auditLog(admin, { p_via: 'ai', p_limit: 200 });
    expect(aiRows.length).toBeGreaterThan(0);
    // The filter is the whole claim: nothing a person did directly appears here.
    expect(aiRows.every((row) => row.performed_via === 'ai')).toBe(true);

    const assistedNote = aiRows.find(
      (row) => row.entity_id === ticketId && row.kind === 'note_added',
    );
    expect(assistedNote?.ai_model).toBe('gpt-5.6-luna');
    // Attribution never replaces identity: the human account is still the actor.
    expect(assistedNote?.actor_id).toBe(identity('owner').id);

    const userRows = await auditLog(admin, { p_via: 'user', p_limit: 200 });
    expect(userRows.every((row) => row.performed_via === 'user')).toBe(true);
    expect(userRows.map((row) => row.id)).not.toContain(assistedNote?.id);
  });

  it('labels an account event with the account it is about', async () => {
    // A real status change through the real RPC, then straight back, so the
    // seeded identity is left exactly as the suite found it.
    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('inactive').id,
      p_status: 'active',
    });
    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('inactive').id,
      p_status: 'inactive',
    });

    const rows = await auditLog(admin, { p_entity: 'account', p_limit: 200 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.entity_type === 'account')).toBe(true);
    // An account event names the account it is about, not just its uuid. Only
    // the account_events half is asserted: a record event may name a record that
    // no longer exists, and the log shows that as an absent label rather than
    // inventing a name for it.
    const fromAccountEvents = rows.filter((row) => row.source === 'account');
    expect(fromAccountEvents.length).toBeGreaterThan(0);
    expect(fromAccountEvents.every((row) => (row.entity_label ?? '').length > 0)).toBe(true);

    const change = rows.find(
      (row) => row.entity_id === identity('inactive').id && row.kind === 'status_changed',
    );
    expect(change?.source).toBe('account');
    expect(change?.entity_label).toBe(identity('inactive').displayName);
    expect(change?.actor_name).toBe(identity('admin').displayName);
    // An account event is never an assistant action; the column still answers.
    expect(change?.performed_via).toBe('user');
  });

  it('labels a record event with the record it is about', async () => {
    const personId = await rpcOk<string>(admin, 'app_upsert_person', {
      p_person: {
        kind: 'staff',
        first_name: 'Imani',
        last_name: `Okonkwo-${RUN}`,
        display_name: `Imani Okonkwo-${RUN}`,
        department: 'Science',
      },
    });
    const deviceId = await rpcOk<string>(admin, 'app_upsert_device', {
      p_device: { asset_tag: `DOE-AU${RUN}1`, model: 'Latitude 3540', type: 'Laptop' },
    });

    const people = await auditLog(admin, { p_entity: 'person', p_limit: 200 });
    const person = people.find((row) => row.entity_id === personId);
    expect(person?.source).toBe('record');
    expect(person?.entity_label).toBe(`Imani Okonkwo-${RUN}`);

    const devices = await auditLog(admin, { p_entity: 'device', p_limit: 200 });
    const device = devices.find((row) => row.entity_id === deviceId);
    expect(device?.entity_label).toBe(`DOE-AU${RUN}1`);
  });
});

describe('filtering, ordering and paging', () => {
  it('reports a total that survives paging and matches the filtered set', async () => {
    const { ticketId } = await ownedTicket({ title: `Audio out crackles ${RUN}` });
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: `First ${RUN}.` });
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: `Second ${RUN}.` });

    const all = await auditLog(admin, { p_entity: 'ticket', p_limit: 200 });
    const total = Number(all[0]?.total_count);
    expect(all.length).toBeLessThanOrEqual(200);

    const firstPage = await auditLog(admin, { p_entity: 'ticket', p_limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(Number(firstPage[0].total_count)).toBe(total);

    const secondPage = await auditLog(admin, { p_entity: 'ticket', p_limit: 2, p_offset: 2 });
    expect(Number(secondPage[0].total_count)).toBe(total);
    // Paging does not repeat a row.
    expect(secondPage.map((row) => row.id)).not.toContain(firstPage[0].id);
  });

  it('returns the newest first', async () => {
    const rows = await auditLog(admin, { p_limit: 50 });
    const times = rows.map((row) => new Date(row.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters by actor, by kind and by time', async () => {
    const { ticketId } = await ownedTicket({ title: `Mouse double clicks ${RUN}` });
    const before = new Date().toISOString();
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: `Swapped it ${RUN}.` });

    const byActor = await auditLog(admin, { p_actor: identity('owner').id, p_limit: 200 });
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((row) => row.actor_id === identity('owner').id)).toBe(true);

    const byKind = await auditLog(admin, { p_kind: 'note_added', p_limit: 200 });
    expect(byKind.length).toBeGreaterThan(0);
    expect(byKind.every((row) => row.kind === 'note_added')).toBe(true);

    const since = await auditLog(admin, { p_from: before, p_limit: 200 });
    expect(since.every((row) => new Date(row.at).getTime() >= new Date(before).getTime() - 1000))
      .toBe(true);
    expect(since.some((row) => row.entity_id === ticketId)).toBe(true);

    // A window that closed before the note was written cannot contain it.
    const until = await auditLog(admin, { p_to: before, p_limit: 200 });
    expect(until.some((row) => row.entity_id === ticketId && row.kind === 'note_added')).toBe(
      false,
    );
  });

  it('clamps the page size rather than letting one call read the whole history', async () => {
    const huge = await auditLog(admin, { p_limit: 5000 });
    expect(huge.length).toBeLessThanOrEqual(200);

    // A caller asking for no rows is asking for no rows.
    expect(await auditLog(admin, { p_limit: 0 })).toHaveLength(0);
  });

  it('fails closed on a filter value that is not one of the known ones', async () => {
    expect(await auditLog(admin, { p_via: 'somehow-else' })).toHaveLength(0);
    expect(await auditLog(admin, { p_entity: 'not-an-entity' })).toHaveLength(0);
  });
});

describe('the log covers every history table', () => {
  it('shows ticket, account and record history in one unfiltered page', async () => {
    // Arranged by the tests above; this proves the union rather than three
    // separate reads the application would have to stitch together.
    await openTicket({ title: `Union check ${RUN}` });
    const rows = await auditLog(admin, { p_limit: 200 });
    expect(new Set(rows.map((row) => row.source)).size).toBeGreaterThan(1);
    expect(rows.every((row) => ['activity', 'account', 'record'].includes(row.source))).toBe(true);
  });
});
