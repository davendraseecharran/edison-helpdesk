/**
 * The chat turn, with every edge of it stubbed.
 *
 * Nothing real is reached: no Supabase, no ChatGPT, no cookies. What is being
 * checked is the DECISION MAKING in the route — when it asks before changing
 * something, what it puts on the wire and in what order — because those are the
 * parts a type checker cannot see and a live test could not reach without a
 * ChatGPT account.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponsesEvent } from '../../src/lib/ai/responses-client';

vi.mock('server-only', () => ({}));

const account = {
  id: 'acc-1',
  displayName: 'Pat Example',
  email: 'pat@edison.example',
  role: 'technician' as const,
  status: 'active' as const,
  credentialActionPending: false,
  sessionIsCurrent: true,
};

/** What the stubs are told to do for one test. */
const state = {
  enabled: true,
  connected: true as boolean,
  preferencesError: null as { message: string } | null,
  confirmChanges: false,
  events: [] as ResponsesEvent[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  inserted: [] as { table: string; row: unknown }[],
};

/**
 * A Supabase query builder that answers rather than queries. Every method
 * returns the chain, and awaiting it resolves whatever the table is set up to
 * give back, which is enough for the four shapes this route uses.
 */
function builder(table: string, result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select',
    'update',
    'delete',
    'eq',
    'in',
    'order',
    'range',
    'limit',
    'single',
    'maybeSingle',
  ]) {
    chain[method] = () => chain;
  }
  chain.insert = (row: unknown) => {
    state.inserted.push({ table, row });
    return chain;
  };
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function fakeClient() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'app_my_preferences') {
        return Promise.resolve({
          data: state.preferencesError
            ? null
            : { ai_reasoning: 'high', ai_confirm_changes: state.confirmChanges },
          error: state.preferencesError,
        });
      }
      if (fn === 'app_search') {
        // What resolveTicket reads: `title` is "<number> <title>".
        return Promise.resolve({
          data: [
            {
              kind: 'ticket',
              id: 'ticket-1',
              title: 'EDT-1042 Projector will not wake',
              subtitle: 'Sam Rivera',
              meta: 'open',
              rank: 1,
            },
          ],
          error: null,
        });
      }
      if (fn === 'app_ticket_detail') {
        return Promise.resolve({
          data: { ticket: { number: 'EDT-1042', title: 'Projector will not wake' } },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) =>
      builder(
        table,
        table === 'ai_conversations'
          ? { data: { id: 'conv-1' }, error: null }
          : { data: [], error: null },
      ),
  };
}

vi.mock('../../src/lib/auth/session', () => ({
  activeAccount: () => Promise.resolve(account),
}));

vi.mock('../../src/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeClient()),
  createClientWithHeaders: () => Promise.resolve(fakeClient()),
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

vi.mock('../../src/lib/ai/responses-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/ai/responses-client')>();
  return {
    ...actual,
    // One scripted turn, then nothing: the route stops when a round produces no
    // tool call, so the second round ends the loop on its own.
    streamResponses: async function* () {
      const events = state.events;
      state.events = [];
      for (const event of events) yield event;
    },
  };
});

const { POST } = await import('../../src/app/api/ai/chat/route');

function request(body: unknown) {
  return {
    json: () => Promise.resolve(body),
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof POST>[0];
}

async function lines(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function textTurn(text: string): ResponsesEvent[] {
  return [
    { type: 'output_item', item: { type: 'message', role: 'assistant', content: [] } },
    { type: 'text_delta', text },
    { type: 'done', responseId: 'resp_1' },
  ];
}

function claimTurn(): ResponsesEvent[] {
  const item = {
    type: 'function_call',
    call_id: 'call_1',
    name: 'claim_ticket',
    arguments: JSON.stringify({ ticket: 'EDT-1042' }),
  };
  return [
    { type: 'output_item', item },
    { type: 'function_call', callId: 'call_1', name: 'claim_ticket', args: item.arguments },
    { type: 'done', responseId: 'resp_1' },
  ];
}

beforeEach(() => {
  state.enabled = true;
  state.connected = true;
  state.preferencesError = null;
  state.confirmChanges = false;
  state.events = [];
  state.rpcCalls = [];
  state.inserted = [];
});

describe('POST /api/ai/chat', () => {
  it('refuses with 503 when the server has no AI_TOKEN_KEY', async () => {
    state.enabled = false;
    const response = await POST(request({ message: 'hello' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_disabled' });
  });

  it('refuses with 409 when no ChatGPT account is linked', async () => {
    state.connected = false;
    const response = await POST(request({ message: 'hello' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'not_connected' });
  });

  it('refuses an empty request', async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
  });

  it('streams the conversation id, the reply and done', async () => {
    state.events = textTurn('Claimed it.');
    const events = await lines(await POST(request({ message: 'what is open?' })));

    expect(events[0]).toEqual({ type: 'conversation', id: 'conv-1' });
    expect(events.some((event) => event.type === 'delta' && event.text === 'Claimed it.')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('runs a write immediately when the person has not asked to be consulted', async () => {
    state.confirmChanges = false;
    state.events = claimTurn();
    const events = await lines(await POST(request({ message: 'claim EDT-1042' })));

    const call = events.find((event) => event.type === 'tool_call');
    expect(call).toMatchObject({ name: 'claim_ticket', needsApproval: false });
    // The number was resolved to an id before the change was made, rather than
    // a hallucinated uuid being sent straight to the database.
    expect(state.rpcCalls.map((entry) => entry.fn)).toContain('app_search');
    expect(state.rpcCalls.find((entry) => entry.fn === 'app_claim_ticket')?.args).toEqual({
      p_ticket: 'ticket-1',
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      ok: true,
      summary: 'Claimed EDT-1042',
    });
  });

  it('stops at a write and asks when the person has asked to be consulted', async () => {
    state.confirmChanges = true;
    state.events = claimTurn();
    const events = await lines(await POST(request({ message: 'claim EDT-1042' })));

    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      name: 'claim_ticket',
      needsApproval: true,
      summary: 'Claim ticket (ticket: EDT-1042)',
    });
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);
    expect(state.rpcCalls.map((entry) => entry.fn)).not.toContain('app_claim_ticket');
    // The pending call is stored, so the next request can answer it.
    expect(
      state.inserted.some(
        (entry) =>
          entry.table === 'ai_messages' &&
          (entry.row as { content?: { pending?: boolean } }).content?.pending === true,
      ),
    ).toBe(true);
  });

  it('asks before a change when the settings could not be read', async () => {
    // Fails CLOSED: a settings read that errors must not silently turn
    // confirmations off for somebody who had turned them on.
    state.preferencesError = { message: 'connection reset' };
    state.events = claimTurn();
    const events = await lines(await POST(request({ message: 'claim EDT-1042' })));

    const warning = events.find((event) => event.type === 'error');
    expect(String(warning?.message)).toMatch(/settings.*approval this turn/i);
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ needsApproval: true });
    expect(state.rpcCalls.map((entry) => entry.fn)).not.toContain('app_claim_ticket');
  });

  it('never leaks a driver message into a refusal', async () => {
    state.preferencesError = { message: 'relation "account_preferences" does not exist' };
    state.events = textTurn('ok');
    const events = await lines(await POST(request({ message: 'hello' })));
    expect(JSON.stringify(events)).not.toContain('relation');
  });

  it('stores one row per batch, so replay keeps its order', async () => {
    state.events = [
      { type: 'output_item', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' } },
      { type: 'output_item', item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'text_delta', text: 'done' },
      { type: 'done', responseId: 'resp_1' },
    ];
    await lines(await POST(request({ message: 'hello' })));

    const assistantRows = state.inserted.filter(
      (entry) => entry.table === 'ai_messages' && (entry.row as { role?: string }).role === 'assistant',
    );
    expect(assistantRows).toHaveLength(1);
    const content = (assistantRows[0].row as { content: { type: string }[] }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.map((item) => item.type)).toEqual(['reasoning', 'message']);
  });

  it('reports a model error and still closes the stream', async () => {
    state.events = [{ type: 'error', message: 'ChatGPT is rate limiting this account.' }];
    const events = await lines(await POST(request({ message: 'hello' })));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
