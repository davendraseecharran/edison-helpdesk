import { describe, expect, it } from 'vitest';
import { identity, openTicket, rawEvents, rawTicket, rpcFails, rpcOk, signIn, UNAVAILABLE } from './support/harness';

const attempts: Array<[string, Record<string, unknown>]> = [
  ['app_add_note', { p_body: 'Unauthorized note on unclaimed work' }],
  ['app_record_device', { p_device_type: 'Laptop' }],
  ['app_set_priority', { p_priority: 'urgent' }],
  ['app_log_work', { p_minutes: 10 }],
  ['app_resolve_ticket', { p_solution: 'Unauthorized resolution' }],
  ['app_add_collaborator', {}],
  ['app_remove_collaborator', {}],
];

describe('unowned ticket authorization never treats NULL as permission', () => {
  it.each(attempts)('refuses %s from an unrelated technician on visible open work', async (fn, args) => {
    const id = await openTicket({ collaboratorIds: [identity('collaborator').id] });
    const client = await signIn('unrelated');
    const before = await rawTicket(id);
    const events = await rawEvents(id);
    const { data, error } = await client.from('tickets').select('id').eq('id', id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1); // Can see and claim, not contribute/manage before claiming.
    await rpcFails(client, fn, {
      p_ticket: id,
      ...args,
      ...(fn.includes('collaborator') ? { p_account: identity(fn === 'app_add_collaborator' ? 'owner' : 'collaborator').id } : {}),
    });
    expect(await rawTicket(id)).toEqual(before);
    expect(await rawEvents(id)).toEqual(events);
  });

  it('denies invisible unowned closed work without leaking its status through RPC errors', async () => {
    const admin = await signIn('admin');
    const client = await signIn('unrelated');
    const id = await openTicket();
    await rpcOk(admin, 'app_resolve_ticket', { p_ticket: id, p_solution: 'Admin completed unowned request' });
    const before = await rawEvents(id);
    const { data, error } = await client.from('tickets').select('id').eq('id', id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    for (const [fn, args] of attempts) {
      const failure = await rpcFails(client, fn, {
        p_ticket: id, ...args,
        ...(fn.includes('collaborator') ? { p_account: identity(fn === 'app_add_collaborator' ? 'owner' : 'collaborator').id } : {}),
      });
      expect(failure.message).toBe(UNAVAILABLE);
    }
    expect(await rawEvents(id)).toEqual(before);
  });

  it('retains collaborator authority after return, and lets a new owner claim', async () => {
    const admin = await signIn('admin');
    const helper = await signIn('collaborator');
    const unrelated = await signIn('unrelated');
    const id = await openTicket({ ownerId: identity('owner').id, collaboratorIds: [identity('collaborator').id] });
    await rpcOk(await signIn('owner'), 'app_return_ticket_to_queue', { p_ticket: id });
    await rpcOk(helper, 'app_add_note', { p_ticket: id, p_body: 'Preserved collaborator continues helping' });
    await rpcFails(helper, 'app_add_collaborator', { p_ticket: id, p_account: identity('unrelated').id });
    await rpcOk(unrelated, 'app_claim_ticket', { p_ticket: id });
    await rpcOk(helper, 'app_resolve_ticket', { p_ticket: id, p_solution: 'Collaborator verified repair after reclaim' });
    const result = await admin.from('tickets').select('owner_id,resolved_by').eq('id', id).single();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ owner_id: identity('unrelated').id, resolved_by: identity('collaborator').id });
  });
});
