/**
 * `desk_analytics`, the assistant's half of the Analytics page.
 *
 * Three things are worth pinning, and they are the three that would go wrong
 * quietly:
 *
 *   1. The period is turned into instants by the SAME `periodBounds` the page
 *      calls. A tool that decided for itself where a school week began would
 *      answer a different question from the chart beside it, and nobody would
 *      notice until two numbers were read out in the same sentence.
 *   2. The document is TRIMMED, not forwarded. The heat matrix, the per-day
 *      bars and the per-person ranking are the page's; what comes back is what
 *      somebody would say out loud.
 *   3. It is desk work, so a skills officer is neither offered it nor allowed
 *      to call it, and a refusal from the database is an ordinary refusal.
 */

import { describe, expect, it } from 'vitest';
import {
  executeTool,
  isWriteTool,
  READ_TOOLS,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';
import { bucketFor, HONOUR_TITLES, periodBounds } from '../../src/lib/domain/analytics';
import { STATS_PERIODS } from '../../src/lib/domain/resolved-stats';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** The stub the other tool suites use, with a way to make an RPC refuse. */
function context(
  options: {
    results?: Record<string, unknown>;
    roles?: string[];
    error?: { code: string; message: string };
  } = {},
): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (options.error !== undefined) return { data: null, error: options.error };
        const results = options.results ?? {};
        return { data: fn in results ? results[fn] : null, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

/**
 * One month's document, in the shape `app_analytics` returns and the keys it
 * spells them with. Small, but every branch of the trimming is in it: a
 * redacted hard ticket, an honour nobody earned, the heat matrix and the
 * per-person ranking that must not come back.
 */
const DOCUMENT = {
  period: 'month',
  bucket: 'day',
  since: '2026-09-01T04:00:00+00:00',
  until: '2026-09-16T18:30:00+00:00',
  overview: {
    resolved: 84,
    resolved_previous: 70,
    created: 91,
    created_previous: 88,
    cancelled: 3,
    reopened: 4,
    median_hours: 5.5,
    median_hours_previous: 7.25,
    p90_hours: 41,
    same_day_share: 0.62,
    school_days: 12,
    per_school_day: 7,
    per_week: 35,
    open_now: 19,
    unassigned_now: 4,
    waiting_now: 6,
    oldest_open_hours: 312,
  },
  throughput: [
    { key: '2026-09-14', created: 9, resolved: 7, backlog: 21 },
    { key: '2026-09-15', created: 12, resolved: 14, backlog: 19 },
    { key: '2026-09-16', created: 5, resolved: 8, backlog: 16 },
  ],
  arrivals: {
    by_weekday: [21, 18, 17, 19, 16, 0, 0],
    by_hour: Array.from({ length: 24 }, (_, hour) => (hour >= 8 && hour <= 15 ? hour : 0)),
    heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1)),
  },
  categories: [
    { category: 'chromebook', resolved: 36, created: 40, share: 0.4286, median_hours: 4.5, trend: [3, 5, 2] },
    { category: 'network', resolved: 12, created: 15, share: 0.1429, median_hours: 9.75, trend: [1, 1, 0] },
  ],
  priorities: [
    {
      priority: 'urgent',
      resolved: 8,
      share: 0.0952,
      median_hours: 1.5,
      p90_hours: 4,
      median_from_claim_hours: 0.75,
    },
    {
      priority: 'normal',
      resolved: 61,
      share: 0.7262,
      median_hours: 6,
      p90_hours: 48,
      median_from_claim_hours: null,
    },
  ],
  channels: [
    { channel: 'walk_in', count: 55, share: 0.6044 },
    { channel: 'email', count: 36, share: 0.3956 },
  ],
  locations: [{ location: '214', count: 12 }],
  remote: 5,
  requesters: {
    staff: 60,
    student: 28,
    other: 3,
    repeat: [{ name: 'Marcus Ellery', kind: 'staff', count: 6 }],
  },
  waiting: {
    tickets_waited: 15,
    share: 0.1786,
    median_wait_hours: 20.5,
    reasons: [{ reason: 'Waiting on a part', count: 9 }],
  },
  people: {
    honours: [
      {
        key: 'fastest_urgent',
        account_id: 'acc-1',
        name: 'Dev Okafor',
        value: '2h 10m',
        detail: 'Median time from claim to resolved on urgent tickets, over at least three of them.',
      },
      {
        key: 'most_hands',
        account_id: null,
        name: null,
        value: null,
        detail: 'Nobody joined a colleague’s ticket this month.',
      },
    ],
    rows: [
      {
        account_id: 'acc-1',
        name: 'Dev Okafor',
        resolved: 44,
        median_hours: 3,
        median_from_claim_hours: 1,
        urgent_high: 12,
        hard_score: 8.5,
        joined: 2,
        reopened: 1,
      },
    ],
    me: {
      account_id: 'actor-1',
      name: 'Nia Example',
      resolved: 21,
      median_hours: 4,
      median_from_claim_hours: 1.5,
      urgent_high: 6,
      hard_score: 7.25,
      joined: 3,
      reopened: 1,
    },
  },
  hardest: [
    {
      ticket_id: 'ticket-1',
      number: 'EDT-1042',
      title: 'Projector will not wake',
      category: 'projector_display',
      priority: 'high',
      hours: 96.5,
      from_claim_hours: 40,
      resolver_name: 'Dev Okafor',
      hands: 3,
      score: 15.2,
    },
    {
      // A colleague's ticket this reader may not open: the row counts, the
      // number and the title are not there to quote.
      ticket_id: 'ticket-2',
      number: null,
      title: null,
      category: 'network',
      priority: 'urgent',
      hours: 30,
      from_claim_hours: null,
      resolver_name: null,
      hands: 1,
      score: 13.7,
    },
  ],
};

describe('desk_analytics', () => {
  it('asks for the same bounds and bucket the page asks for, for every period', async () => {
    for (const period of STATS_PERIODS) {
      const { ctx, calls } = context({ results: { app_analytics: DOCUMENT } });
      const result = await executeTool('desk_analytics', { period }, ctx);
      expect(result.ok).toBe(true);
      const bounds = periodBounds(period);
      expect(calls).toEqual([
        {
          fn: 'app_analytics',
          args: { p_since: bounds.since, p_until: bounds.until, p_bucket: bucketFor(period) },
        },
      ]);
    }
  });

  it('reads this month when nobody says which period', async () => {
    const { ctx, calls } = context({ results: { app_analytics: DOCUMENT } });
    const result = await executeTool('desk_analytics', {}, ctx);
    expect(result.ok).toBe(true);
    expect(calls[0].args).toEqual({
      p_since: periodBounds('month').since,
      p_until: null,
      p_bucket: 'day',
    });
    expect((result.result as Record<string, unknown>).period).toBe('month');
    // All time has no lower bound at all, and the bars are months by then.
    const everything = context({ results: { app_analytics: DOCUMENT } });
    await executeTool('desk_analytics', { period: 'all' }, everything.ctx);
    expect(everything.calls[0].args).toEqual({ p_since: null, p_until: null, p_bucket: 'month' });
  });

  it('trims the document to what somebody would say out loud', async () => {
    const { ctx } = context({ results: { app_analytics: DOCUMENT } });
    const result = await executeTool('desk_analytics', { period: 'month' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      period: 'month',
      bucket: 'day',
      since: '2026-09-01T04:00:00+00:00',
      until: '2026-09-16T18:30:00+00:00',
      // The overview is the answer to most of the questions, so it comes whole.
      overview: DOCUMENT.overview,
      // Three days of bars become their totals and their two ends.
      throughput: { slices: 3, created: 26, resolved: 29, backlog_first: 21, backlog_last: 16 },
      arrivals: {
        by_weekday: [21, 18, 17, 19, 16, 0, 0],
        by_hour: DOCUMENT.arrivals.by_hour,
      },
      categories: [
        { category: 'Chromebook', resolved: 36, share: '43%', median_hours: 4.5 },
        { category: 'Network or Wi-Fi', resolved: 12, share: '14%', median_hours: 9.75 },
      ],
      priorities: [
        {
          priority: 'Urgent',
          resolved: 8,
          share: '10%',
          median_hours: 1.5,
          p90_hours: 4,
          median_from_claim_hours: 0.75,
        },
        {
          priority: 'Normal',
          resolved: 61,
          share: '73%',
          median_hours: 6,
          p90_hours: 48,
          median_from_claim_hours: null,
        },
      ],
      channels: [
        { channel: 'Walk-in', count: 55, share: '60%' },
        { channel: 'Email', count: 36, share: '40%' },
      ],
      waiting: {
        tickets_waited: 15,
        share: '18%',
        median_wait_hours: 20.5,
        reasons: [{ reason: 'Waiting on a part', count: 9 }],
      },
      honours: [
        {
          title: HONOUR_TITLES.fastest_urgent,
          name: 'Dev Okafor',
          value: '2h 10m',
          detail: 'Median time from claim to resolved on urgent tickets, over at least three of them.',
        },
        {
          title: HONOUR_TITLES.most_hands,
          name: null,
          value: null,
          detail: 'Nobody joined a colleague’s ticket this month.',
        },
      ],
      me: DOCUMENT.people.me,
      hardest: [
        {
          number: 'EDT-1042',
          title: 'Projector will not wake',
          category: 'Projector or display',
          priority: 'High',
          hours: 96.5,
          from_claim_hours: 40,
          hands: 3,
          resolver_name: 'Dev Okafor',
          score: 15.2,
        },
        {
          category: 'Network or Wi-Fi',
          priority: 'Urgent',
          hours: 30,
          from_claim_hours: null,
          hands: 1,
          resolver_name: null,
          score: 13.7,
        },
      ],
    });
    expect(result.summary).toBe("Read the desk's analytics this month: 84 resolved, 91 opened.");
  });

  it('leaves the chart’s own detail and the ranking on the page', async () => {
    const { ctx } = context({ results: { app_analytics: DOCUMENT } });
    const result = await executeTool('desk_analytics', { period: 'month' }, ctx);
    const sent = JSON.stringify(result.result);
    // The hour-by-weekday matrix, the per-day bars and the per-person table,
    // none of which a model can do anything with.
    expect(sent).not.toContain('heat');
    expect(sent).not.toContain('2026-09-14');
    // Nor another resolver's row, which is the ranking the owner reserved for
    // administrators: it is on the page, under their own heading.
    expect(sent).not.toContain('acc-1');
    // The reader's own row is theirs, so it stays.
    expect((result.result as { me: { account_id: string } }).me.account_id).toBe('actor-1');
  });

  it('omits the number and title of a ticket this reader may not open', async () => {
    const { ctx } = context({ results: { app_analytics: DOCUMENT } });
    const result = await executeTool('desk_analytics', { period: 'month' }, ctx);
    const hardest = (result.result as { hardest: Record<string, unknown>[] }).hardest;
    expect(Object.hasOwn(hardest[0], 'number')).toBe(true);
    // Absent rather than null: a null title is a blank a model tries to fill.
    expect(Object.hasOwn(hardest[1], 'number')).toBe(false);
    expect(Object.hasOwn(hardest[1], 'title')).toBe(false);
    expect(hardest[1].hours).toBe(30);
  });

  it('answers an empty period without inventing numbers', async () => {
    const { ctx } = context({
      results: {
        app_analytics: {
          since: null,
          until: '2026-09-16T18:30:00+00:00',
          overview: { resolved: 0, created: 0, median_hours: null },
          throughput: [],
          arrivals: {},
          categories: [],
          priorities: [],
          channels: [],
          waiting: {},
          people: { honours: [], rows: [], me: null },
          hardest: [],
        },
      },
    });
    const result = await executeTool('desk_analytics', { period: 'week' }, ctx);
    expect(result.ok).toBe(true);
    const answer = result.result as Record<string, unknown>;
    expect(answer.throughput).toEqual({
      slices: 0,
      created: 0,
      resolved: 0,
      backlog_first: null,
      backlog_last: null,
    });
    expect(answer.arrivals).toEqual({ by_weekday: [], by_hour: [] });
    expect(answer.me).toBeNull();
    expect(answer.since).toBe(periodBounds('week').since);
    expect(result.summary).toBe("Read the desk's analytics this week: 0 resolved, 0 opened.");
  });

  it('is a read, so it never asks for approval', () => {
    expect(isWriteTool('desk_analytics')).toBe(false);
    expect(requiresApproval('desk_analytics', { period: 'month' }, true)).toBe(false);
    expect(READ_TOOLS).toContain('desk_analytics');
  });

  it('is offered to a NetRider and an administrator, and not to a skills officer', () => {
    expect(toolsFor(['netrider']).map((tool) => tool.name)).toContain('desk_analytics');
    expect(toolsFor(['admin']).map((tool) => tool.name)).toContain('desk_analytics');
    expect(toolsFor(['skills_officer']).map((tool) => tool.name)).not.toContain('desk_analytics');
  });

  it('refuses a skills officer at the executor as well, before any round trip', async () => {
    const { ctx, calls } = context({ roles: ['skills_officer'] });
    const result = await executeTool('desk_analytics', { period: 'month' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('This account works the directory, not tickets.');
    expect(calls).toEqual([]);
  });

  it('reads the database’s own refusal back as a refusal', async () => {
    const { ctx } = context({
      roles: ['netrider'],
      error: { code: '42501', message: 'Only somebody who works tickets can read the analytics.' },
    });
    const result = await executeTool('desk_analytics', { period: 'term' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('Only somebody who works tickets can read the analytics.');
    expect(result.result).toEqual({
      error: 'Only somebody who works tickets can read the analytics.',
    });
  });

  it('takes one of the four periods and nothing else', () => {
    expect(validateArgs('desk_analytics', { period: 'month' }).ok).toBe(true);
    expect(validateArgs('desk_analytics', { period: 'yesterday' }).ok).toBe(false);
    expect(validateArgs('desk_analytics', { since: '2026-09-01' }).ok).toBe(false);
    // The four the page offers, and the model is told which they are.
    const tool = toolsFor(['netrider']).find((offered) => offered.name === 'desk_analytics');
    expect(tool?.parameters.properties.period.enum).toEqual([...STATS_PERIODS, null]);
    expect(tool?.description).toContain('/analytics');
  });
});
