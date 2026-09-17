/**
 * The checker between `app_analytics` and the screen.
 *
 * `loadAnalytics` never casts the document; it reads every field and answers
 * null the moment one is not the shape the domain declares. These tests hand
 * it documents written by hand, so each rule is a case somebody could plausibly
 * "relax" into being wrong:
 *
 * 1. A COUNT IS A WHOLE NUMBER THAT ARRIVED AS A NUMBER. "3" is a count the
 *    database did not send, and 2.5 resolved tickets is not a count at all.
 * 2. THE GRIDS HAVE THEIR SIZE. Seven weekdays, twenty-four hours, one trend
 *    entry per throughput slice. A grid a day short is a chart drawn wrong.
 * 3. A STRANGER IN THE VOCABULARY IS DROPPED, NOT FATAL. A category or a
 *    priority the domain does not know cannot be drawn, but it should not
 *    take the whole screen with it.
 * 4. THE LOG NAMES THE PATH AND NOTHING ELSE. The document names people and
 *    tickets, so a failure says where it went wrong and never what it held.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `src/lib/data/analytics.ts` opens with `import 'server-only'`, which throws
// outside a React server component. The checker is pure; the guard is not the
// thing under test.
vi.mock('server-only', () => ({}));

const rpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc }),
}));

import { checkAnalytics, loadAnalytics } from '../src/lib/data/analytics';

/** Seven rows of twenty-four, every arrival at 9am on the first weekday. */
function heat(): number[][] {
  return Array.from({ length: 7 }, (_, weekday) =>
    Array.from({ length: 24 }, (_, hour) => (weekday === 0 && hour === 9 ? 8 : 0)),
  );
}

function person(name: string, accountId: string, resolved: number): Record<string, unknown> {
  return {
    account_id: accountId,
    name,
    resolved,
    median_hours: 1.5,
    median_from_claim_hours: 1.2,
    urgent_high: 3,
    hard_score: 2.41,
    joined: 0,
    reopened: 1,
  };
}

function honours(): Record<string, unknown>[] {
  return [
    {
      key: 'fastest_urgent',
      account_id: 'acc-dev',
      name: 'Dev Okafor',
      value: '30m',
      detail: 'Median time from taking an urgent or high ticket to resolving it, over 3 of them',
    },
    {
      key: 'hardest',
      account_id: 'acc-priya',
      name: 'Priya Raman',
      value: 'score 2.4',
      detail: 'Mean difficulty score over 7 resolutions: priority, time open, hands and reopens',
    },
    {
      key: 'most_hands',
      account_id: 'acc-dev',
      name: 'Dev Okafor',
      value: '1 ticket joined',
      detail: 'Tickets joined as a collaborator in this period',
    },
    {
      key: 'steadiest',
      account_id: null,
      name: null,
      value: null,
      detail: 'School days with at least one resolution; nobody has three in this period yet',
    },
  ];
}

/** A document exactly as `app_analytics` writes it, for a week read day by day. */
function document(): Record<string, unknown> {
  return {
    period_since: '2026-09-14T04:00:00+00:00',
    until: '2026-09-16T15:00:00+00:00',
    bucket: 'day',
    overview: {
      resolved: 11,
      resolved_previous: 4,
      created: 8,
      created_previous: 6,
      cancelled: 1,
      reopened: 1,
      median_hours: 2.5,
      median_hours_previous: 3,
      p90_hours: 30,
      same_day_share: 0.9091,
      school_days: 3,
      per_school_day: 3.67,
      per_week: 25.67,
      open_now: 3,
      unassigned_now: 2,
      waiting_now: 0,
      oldest_open_hours: 52.3,
    },
    throughput: [
      { key: '2026-09-14', created: 2, resolved: 1, backlog: 5 },
      { key: '2026-09-15', created: 0, resolved: 0, backlog: 5 },
      { key: '2026-09-16', created: 6, resolved: 10, backlog: 3 },
    ],
    arrivals: {
      by_weekday: [8, 0, 0, 0, 0, 0, 0],
      by_hour: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 8 : 0)),
      heat: heat(),
    },
    categories: [
      { category: 'account', resolved: 3, created: 0, share: 0.2727, median_hours: 0.5, trend: [0, 0, 3] },
      { category: 'chromebook', resolved: 2, created: 2, share: 0.1818, median_hours: 0.1, trend: [1, 0, 1] },
    ],
    priorities: [
      { priority: 'urgent', resolved: 3, share: 0.2727, median_hours: 0.5, p90_hours: 0.5, median_from_claim_hours: 0.5 },
      { priority: 'high', resolved: 3, share: 0.2727, median_hours: 5, p90_hours: 5, median_from_claim_hours: 5 },
      { priority: 'normal', resolved: 4, share: 0.3636, median_hours: 0.05, p90_hours: 0.1, median_from_claim_hours: 0.02 },
      { priority: 'low', resolved: 1, share: 0.0909, median_hours: 30, p90_hours: 30, median_from_claim_hours: 30 },
    ],
    channels: [
      { channel: 'walk_in', count: 0, share: 0 },
      { channel: 'email', count: 2, share: 0.25 },
      { channel: 'phone_call', count: 6, share: 0.75 },
    ],
    locations: [
      { location: 'Room 212', count: 5 },
      { location: 'Room 118', count: 2 },
    ],
    remote: 0,
    requesters: {
      staff: 1,
      student: 1,
      other: 6,
      repeat: [{ name: 'Synthetic Staff', kind: 'staff', count: 1 }],
    },
    waiting: {
      tickets_waited: 1,
      share: 0.0909,
      median_wait_hours: 0.02,
      reasons: [{ reason: 'Awaiting parts', count: 1 }],
    },
    people: {
      honours: honours(),
      rows: [person('Priya Raman', 'acc-priya', 7), person('Dev Okafor', 'acc-dev', 3)],
      me: person('Priya Raman', 'acc-priya', 7),
    },
    hardest: [
      {
        ticket_id: 'tk-1',
        number: 'EDT-1042',
        title: 'Podium laptop will not join the domain',
        category: 'laptop_desktop',
        priority: 'high',
        hours: 5,
        from_claim_hours: 5,
        resolver_name: 'Priya Raman',
        hands: 1,
        score: 5.38,
      },
      {
        ticket_id: 'tk-2',
        number: null,
        title: null,
        category: 'account',
        priority: 'urgent',
        hours: 0.5,
        from_claim_hours: 0.5,
        resolver_name: 'Dev Okafor',
        hands: 1,
        score: 1.62,
      },
    ],
  };
}

/** The document with one nested field replaced. */
function withField(path: string, value: unknown): Record<string, unknown> {
  const root = document();
  const segments = path.split('.');
  let cursor: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return root;
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  rpc.mockReset();
});

afterEach(() => {
  errors.mockRestore();
});

describe('checkAnalytics', () => {
  it('maps a well-formed document into the domain shape', () => {
    const analytics = checkAnalytics(document(), 'week', 'day');
    expect(analytics).not.toBeNull();
    if (!analytics) return;

    expect(analytics.period).toBe('week');
    expect(analytics.bucket).toBe('day');
    expect(analytics.since).toBe('2026-09-14T04:00:00+00:00');
    expect(analytics.until).toBe('2026-09-16T15:00:00+00:00');

    expect(analytics.overview.resolvedPrevious).toBe(4);
    expect(analytics.overview.sameDayShare).toBeCloseTo(0.9091, 4);
    expect(analytics.overview.oldestOpenHours).toBe(52.3);

    expect(analytics.throughput.map((point) => point.key)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
    ]);
    expect(analytics.arrivals.heat[0][9]).toBe(8);
    expect(analytics.categories[0]).toMatchObject({
      category: 'account',
      medianHours: 0.5,
      trend: [0, 0, 3],
    });
    expect(analytics.priorities.map((row) => row.priority)).toEqual([
      'urgent',
      'high',
      'normal',
      'low',
    ]);
    expect(analytics.priorities[1].medianFromClaimHours).toBe(5);
    expect(analytics.channels[2]).toEqual({ channel: 'phone_call', count: 6, share: 0.75 });
    expect(analytics.requesters.repeat[0]).toEqual({ name: 'Synthetic Staff', kind: 'staff', count: 1 });
    expect(analytics.waiting.ticketsWaited).toBe(1);
    expect(analytics.waiting.reasons[0].reason).toBe('Awaiting parts');

    expect(analytics.people.honours.map((honour) => honour.key)).toEqual([
      'fastest_urgent',
      'hardest',
      'most_hands',
      'steadiest',
    ]);
    expect(analytics.people.honours[0]).toMatchObject({ accountId: 'acc-dev', value: '30m' });
    expect(analytics.people.honours[3]).toMatchObject({ accountId: null, name: null, value: null });
    expect(analytics.people.rows[0]).toMatchObject({
      accountId: 'acc-priya',
      medianFromClaimHours: 1.2,
      urgentHigh: 3,
      hardScore: 2.41,
    });
    expect(analytics.people.me?.name).toBe('Priya Raman');

    expect(analytics.hardest[0]).toMatchObject({
      ticketId: 'tk-1',
      number: 'EDT-1042',
      fromClaimHours: 5,
      resolverName: 'Priya Raman',
    });
    // A ticket the reader may not open still counts; only its name is withheld.
    expect(analytics.hardest[1]).toMatchObject({ number: null, title: null, score: 1.62 });
    expect(errors).not.toHaveBeenCalled();
  });

  it('reads an open start as null and a null own row as nobody', () => {
    const root = withField('period_since', null);
    (root.people as Record<string, unknown>).me = null;
    const analytics = checkAnalytics(root, 'week', 'day');
    expect(analytics?.since).toBeNull();
    expect(analytics?.people.me).toBeNull();
  });

  it('reads a document with nothing in it', () => {
    const root = document();
    Object.assign(root, {
      throughput: [],
      categories: [],
      locations: [],
      hardest: [],
      waiting: { tickets_waited: 0, share: 0, median_wait_hours: null, reasons: [] },
    });
    (root.people as Record<string, unknown>).rows = [];
    const overview = root.overview as Record<string, unknown>;
    Object.assign(overview, {
      resolved: 0,
      median_hours: null,
      p90_hours: null,
      same_day_share: null,
      per_school_day: null,
      per_week: null,
      oldest_open_hours: null,
    });
    const analytics = checkAnalytics(root, 'month', 'day');
    expect(analytics?.overview.medianHours).toBeNull();
    expect(analytics?.categories).toEqual([]);
    expect(analytics?.waiting.medianWaitHours).toBeNull();
  });

  it.each([
    ['a count written as text', 'overview.resolved', '3'],
    ['a count with a fraction', 'overview.created', 2.5],
    ['a negative count', 'overview.cancelled', -1],
    ['a share above one', 'overview.same_day_share', 1.2],
    ['negative hours', 'overview.median_hours', -2],
    ['an until that is not an instant', 'until', 'yesterday'],
    ['a missing section', 'requesters', undefined],
    ['a weekday grid a day short', 'arrivals.by_weekday', [1, 2, 3, 4, 5, 6]],
    ['an hour grid a column long', 'arrivals.by_hour', Array.from({ length: 25 }, () => 0)],
    ['a trend that does not match the series', 'categories', [
      { category: 'account', resolved: 3, created: 0, share: 0.27, median_hours: 0.5, trend: [0, 3] },
    ]],
    ['a day key under a day bucket that is a month', 'throughput', [
      { key: '2026-09', created: 2, resolved: 1, backlog: 5 },
    ]],
    ['a repeat requester of an unknown kind', 'requesters.repeat', [
      { name: 'Somebody', kind: 'parent', count: 2 },
    ]],
    ['a hard ticket with negative hours', 'hardest', [
      { ticket_id: 'tk-9', number: null, title: null, category: 'other', priority: 'low', hours: -1, from_claim_hours: null, resolver_name: null, hands: 1, score: 0 },
    ]],
  ])('answers null for %s', (_label, path, value) => {
    expect(checkAnalytics(withField(path, value), 'week', 'day')).toBeNull();
  });

  it('answers null when a heat row is the wrong width', () => {
    const grid = heat();
    grid[3] = grid[3].slice(0, 23);
    expect(checkAnalytics(withField('arrivals.heat', grid), 'week', 'day')).toBeNull();
  });

  it('requires all four honours, in their declared order, each whole or empty', () => {
    const three = honours().slice(0, 3);
    expect(checkAnalytics(withField('people.honours', three), 'week', 'day')).toBeNull();

    const halfNamed = honours();
    halfNamed[0] = { ...halfNamed[0], value: null };
    expect(checkAnalytics(withField('people.honours', halfNamed), 'week', 'day')).toBeNull();

    // Order in the document does not matter; the keys do.
    const shuffled = honours().reverse();
    const analytics = checkAnalytics(withField('people.honours', shuffled), 'week', 'day');
    expect(analytics?.people.honours.map((honour) => honour.key)).toEqual([
      'fastest_urgent',
      'hardest',
      'most_hands',
      'steadiest',
    ]);
  });

  it('accepts a month key under a month bucket', () => {
    const root = withField('throughput', [{ key: '2026-09', created: 2, resolved: 1, backlog: 5 }]);
    const categories = root.categories as Array<Record<string, unknown>>;
    for (const row of categories) row.trend = [1];
    expect(checkAnalytics(root, 'all', 'month')?.throughput[0].key).toBe('2026-09');
  });

  it('drops a category, priority, channel or hard ticket the vocabulary does not know', () => {
    const root = document();
    (root.categories as unknown[]).push({
      category: 'hovercraft',
      resolved: 1,
      created: 1,
      share: 0.1,
      median_hours: 1,
      trend: [0, 0, 1],
    });
    (root.priorities as unknown[]).push({
      priority: 'critical',
      resolved: 1,
      share: 0.1,
      median_hours: 1,
      p90_hours: 1,
      median_from_claim_hours: 1,
    });
    (root.channels as unknown[]).push({ channel: 'carrier_pigeon', count: 1, share: 0.1 });
    (root.hardest as unknown[]).push({
      ticket_id: 'tk-3',
      number: null,
      title: null,
      category: 'hovercraft',
      priority: 'high',
      hours: 1,
      from_claim_hours: 1,
      resolver_name: null,
      hands: 1,
      score: 2,
    });

    const analytics = checkAnalytics(root, 'week', 'day');
    expect(analytics?.categories.map((row) => row.category)).toEqual(['account', 'chromebook']);
    expect(analytics?.priorities).toHaveLength(4);
    expect(analytics?.channels).toHaveLength(3);
    expect(analytics?.hardest.map((row) => row.ticketId)).toEqual(['tk-1', 'tk-2']);
  });

  it('logs the path of the fault and never the document', () => {
    expect(checkAnalytics(withField('people.rows', [person('Priya Raman', 'acc-priya', -1)]), 'week', 'day')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0][0]);
    expect(line).toContain('malformed at people.rows[0].resolved');
    expect(line).not.toContain('Priya');
    expect(line).not.toContain('acc-priya');
  });
});

describe('loadAnalytics', () => {
  it('asks for the period’s bounds and bucket, and hands back the checked document', async () => {
    rpc.mockResolvedValue({ data: document(), error: null });
    const analytics = await loadAnalytics('week');

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('app_analytics');
    expect(args.p_bucket).toBe('day');
    expect(typeof args.p_since).toBe('string');
    expect(args.p_until).toBeNull();
    expect(analytics?.period).toBe('week');
    expect(analytics?.overview.resolved).toBe(11);
  });

  it('reads all time month by month with no lower bound', async () => {
    const root = withField('throughput', [{ key: '2026-09', created: 2, resolved: 1, backlog: 5 }]);
    for (const row of root.categories as Array<Record<string, unknown>>) row.trend = [1];
    rpc.mockResolvedValue({ data: root, error: null });
    const analytics = await loadAnalytics('all');

    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).toEqual({ p_since: null, p_until: null, p_bucket: 'month' });
    expect(analytics?.bucket).toBe('month');
  });

  it('answers null on a refusal, and logs the code rather than the message', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Only somebody who works tickets can read the desk’s analytics.' },
    });
    expect(await loadAnalytics('month')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('42501');
    expect(String(errors.mock.calls[0][0])).not.toContain('works tickets');
  });

  it('answers null when the call itself throws', async () => {
    rpc.mockRejectedValue(new TypeError('fetch failed'));
    expect(await loadAnalytics('term')).toBeNull();
    expect(String(errors.mock.calls[0][0])).toContain('TypeError');
  });
});
