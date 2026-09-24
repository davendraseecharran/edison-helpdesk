/**
 * The week in review (September 24).
 *
 * `app_weekly_summary` answers the caller's own week, with tickets only for
 * somebody who works them; `app_weekly_summary_notify` writes one notice per
 * week about the week before; `app_weekly_summary_recipients` is the service
 * role's alone. Counts only: nothing names a person or a ticket.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  ownedTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

interface Summary {
  week_start: string;
  tickets: { you_resolved: number; desk_resolved: number; you_own_open: number } | null;
  events: unknown[];
  checkins: number;
  form_responses: number;
}

let netrider: SupabaseClient;
let officer: SupabaseClient;

beforeAll(async () => {
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
});

describe('app_weekly_summary', () => {
  it("counts a NetRider's own resolution this week", async () => {
    const before = await rpcOk<Summary>(netrider, 'app_weekly_summary', {});
    const { ticketId } = await ownedTicket();
    await rpcOk(netrider, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: 'Reseated the cable.' });
    const after = await rpcOk<Summary>(netrider, 'app_weekly_summary', {});
    expect(after.tickets?.you_resolved).toBe((before.tickets?.you_resolved ?? 0) + 1);
    expect(after.tickets?.desk_resolved).toBe((before.tickets?.desk_resolved ?? 0) + 1);
    expect(JSON.stringify(after)).not.toContain('Reseated');
  });

  it('gives a skills officer no ticket section', async () => {
    const summary = await rpcOk<Summary>(officer, 'app_weekly_summary', {});
    expect(summary.tickets).toBeNull();
    expect(Array.isArray(summary.events)).toBe(true);
  });

  it('refuses a future week and the anonymous', async () => {
    const future = await rpcFails(netrider, 'app_weekly_summary', { p_week_start: '2099-01-05' });
    expect(future.message).toMatch(/between 2020 and this one/);
    const { error } = await anonClient().rpc('app_weekly_summary');
    expect(error).not.toBeNull();
  });
});

describe('app_weekly_summary_notify', () => {
  it('writes at most one notice a week', async () => {
    // Last week needs something in it: a walk-in logged already resolved,
    // opened and resolved seven days ago (always inside last school week).
    const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await rpcOk(netrider, 'app_create_ticket', {
      p_title: 'Chromebook will not charge',
      p_issue: 'Brought to the desk before first period.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_opened_at: new Date(lastWeek.getTime() - 3600 * 1000).toISOString(),
      p_solution: 'Replaced the adapter.',
      p_resolved_at: lastWeek.toISOString(),
    });
    await adminServiceClient()
      .from('notifications')
      .delete()
      .eq('account_id', identity('owner').id)
      .eq('kind', 'weekly_summary');

    const first = await rpcOk<boolean>(netrider, 'app_weekly_summary_notify', {});
    const second = await rpcOk<boolean>(netrider, 'app_weekly_summary_notify', {});
    expect(first).toBe(true);
    expect(second).toBe(false);
    const { data } = await adminServiceClient()
      .from('notifications')
      .select('title, body, href')
      .eq('account_id', identity('owner').id)
      .eq('kind', 'weekly_summary');
    expect(data).toHaveLength(1);
    expect(data?.[0].title).toBe('Your week in review');
    expect(data?.[0].body).toMatch(/You resolved \d+ tickets?; the desk closed \d+\./);
    expect(data?.[0].href).toMatch(/^\/summary\?week=\d{4}-\d{2}-\d{2}$/);
  });
});

describe('app_weekly_summary_recipients and the email switch', () => {
  it('is the service role\'s alone, and honours the switch', async () => {
    const { error } = await netrider.rpc('app_weekly_summary_recipients', { p_week_start: '2026-09-14' });
    expect(error).not.toBeNull();

    await rpcOk(netrider, 'app_set_weekly_summary_email', { p_on: false });
    const off = await adminServiceClient().rpc('app_weekly_summary_recipients', { p_week_start: '2026-09-14' });
    expect(off.error).toBeNull();
    expect((off.data as Array<{ account_id: string }>).some((r) => r.account_id === identity('owner').id)).toBe(false);

    await rpcOk(netrider, 'app_set_weekly_summary_email', { p_on: true });
    const on = await adminServiceClient().rpc('app_weekly_summary_recipients', { p_week_start: '2026-09-14' });
    expect((on.data as Array<{ account_id: string }>).some((r) => r.account_id === identity('owner').id)).toBe(true);
  });
});
