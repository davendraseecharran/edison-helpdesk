/**
 * The streaming call to ChatGPT's Codex backend, in Responses API shape.
 *
 * Endpoint, headers and body were read from openai/codex at commit
 * 36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564 (main, 2026-09-13):
 *
 *   codex-rs/model-provider-info/src/lib.rs:43
 *     CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
 *   codex-rs/model-provider/src/bearer_auth_provider.rs
 *     Authorization: Bearer <access token>;  ChatGPT-Account-ID: <account id>
 *   codex-rs/login/src/auth/default_client.rs:40,337
 *     originator: codex_cli_rs, plus a matching User-Agent
 *   codex-rs/codex-api/src/requests/headers.rs
 *     session-id / thread-id
 *   codex-rs/codex-api/src/endpoint/responses.rs:176
 *     accept: text/event-stream
 *   codex-rs/core/src/client.rs:~880
 *     body: model, instructions, input, tools, tool_choice "auto",
 *     parallel_tool_calls, reasoning, store:false, stream:true,
 *     include ["reasoning.encrypted_content"]
 *
 * Two deliberate differences from that commit, both additive:
 *   * `OpenAI-Beta: responses=experimental` is still sent. Current Codex only
 *     sets an OpenAI-Beta value on its websocket transport, but the spec for
 *     this feature pins the header and the HTTP endpoint has always tolerated
 *     it.
 *   * `session_id` is sent alongside `session-id`. The CLI has used both
 *     spellings across releases and an unread header costs nothing.
 *
 * This endpoint is undocumented. It is what the Codex CLI uses with a personal
 * ChatGPT account, and it is tolerated rather than guaranteed: it can change
 * without notice, and the feature is therefore gated behind AI_TOKEN_KEY.
 */

import { isRecord, textOf } from '@/lib/guards';
import type { CodexTokens } from './codex-auth';
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from './codex-auth';
import type { ToolDef } from './tools';

/** The one model this product offers. Never rendered from user input. */
export const AI_MODEL = 'gpt-5.6-luna';
export const AI_MODEL_LABEL = 'GPT-5.6 Luna';

export const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_LEVELS: readonly Reasoning[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * The level to fall back to when the service refuses the one that was asked
 * for.
 *
 * The effort vocabulary belongs to the provider and moves without warning, so a
 * level this deployment offers can be a level the API has never heard of. One
 * retry at `high` is better than an error: the person asked a question, and
 * "that model does not take that effort" is not an answer to it.
 */
export const REASONING_FALLBACK: Reasoning = 'high';

/**
 * The efforts the Responses API itself takes.
 *
 * `max` is this product's word, not the provider's. Nobody at the desk wants to
 * choose between `xhigh` and a token budget, so the setting says Max and this
 * module is the one place that knows what Max costs.
 */
export type ApiEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * The largest output this client ever asks for, in tokens.
 *
 * It is a ceiling, not a reservation: the service stops when the answer is
 * finished, and a request that never approaches this number costs nothing
 * extra. Max exists for the one turn a month that is genuinely long — a
 * migration walked through, twenty tickets summarised — and a ceiling lower
 * than the model's own is the only way that turn gets cut off mid-sentence.
 */
export const MAX_OUTPUT_TOKENS = 128_000;

/** What one stored level asks the API for. */
export interface EffortRequest {
  effort: ApiEffort;
  /** `detailed` only where the person asked for the model's full working. */
  summary: 'auto' | 'detailed';
  /** Sent only when this level raises the ceiling; otherwise the service decides. */
  maxOutputTokens?: number;
}

/**
 * The stored reasoning level as the API takes it.
 *
 * Three of these are offered in the panel. High and Extra high are the
 * provider's own efforts passed through. Max is not an effort the API has ever
 * accepted: it is `xhigh` with the ceiling lifted and the reasoning summary set
 * to `detailed`, which is what "the most the model gives" actually means. Send
 * the word `max` and the request is refused, which is how this was wrong.
 */
export function effortFor(level: Reasoning): EffortRequest {
  if (level === 'max') {
    return { effort: 'xhigh', summary: 'detailed', maxOutputTokens: MAX_OUTPUT_TOKENS };
  }
  return { effort: level, summary: 'auto' };
}

/**
 * The level to retry at after the service refused this one, or null when there
 * is nothing left to try.
 *
 * Always `high`, and never `max`: `max` is a word this application invented, so
 * retrying with it would send the same `xhigh` that was just refused. A level
 * that already resolves to `high` has had its one retry by definition.
 */
export function fallbackFor(level: Reasoning): Reasoning | null {
  return effortFor(level).effort === REASONING_FALLBACK ? null : REASONING_FALLBACK;
}

/** Whether an error from the service is about the reasoning effort specifically. */
export function isEffortRejection(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('effort') || text.includes('reasoning');
}

export function isReasoning(value: unknown): value is Reasoning {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** A Responses API input item. Stored as sent, so it stays opaque here. */
export type InputItem = Record<string, unknown>;

export type ResponsesEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'function_call'; callId: string; name: string; args: string }
  /**
   * Every completed output item, verbatim. The route stores these as the
   * assistant's turn, which is how reasoning.encrypted_content and the exact
   * function_call item survive into the next request — rebuilding them from the
   * deltas would drop both.
   */
  | { type: 'output_item'; item: Record<string, unknown> }
  | { type: 'done'; responseId: string | null }
  | { type: 'error'; message: string };

export interface SseState {
  /** Bytes seen but not yet ending a frame. */
  buffer: string;
}

export function newSseState(): SseState {
  return { buffer: '' };
}

export interface StreamRequest {
  tokens: CodexTokens;
  chatgptAccountId: string;
  instructions: string;
  input: InputItem[];
  tools: ToolDef[];
  reasoning: Reasoning;
  /** Stable for one conversation, so the service can keep cache affinity. */
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * Turns one decoded SSE frame into the events the caller cares about.
 *
 * Anything not listed is dropped rather than surfaced: the stream carries a
 * dozen bookkeeping events (`response.created`, `.in_progress`, part added and
 * done, argument deltas) whose content is already covered by the item that
 * follows them, and forwarding them would only duplicate text on screen.
 */
function eventsFromFrame(payload: unknown): ResponsesEvent[] {
  if (!isRecord(payload)) return [];
  const kind = textOf(payload.type);

  switch (kind) {
    case 'response.output_text.delta': {
      const text = textOf(payload.delta);
      return text === '' ? [] : [{ type: 'text_delta', text }];
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const text = textOf(payload.delta);
      return text === '' ? [] : [{ type: 'reasoning_delta', text }];
    }
    case 'response.output_item.done': {
      if (!isRecord(payload.item)) return [];
      const item = payload.item;
      const events: ResponsesEvent[] = [{ type: 'output_item', item }];
      if (textOf(item.type) === 'function_call') {
        events.push({
          type: 'function_call',
          callId: textOf(item.call_id) || textOf(item.id),
          name: textOf(item.name),
          args: textOf(item.arguments),
        });
      }
      return events;
    }
    case 'response.completed': {
      const response = isRecord(payload.response) ? payload.response : {};
      const id = textOf(response.id);
      return [{ type: 'done', responseId: id === '' ? null : id }];
    }
    case 'response.failed':
    case 'response.incomplete': {
      const response = isRecord(payload.response) ? payload.response : {};
      const detail = isRecord(response.error)
        ? textOf(response.error.message)
        : isRecord(response.incomplete_details)
          ? textOf(response.incomplete_details.reason)
          : '';
      return [{ type: 'error', message: detail || 'The model stopped before it finished.' }];
    }
    case 'error': {
      const nested = isRecord(payload.error) ? textOf(payload.error.message) : '';
      return [{ type: 'error', message: nested || textOf(payload.message) || 'The model reported an error.' }];
    }
    default:
      return [];
  }
}

/**
 * Pure SSE reader.
 *
 * `state.buffer` is what makes this safe against a chunk that ends mid-frame or
 * mid-character-sequence: nothing is parsed until a blank line has been seen, so
 * a JSON object split across two network reads is reassembled rather than
 * thrown away. Both `\n\n` and `\r\n\r\n` end a frame, a `data:` payload spread
 * over several lines is joined with newlines as the SSE specification requires,
 * and `[DONE]`, comments and keepalives produce nothing.
 */
export function parseSse(chunk: string, state: SseState): ResponsesEvent[] {
  state.buffer += chunk;
  const events: ResponsesEvent[] = [];

  // Normalising line endings first means one split pattern rather than three.
  state.buffer = state.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let index = state.buffer.indexOf('\n\n');
  while (index !== -1) {
    const frame = state.buffer.slice(0, index);
    state.buffer = state.buffer.slice(index + 2);

    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      // One optional space after the colon, per the SSE specification.
      data.push(line.slice(5).replace(/^ /, ''));
    }

    const payload = data.join('\n');
    if (payload !== '' && payload !== '[DONE]') {
      try {
        events.push(...eventsFromFrame(JSON.parse(payload)));
      } catch {
        // A frame that is not JSON is skipped. Failing the whole turn over one
        // malformed keepalive would lose everything already streamed.
      }
    }

    index = state.buffer.indexOf('\n\n');
  }

  return events;
}

function requestHeaders(request: StreamRequest): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.tokens.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
    session_id: request.sessionId,
    'session-id': request.sessionId,
  };
  if (request.chatgptAccountId !== '') {
    headers['chatgpt-account-id'] = request.chatgptAccountId;
  }
  return headers;
}

function requestBody(request: StreamRequest): string {
  const asked = effortFor(request.reasoning);
  return JSON.stringify({
    model: AI_MODEL,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    tool_choice: 'auto',
    // One tool at a time. Approval is per call, and a parallel batch would ask
    // the operator to approve changes that were decided together.
    parallel_tool_calls: false,
    reasoning: { effort: asked.effort, summary: asked.summary },
    // Absent unless the level raises it: an omitted ceiling is the service's
    // own, and sending `undefined` would serialise as a missing key anyway.
    ...(asked.maxOutputTokens === undefined ? {} : { max_output_tokens: asked.maxOutputTokens }),
    // Nothing is retained by the service; the conversation lives in this
    // application's own tables, under the technician's own row-level security.
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  });
}

/** What a refused request should say, without leaking a token or a stack. */
function failureMessage(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'ChatGPT refused the connection. Disconnect and connect the account again.';
  }
  if (status === 429) return 'ChatGPT is rate limiting this account. Wait a moment and try again.';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail = isRecord(parsed.error) ? parsed.error.message : parsed.message;
    if (typeof detail === 'string' && detail.trim() !== '') return detail.trim();
  } catch {
    // Not JSON; fall through.
  }
  return `ChatGPT answered with status ${status}.`;
}

export async function* streamResponses(request: StreamRequest): AsyncGenerator<ResponsesEvent> {
  /*
   * One retry, and only for the reasoning effort.
   *
   * The effort vocabulary belongs to the provider and moves without warning, so
   * a level this deployment offers can be one the API has never heard of. When
   * the refusal names the effort, the same request goes again at `high` — the
   * person asked a question, and "that model does not take that effort" is not
   * an answer to it. Anything else fails as it always did: a retry that does
   * not know why it is retrying is how one bad request becomes two.
   */
  let attempt: StreamRequest = request;
  let response: Response;

  for (;;) {
    try {
      response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: requestHeaders(attempt),
        body: requestBody(attempt),
        signal: attempt.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (attempt.signal?.aborted) return;
      const detail = error instanceof Error ? error.message : 'the request could not be sent';
      yield { type: 'error', message: `Could not reach ChatGPT: ${detail}.` };
      return;
    }

    if (response.ok && response.body !== null) break;

    let body = '';
    try {
      body = await response.text();
    } catch {
      // Nothing readable; the status is the whole message.
    }
    const message = failureMessage(response.status, body);
    const retryAt = fallbackFor(attempt.reasoning);
    if (response.status === 400 && retryAt !== null && isEffortRejection(message)) {
      attempt = { ...attempt, reasoning: retryAt };
      continue;
    }
    yield { type: 'error', message };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = newSseState();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across two reads whole.
      for (const event of parseSse(decoder.decode(value, { stream: true }), state)) {
        yield event;
      }
    }
    for (const event of parseSse(decoder.decode(), state)) yield event;
  } catch (error) {
    if (request.signal?.aborted) return;
    const detail = error instanceof Error ? error.message : 'the stream ended unexpectedly';
    yield { type: 'error', message: `The reply was interrupted: ${detail}.` };
  } finally {
    // Releasing the lock lets the connection be torn down when the caller stops
    // reading early, which is what happens on every client disconnect.
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
}
