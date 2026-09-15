/**
 * The assistant's chat turn.
 *
 * A route handler rather than a server action because the answer is a STREAM:
 * the panel shows reasoning, then text, then what each tool did, as they happen.
 * Server actions return once.
 *
 * The wire format is newline-delimited JSON — one object per line, each with a
 * `type` — rather than SSE, because the client reads it with `fetch` and a
 * reader rather than with `EventSource`, and NDJSON survives a proxy that would
 * buffer `text/event-stream`.
 *
 *   {type:'conversation', id}
 *   {type:'phase', phase:'thinking'|'writing'|'tool'}
 *   {type:'reasoning', text}   the reasoning summary, streamed
 *   {type:'delta', text}       the reply, streamed
 *   {type:'tool_call', callId, name, args, summary, needsApproval}
 *   {type:'tool_result', callId, ok, summary}
 *   {type:'done'}
 *   {type:'error', message}
 *
 * Three things are decided here and nowhere else:
 *
 *   1. WHO. `activeAccount()` re-derives the actor from the session on every
 *      request. The tool client is that person's own cookie-bound client with
 *      the attribution headers added, so every RPC a tool calls is subject to
 *      exactly the row-level security a click would be.
 *   2. WHETHER TO ASK. `ai_confirm_changes` is read from the database, not from
 *      the request. With it off a write runs and is reported; with it on the
 *      stream stops at the call and waits for an `approve` or `reject` request.
 *   3. WHEN TO STOP. Twelve tool rounds per turn, and the whole thing is bound
 *      to the request's abort signal, so a closed panel stops the work rather
 *      than leaving a model streaming into a dead socket.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { activeAccount } from '@/lib/auth/session';
import { createClient, createClientWithHeaders } from '@/lib/supabase/server';
import { schoolToday } from '@/lib/format';
import { isRecord } from '@/lib/guards';
import { aiEnabled } from '@/lib/ai/crypto';
import { loadConnection, touchUsed } from '@/lib/ai/connections';
import {
  AI_MODEL,
  isReasoning,
  streamResponses,
  type InputItem,
  type Reasoning,
} from '@/lib/ai/responses-client';
import {
  describeCall,
  executeTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '@/lib/ai/tools';
import { systemInstructions, type PageKind } from '@/lib/ai/prompt';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  readImages,
  storedMessageItem,
  userMessageItem,
  type TurnImage,
} from '@/lib/ai/images';
import { maxBodyBytes, readBoundedBody } from '@/lib/ai/body-limit';
import {
  appendItems,
  appendPending,
  clearPending,
  createConversation,
  loadConversation,
  trimItems,
  toolOutputItem,
  type PendingCall,
} from '@/lib/ai/conversations';

// Streaming, cookies and the Node crypto used to decrypt the stored token all
// need the Node runtime; none of this can run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A turn that keeps calling tools is a turn that has stopped making progress. */
const MAX_TOOL_ROUNDS = 12;

/**
 * The longest message this endpoint accepts, in characters.
 *
 * Nothing capped it before: `body.message` went straight into an input item and
 * from there into an `ai_messages` row, whose only bound is the 256 KiB
 * check constraint — reached with a raw database error rather than a sentence.
 * Thirty thousand characters is a long pasted error log and several times any
 * question anybody types; past that the request is refused here, where the
 * message can say what to do about it.
 */
const MAX_MESSAGE_CHARS = 30_000;

/**
 * The most this endpoint will read, before it reads any of it.
 *
 * `serverActions.bodySizeLimit` does not apply to a route handler, so without
 * this `request.json()` would buffer whatever a stranger sent — every rule in
 * `images.ts` runs after the parse. Derived from the limits already published
 * rather than chosen, so raising the picture budget raises this with it.
 */
const MAX_BODY_BYTES = maxBodyBytes(MAX_IMAGES, MAX_IMAGE_BYTES, MAX_MESSAGE_CHARS);

interface ChatBody {
  conversationId?: string;
  message?: string;
  images?: TurnImage[];
  approve?: string[];
  reject?: string[];
  page?: { kind: PageKind; id: string; label: string };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readPage(value: unknown): ChatBody['page'] {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== 'ticket' && kind !== 'person' && kind !== 'device') return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  const label = typeof value.label === 'string' ? value.label : '';
  if (id === '' || label === '') return undefined;
  return { kind, id, label };
}

function problem(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const account = await activeAccount();
  if (!account) {
    return problem(401, 'signed_out', 'Your session is not able to do that. Sign in again.');
  }

  if (!aiEnabled()) {
    return problem(
      503,
      'ai_disabled',
      'The assistant is not configured on this server. An administrator has to set AI_TOKEN_KEY.',
    );
  }

  // Before the parse, not after it: the count, type and size rules below are
  // all downstream of `JSON.parse`, and how much memory a request may cost is
  // not a question that can wait for them.
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!raw.ok) {
    if (raw.reason === 'too_large') {
      return problem(
        413,
        'request_too_large',
        'That message is too large to send. Attach fewer pictures, or put the file on the ticket instead.',
      );
    }
    return problem(400, 'bad_request', 'That request was not readable.');
  }

  let body: ChatBody;
  let pictures: TurnImage[];
  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (!isRecord(parsed)) throw new Error('not an object');
    // The browser's own limits are a courtesy to the person typing; this
    // endpoint is reachable with curl, so the count, the media type and the
    // decoded size are all re-derived from the bytes that actually arrived.
    const read = readImages(parsed.images);
    if (!read.ok) return problem(read.status, read.code, read.message);
    pictures = read.images;
    body = {
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      images: pictures,
      approve: stringList(parsed.approve),
      reject: stringList(parsed.reject),
      page: readPage(parsed.page),
    };
  } catch {
    return problem(400, 'bad_request', 'That request was not readable.');
  }

  // A photograph on its own is a question. "What is this error?" with a picture
  // of the dialog is a complete turn, and refusing it for having no prose would
  // be this application insisting on the slower half of the message.
  const hasMessage = (body.message ?? '').trim() !== '' || pictures.length > 0;
  const answering = (body.approve ?? []).length > 0 || (body.reject ?? []).length > 0;
  if (!hasMessage && !answering) {
    return problem(400, 'bad_request', 'Send a message, or an answer to a pending change.');
  }
  if ((body.message ?? '').length > MAX_MESSAGE_CHARS) {
    return problem(
      413,
      'message_too_long',
      'That message is too long for one turn. Send the important part, or attach the file to the ticket instead.',
    );
  }

  let connection: Awaited<ReturnType<typeof loadConnection>>;
  try {
    connection = await loadConnection(account.id);
  } catch (error) {
    // The driver's text goes to the log, not to the browser: a refresh failure
    // can carry a token endpoint's body, and none of it helps the operator.
    console.error('[ai] connection load failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return problem(
      409,
      'not_connected',
      'That ChatGPT connection is no longer usable. Disconnect it in settings and connect again.',
    );
  }
  if (connection === null) {
    return problem(
      409,
      'not_connected',
      'Connect a ChatGPT account in settings before using the assistant.',
    );
  }

  // The ordinary client for conversation rows: those are the user's own data and
  // carry no attribution.
  const supabase = await createClient();

  // Settings FAIL CLOSED. If this read does not come back, the turn runs as
  // though the operator had asked to be consulted: the cost of asking somebody
  // who did not want to be asked is one extra tap, and the cost of the other
  // mistake is a change nobody agreed to. The panel is told, so the extra cards
  // are explained rather than mysterious.
  const preferences = await supabase.rpc('app_my_preferences');
  const preferencesFailed = Boolean(preferences.error);
  if (preferencesFailed) {
    console.error('[ai] preferences read failed', { message: preferences.error?.message });
  }
  const prefs = Array.isArray(preferences.data) ? preferences.data[0] : preferences.data;
  const reasoning: Reasoning = isReasoning(prefs?.ai_reasoning) ? prefs.ai_reasoning : 'high';
  const confirmChanges = preferencesFailed || prefs?.ai_confirm_changes === true;

  // The tool client. Same cookies, same JWT, same row-level security — the two
  // headers only tell the database HOW the change was made, and
  // `app_request_via()` fails closed to 'user' for anything else.
  const toolSupabase = await createClientWithHeaders({
    'x-edison-via': 'ai',
    'x-edison-ai-model': AI_MODEL,
  });
  const toolContext: ToolContext = {
    supabase: toolSupabase,
    actor: { id: account.id, displayName: account.displayName, roles: account.roles },
  };

  let conversationId: string;
  try {
    conversationId =
      body.conversationId && body.conversationId.trim() !== ''
        ? body.conversationId.trim()
        : // A turn that is only a photograph still deserves a name in the list,
          // and the file is the only thing anybody said about it.
          await createConversation(
            supabase,
            account.id,
            (body.message ?? '').trim() || pictures[0]?.name || 'New conversation',
          );
  } catch (error) {
    console.error('[ai] conversation open failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return problem(500, 'conversation_failed', 'That conversation could not be opened. Try again.');
  }

  const controller = new AbortController();
  // A closed panel, a navigation, a reload: all end up here, and everything
  // downstream is bound to this signal.
  request.signal.addEventListener('abort', () => controller.abort());

  const encoder = new TextEncoder();
  const tools = toolsFor(account.roles);
  const instructions = systemInstructions({
    actorName: account.displayName,
    roles: account.roles,
    today: schoolToday(),
    page: body.page,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader is gone. Stop trying rather than throwing into the loop.
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          streamController.close();
        } catch {
          // Already closed by the platform.
        }
      };

      try {
        send({ type: 'conversation', id: conversationId });

        if (preferencesFailed) {
          // Non-fatal: the turn carries on, asking before every change.
          send({
            type: 'error',
            message: 'Could not read your assistant settings; changes will ask for approval this turn.',
          });
        }

        const loaded = await loadConversation(supabase, conversationId);
        // Only the tail of a long conversation is replayed. Nothing is put in
        // the place of what is dropped: the Responses API has no input item that
        // means "earlier turns omitted", and a fake user or system message would
        // be this application putting words in somebody's mouth. See trimItems.
        const input: InputItem[] = trimItems(loaded.items);

        // --- Answers to pending changes ---------------------------------
        if (loaded.pending.length > 0) {
          const approved = new Set(body.approve ?? []);
          const outputs: InputItem[] = [];

          for (const call of loaded.pending) {
            if (approved.has(call.callId)) {
              send({ type: 'phase', phase: 'tool' });
              const result = await executeTool(call.name, call.args, toolContext);
              send({ type: 'tool_result', callId: call.callId, ok: result.ok, summary: result.summary });
              outputs.push(toolOutputItem(call.callId, { ok: result.ok, ...(isRecord(result.result) ? result.result : { result: result.result }) }));
            } else {
              // Every pending call gets an output, approved or not: the model is
              // owed an answer for each call it made, and "no" is an answer.
              send({
                type: 'tool_result',
                callId: call.callId,
                ok: false,
                summary: `Not approved: ${call.summary}`,
              });
              outputs.push(
                toolOutputItem(call.callId, {
                  ok: false,
                  error: 'The person did not approve this change. Do not try it again unless they ask.',
                }),
              );
            }
          }

          await appendItems(supabase, conversationId, 'tool', outputs);
          await clearPending(
            supabase,
            conversationId,
            loaded.pending.map((call) => call.callId),
          );
          input.push(...outputs);
        }

        // --- What the person just typed, and what they attached -----------
        //
        // Two different items on purpose. The model is sent the pictures
        // themselves, as `input_image` parts in the SAME user message as the
        // text, because a photograph and the sentence about it are one thing to
        // say. The conversation row is given the text and the names of what was
        // attached: `ai_messages_content_size` refuses a row over 256 KiB, and
        // four megabytes of base64 is many times that. See `images.ts`.
        if (hasMessage) {
          const said = (body.message ?? '').trim();
          await appendItems(supabase, conversationId, 'user', [storedMessageItem(said, pictures)]);
          input.push(userMessageItem(said, pictures));
        }

        void touchUsed(account.id);

        // --- The turn -----------------------------------------------------
        let ranOutOfRounds = false;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          if (controller.signal.aborted) break;

          send({ type: 'phase', phase: 'thinking' });

          const outputItems: InputItem[] = [];
          let pendingCall: { callId: string; name: string; args: string } | null = null;
          let failed: string | null = null;
          let writing = false;

          for await (const event of streamResponses({
            tokens: connection.tokens,
            chatgptAccountId: connection.chatgptAccountId,
            instructions,
            input,
            tools,
            reasoning,
            sessionId: conversationId,
            signal: controller.signal,
          })) {
            if (event.type === 'reasoning_delta') {
              send({ type: 'reasoning', text: event.text });
            } else if (event.type === 'text_delta') {
              if (!writing) {
                writing = true;
                send({ type: 'phase', phase: 'writing' });
              }
              send({ type: 'delta', text: event.text });
            } else if (event.type === 'output_item') {
              outputItems.push(event.item);
            } else if (event.type === 'function_call') {
              pendingCall = { callId: event.callId, name: event.name, args: event.args };
            } else if (event.type === 'error') {
              failed = event.message;
              break;
            }
          }

          // Stored before anything else happens to them, so an approval that
          // arrives on a later request still has the call it answers.
          if (outputItems.length > 0) {
            await appendItems(supabase, conversationId, 'assistant', outputItems);
            input.push(...outputItems);
          }

          if (failed !== null) {
            send({ type: 'error', message: failed });
            break;
          }
          if (pendingCall === null || controller.signal.aborted) break;

          // --- One tool call --------------------------------------------
          send({ type: 'phase', phase: 'tool' });

          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(pendingCall.args === '' ? '{}' : pendingCall.args);
            if (isRecord(parsed)) args = parsed;
          } catch {
            // Left empty: the executor's checker reports the missing fields, and
            // that message is what the model gets to correct on its next turn.
          }

          // Checked BEFORE the card is drawn. An approval card for a call that
          // cannot run asks somebody to agree to nothing, and then fails anyway;
          // an invalid call goes straight to the executor, whose refusal is the
          // message the model needs to correct itself.
          const checked = validateArgs(pendingCall.name, args);
          const summary = describeCall(pendingCall.name, args);
          const needsApproval =
            checked.ok && requiresApproval(pendingCall.name, checked.value, confirmChanges);

          send({
            type: 'tool_call',
            callId: pendingCall.callId,
            name: pendingCall.name,
            args,
            summary,
            needsApproval,
          });

          if (needsApproval) {
            const call: PendingCall['call'] = {
              callId: pendingCall.callId,
              name: pendingCall.name,
              args,
              summary,
            };
            await appendPending(supabase, conversationId, call);
            // The turn ends here. The panel shows the approval card, and the
            // next request carries approve or reject for this call id.
            break;
          }

          const result = await executeTool(pendingCall.name, args, toolContext);
          send({ type: 'tool_result', callId: pendingCall.callId, ok: result.ok, summary: result.summary });

          const output = toolOutputItem(pendingCall.callId, {
            ok: result.ok,
            ...(isRecord(result.result) ? result.result : { result: result.result }),
          });
          await appendItems(supabase, conversationId, 'tool', [output]);
          input.push(output);

          // A tool ran in the last round, so the model is owed a turn to say
          // what it found and will not get one. That — and only that — is when
          // the operator needs telling.
          if (round === MAX_TOOL_ROUNDS - 1) ranOutOfRounds = true;
        }

        if (ranOutOfRounds) {
          send({
            type: 'error',
            message: 'The assistant used its limit of steps for one message. Ask again to carry on.',
          });
        }

        send({ type: 'done' });
      } catch (error) {
        console.error('[ai] chat turn failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!controller.signal.aborted) {
          send({ type: 'error', message: 'The assistant could not finish that. Try again.' });
          send({ type: 'done' });
        }
      } finally {
        finish();
      }
    },

    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Nginx and friends buffer a streamed body by default, which would turn
      // this into one delivery at the end.
      'X-Accel-Buffering': 'no',
    },
  });
}
