/**
 * `app_join_ticket`: a NetRider puts themselves on a colleague's ticket.
 *
 * The ticket is one the helper cannot see beforehand — that is the point —
 * so every call goes through the number. What has to be true afterwards: the
 * collaborator row says they added themselves, the activity log says so in
 * words, the owner has a notice, and the ticket is now visible to the helper.
 */

import { describe, expect, it } from 'vitest';
import {
  adminServiceClient,
  identity,
  openTicket,
  ownedTicket,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

async function numberOf(ticketId: string): Promise<string> {
  const ticket = await rawTicket(ticketId);
  return String(ticket.number);
}

describe('app_join_ticket', () => {
  it('puts a NetRider on a colleague’s ticket, logs it as their own doing, and tells the owner', async () => {
    const { ticketId } = await ownedTicket();
    const number = await numberOf(ticketId);
    const helper = await signIn('collaborator');

    // Not visible before: the queue, their own, and their collaborations only.
    const before = await helper.from('tickets').select('id').eq('id', ticketId);
    expect(before.data).toEqual([]);

    const id = await rpcOk<string>(helper, 'app_join_ticket', { p_number: number.toLowerCase() });
    expect(id).toBe(ticketId);

    const rows = await adminServiceClient()
      .from('ticket_collaborators')
      .select('account_id, added_by')
      .eq('ticket_id', ticketId);
    expect(rows.data).toEqual([
      { account_id: identity('collaborator').id, added_by: identity('collaborator').id },
    ]);

    const events = await rawEvents(ticketId);
    const last = events[events.length - 1];
    expect(last.kind).toBe('collaborator_added');
    expect(last.actor_id).toBe(identity('collaborator').id);
    expect(String(last.summary)).toContain('joined');
    expect(String(last.summary)).toContain('added themselves');

    const notices = await adminServiceClient()
      .from('notifications')
      .select('kind, title, href')
      .eq('account_id', identity('owner').id)
      .eq('kind', 'collaborator_joined');
    expect(notices.data?.some((notice) => String(notice.title).includes(number))).toBe(true);
    expect(notices.data?.some((notice) => notice.href === `/tickets/${ticketId}`)).toBe(true);

    // Visible now, and a second join is the same answer rather than an error.
    const after = await helper.from('tickets').select('id').eq('id', ticketId);
    expect(after.data).toHaveLength(1);
    expect(await rpcOk<string>(helper, 'app_join_ticket', { p_number: number })).toBe(ticketId);
    const again = await adminServiceClient()
      .from('ticket_collaborators')
      .select('account_id')
      .eq('ticket_id', ticketId);
    expect(again.data).toHaveLength(1);
  });

  it('takes the bare digits and the spelling without the dash', async () => {
    const { ticketId } = await ownedTicket();
    const number = await numberOf(ticketId);
    const digits = number.replace(/^EDT-/, '');
    const helper = await signIn('collaborator');
    expect(await rpcOk<string>(helper, 'app_join_ticket', { p_number: ` ${digits} ` })).toBe(ticketId);
    expect(await rpcOk<string>(helper, 'app_join_ticket', { p_number: `edt${digits}` })).toBe(ticketId);
  });

  it('refuses the owner, unowned work, and a number that does not exist', async () => {
    const { ticketId } = await ownedTicket();
    const number = await numberOf(ticketId);
    const owner = await signIn('owner');
    const own = await rpcFails(owner, 'app_join_ticket', { p_number: number });
    expect(own.message).toContain('already own');

    const queued = await openTicket();
    const helper = await signIn('collaborator');
    const unowned = await rpcFails(helper, 'app_join_ticket', { p_number: await numberOf(queued) });
    expect(unowned.message).toContain('Claim it from the queue');

    const missing = await rpcFails(helper, 'app_join_ticket', { p_number: 'EDT-999999999' });
    expect(missing.message).toContain('No ticket with that number');
  });

  it('is closed to a skills officer, who works no tickets', async () => {
    const { ticketId } = await ownedTicket();
    const number = await numberOf(ticketId);
    const officer = await signIn('skillsOfficer');
    const refused = await rpcFails(officer, 'app_join_ticket', { p_number: number });
    expect(refused.message).toContain('Only a NetRider or an administrator');
  });
});
