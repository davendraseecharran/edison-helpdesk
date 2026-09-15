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
  roles: ['netrider'] as const,
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
  /** The input items each round was sent, so the wire shape can be asserted. */
  sent: [] as Record<string, unknown>[][],
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
    streamResponses: async function* (request: { input: Record<string, unknown>[] }) {
      state.sent.push(request.input.map((item) => ({ ...item })));
      const events = state.events;
      state.events = [];
      for (const event of events) yield event;
    },
  };
});

const { POST } = await import('../../src/app/api/ai/chat/route');

function request(body: unknown) {
  // The route reads the body itself, bounded, rather than calling `json()`:
  // `bodySizeLimit` does not reach a route handler, so the size is decided
  // before anything is parsed. The stub therefore has to be a real stream.
  const text = JSON.stringify(body ?? null);
  const bytes = new TextEncoder().encode(text);
  return {
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
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
  state.sent = [];
});

/** A data URL of `bytes` decoded bytes, matching tests/ai/images.test.ts. */
const SIGNATURE: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

/**
 * A data URL of `bytes` decoded bytes, starting with that format's own first
 * bytes — the route checks the label against them, so a run of zeros would be
 * refused as a file wearing somebody else's name.
 */
function dataUrl(type: string, bytes: number): string {
  const head = SIGNATURE[type] ?? [];
  const buffer = Buffer.alloc(bytes);
  for (let index = 0; index < Math.min(head.length, bytes); index += 1) buffer[index] = head[index];
  return `data:${type};base64,${buffer.toString('base64')}`;
}

/** The parts of the last user message actually put on the wire. */
function sentUserParts(): Record<string, unknown>[] {
  const input = state.sent[0] ?? [];
  const user = [...input].reverse().find((item) => item.type === 'message' && item.role === 'user');
  return (user?.content as Record<string, unknown>[]) ?? [];
}

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

  it('refuses a message too long for one turn, before opening a conversation', async () => {
    const response = await POST(request({ message: 'x'.repeat(30_001) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'message_too_long' });
    expect(state.inserted).toEqual([]);
  });

  it('refuses a body larger than everything this endpoint can accept, before parsing it', async () => {
    // Declared, not sent: `serverActions.bodySizeLimit` does not reach a route
    // handler, so the header is the first place this can be refused. Nothing is
    // read, nothing is parsed, and no conversation is opened.
    const oversized = {
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
      body: null,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof POST>[0];
    const response = await POST(oversized);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'request_too_large' });
    expect(state.inserted).toEqual([]);
  });

  it('refuses a body that runs past the bound with no length declared', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
    const streamed = {
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        // Endless: the reader has to stop it, not the other way round.
        pull(controller) {
          controller.enqueue(chunk);
        },
      }),
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof POST>[0];
    const response = await POST(streamed);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'request_too_large' });
    expect(state.inserted).toEqual([]);
  });

  it('accepts a long message that is still within the cap', async () => {
    state.events = textTurn('Read it.');
    const response = await POST(request({ message: 'x'.repeat(30_000) }));
    expect(response.status).toBe(200);
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

  it('sends a picture as an input_image part in the SAME user message as the text', async () => {
    state.events = textTurn('That is a cracked panel.');
    const image = { dataUrl: dataUrl('image/jpeg', 900), name: 'crack.jpg' };
    const response = await POST(request({ message: 'what is this', images: [image] }));
    expect(response.status).toBe(200);
    await lines(response);

    expect(sentUserParts()).toEqual([
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
    ]);
  });

  it('takes a picture with no words at all', async () => {
    state.events = textTurn('A projector with no signal.');
    const image = { dataUrl: dataUrl('image/png', 120), name: 'screen.png' };
    const response = await POST(request({ images: [image] }));
    expect(response.status).toBe(200);
    await lines(response);
    expect(sentUserParts()).toEqual([{ type: 'input_image', image_url: image.dataUrl, detail: 'auto' }]);
  });

  it('keeps the names but not the bytes in the conversation row', async () => {
    state.events = textTurn('Noted.');
    const image = { dataUrl: dataUrl('image/webp', 400), name: 'label.webp' };
    await lines(await POST(request({ message: 'read this label', images: [image] })));

    const userRows = state.inserted.filter(
      (entry) => entry.table === 'ai_messages' && (entry.row as { role?: string }).role === 'user',
    );
    expect(userRows).toHaveLength(1);
    const stored = JSON.stringify(userRows[0].row);
    // The row constraint is 256 KiB; a picture is many times that, and a row
    // that cannot be written is a turn that is lost.
    expect(stored).not.toContain('base64');
    expect(stored).toContain('label.webp');
    expect(stored).toContain('not kept');
  });

  it('refuses a fifth picture, before opening a conversation', async () => {
    const image = { dataUrl: dataUrl('image/png', 60), name: 'a.png' };
    const response = await POST(request({ message: 'look', images: Array(5).fill(image) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'too_many_images' });
    expect(state.inserted).toEqual([]);
  });

  it('refuses a picture over four megabytes', async () => {
    const response = await POST(
      request({ message: 'look', images: [{ dataUrl: dataUrl('image/png', 4 * 1024 * 1024 + 1), name: 'a.png' }] }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'image_too_large' });
  });

  it('refuses a file that is not a picture the model reads', async () => {
    const response = await POST(
      request({ message: 'look', images: [{ dataUrl: dataUrl('application/pdf', 60), name: 'a.pdf' }] }),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: 'image_type' });
  });

  it('reports a model error and still closes the stream', async () => {
    state.events = [{ type: 'error', message: 'ChatGPT is rate limiting this account.' }];
    const events = await lines(await POST(request({ message: 'hello' })));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
