/**
 * The server action's decisions, with the world stubbed the way
 * `tests/ai/route.test.ts` stubs it for the chat route: who is signed in,
 * whether they connected an account, what the settings row holds, and what
 * the model streams back. The pure checks live in `today-line.test.ts`; this
 * file is about when the action asks, what it stores, and when it stays quiet.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponsesEvent } from '../../src/lib/ai/responses-client';
import { todayFacts, todayLineHash } from '../../src/lib/ai/today-line';
import { EMPTY_BRIEFING, type Briefing, type BriefingTicket } from '../../src/lib/domain/today';

vi.mock('server-only', () => ({}));

function ticket(id: string, title: string): BriefingTicket {
  return {
    id,
    number: id.toUpperCase(),
    title,
    priority: 'high',
    status: 'open',
    waitingReason: null,
    createdAt: '2026-09-15T08:00:00Z',
    since: '2026-09-15T08:00:00Z',
    requesterName: null,
  };
}

function briefing(): Briefing & { ok: boolean } {
  return {
    ...EMPTY_BRIEFING,
    ok: true,
    at: '2026-09-15T09:00:00Z',
    counts: { ...EMPTY_BRIEFING.counts, unassigned: 2 },
    unassigned: [
      ticket('t1', 'Projector will not show the laptop'),
      ticket('t2', 'Projector will not show the laptop'),
    ],
  };
}

const state = {
  enabled: true,
  connected: true,
  briefing: briefing(),
  briefingReads: 0,
  prefs: null as Record<string, unknown> | null,
  events: [] as ResponsesEvent[],
  calls: 0,
  saved: [] as { p_line: string; p_hash: string }[],
};

vi.mock('../../src/lib/auth/session', () => ({
  activeAccount: () => Promise.resolve({ id: 'acct-1' }),
}));

vi.mock('../../src/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => {
        if (name === 'app_my_preferences') return Promise.resolve({ data: state.prefs, error: null });
        if (name === 'app_set_today_line') {
          state.saved.push(args as { p_line: string; p_hash: string });
          return Promise.resolve({ data: {}, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
}));

vi.mock('../../src/lib/ai/crypto', () => ({
  aiEnabled: () => state.enabled,
}));

vi.mock('../../src/lib/ai/connections', () => ({
  loadConnection: () =>
    Promise.resolve(
      state.connected
        ? {
            tokens: {
              accessToken: 'a',
              refreshToken: 'r',
              idToken: 'i',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
            chatgptAccountId: 'chatgpt-1',
          }
        : null,
    ),
  touchUsed: () => Promise.resolve(),
}));

vi.mock('../../src/lib/data/today', () => ({
  loadTodayBriefing: () => {
    state.briefingReads += 1;
    return Promise.resolve(state.briefing);
  },
}));

vi.mock('../../src/lib/ai/responses-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/ai/responses-client')>();
  return {
    ...actual,
    streamResponses: async function* () {
      state.calls += 1;
      for (const event of state.events) yield event;
    },
  };
});

const { todayLineAction } = await import('../../src/lib/ai/today-line-actions');

const HASH = todayLineHash(todayFacts(briefing()));
const SENTENCE = 'Two projector tickets look like one fault.';
const whole: ResponsesEvent[] = [
  { type: 'text_delta', text: 'Two projector tickets ' },
  { type: 'text_delta', text: 'look like one fault.' },
  { type: 'done', responseId: 'r1' },
];

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  state.enabled = true;
  state.connected = true;
  state.briefing = briefing();
  state.briefingReads = 0;
  state.prefs = null;
  state.events = [];
  state.calls = 0;
  state.saved = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('when it asks', () => {
  it('says nothing, and reads nothing, for a reader who has not connected an account', async () => {
    state.connected = false;
    expect(await todayLineAction()).toEqual({ line: null });
    expect(state.briefingReads).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('says nothing when the assistant is off or the queue is empty', async () => {
    state.enabled = false;
    expect(await todayLineAction()).toEqual({ line: null });
    state.enabled = true;
    state.briefing = { ...briefing(), counts: { ...EMPTY_BRIEFING.counts }, unassigned: [] };
    expect(await todayLineAction()).toEqual({ line: null });
    expect(state.calls).toBe(0);
  });

  it('reuses a fresh line written from this queue without asking', async () => {
    state.prefs = { today_line: { line: SENTENCE, hash: HASH, generated_at: minutesAgo(1) } };
    expect(await todayLineAction()).toEqual({ line: SENTENCE });
    expect(state.calls).toBe(0);
    expect(state.saved).toEqual([]);
  });

  it('asks once the stored line is about a different queue', async () => {
    state.prefs = { today_line: { line: SENTENCE, hash: 'stale', generated_at: minutesAgo(1) } };
    state.events = whole;
    expect(await todayLineAction()).toEqual({ line: SENTENCE });
    expect(state.calls).toBe(1);
  });
});

describe('what it keeps', () => {
  it('takes a whole sentence and stores it under the fingerprint of the queue', async () => {
    state.events = whole;
    expect(await todayLineAction()).toEqual({ line: SENTENCE });
    expect(state.saved).toEqual([{ p_line: SENTENCE, p_hash: HASH }]);
  });

  it('keeps the library line when the stream stops before it is done, and remembers that', async () => {
    // No `done`: the deadline fired, or the server closed the stream early.
    state.events = whole.slice(0, 2);
    expect(await todayLineAction()).toEqual({ line: null });
    expect(state.saved).toEqual([{ p_line: '', p_hash: HASH }]);
  });

  it('keeps the library line when the model reports an error or writes a bad line', async () => {
    state.events = [{ type: 'text_delta', text: 'Two' }, { type: 'error', message: 'stopped' }];
    expect(await todayLineAction()).toEqual({ line: null });
    state.events = [{ type: 'text_delta', text: 'Look at this queue!' }, { type: 'done', responseId: 'r2' }];
    expect(await todayLineAction()).toEqual({ line: null });
    expect(state.saved).toEqual([
      { p_line: '', p_hash: HASH },
      { p_line: '', p_hash: HASH },
    ]);
  });

  it('does not ask again within two minutes of an empty answer', async () => {
    state.prefs = { today_line: { line: '', hash: HASH, generated_at: minutesAgo(1) } };
    state.events = whole;
    expect(await todayLineAction()).toEqual({ line: null });
    expect(state.calls).toBe(0);
    expect(state.saved).toEqual([]);
  });

  it('asks again once the empty mark is older than two minutes', async () => {
    state.prefs = { today_line: { line: '', hash: HASH, generated_at: minutesAgo(3) } };
    state.events = whole;
    expect(await todayLineAction()).toEqual({ line: SENTENCE });
    expect(state.calls).toBe(1);
  });
});
