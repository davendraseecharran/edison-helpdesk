import { expect, it } from 'vitest';
import { collaborativeTicket, identity, ownedTicket, rpcOk, signIn } from './support/harness';

it('shows and searches permitted owner labels without exposing account rows', async () => {
  const { ticketId } = await collaborativeTicket();
  const client = await signIn('collaborator');
  const account = await client.from('app_accounts').select('*').eq('id', identity('owner').id);
  expect(account.error).toBeNull();
  expect(account.data).toEqual([]);
  const rows = await rpcOk<Array<Record<string, unknown>>>(client, 'app_list_tickets', {
    p_scope: 'collaborating', p_query: identity('owner').displayName,
  });
  expect(rows.find(row => row.id === ticketId)?.owner_name).toBe(identity('owner').displayName);
  const detail = await rpcOk<{ticket: Record<string, unknown>}>(client, 'app_ticket_detail', {p_ticket: ticketId});
  expect(detail.ticket.owner_name).toBe(identity('owner').displayName);
});

it('keeps hidden tickets out of persisted search, detail and counts', async () => {
  const title = `Private regression ${crypto.randomUUID()}`;
  const {ticketId} = await ownedTicket({title});
  const client = await signIn('unrelated');
  expect(await rpcOk(client, 'app_list_tickets', {p_scope:'closed', p_query:title})).toEqual([]);
  expect(await rpcOk(client, 'app_list_tickets', {p_scope:'open_queue', p_query:title})).toEqual([]);
  expect(await rpcOk(client, 'app_ticket_detail', {p_ticket:ticketId})).toBeNull();
});

it('treats malformed owner filters as no matches rather than a server error', async () => {
  expect(await rpcOk(await signIn('admin'), 'app_list_tickets', {p_scope:'all',p_owner:'not-a-uuid'})).toEqual([]);
});
