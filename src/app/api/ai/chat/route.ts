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
import { aiEnabled } from '@/lib/ai/crypto';
import { loadConnection, touchUsed } from '@/lib/ai/connections';
import {
  AI_MODEL,
  isReasoning,
  streamResponses,
  type InputItem,
  type Reasoning,
} from '@/lib/ai/responses-client';
import { describeCall, executeTool, isWriteCall, toolsFor, type ToolContext } from '@/lib/ai/tools';
import { systemInstructions, type PageKind } from '@/lib/ai/prompt';
import {
  appendItems,
  appendPending,
  clearPending,
  createConversation,
  loadConversation,
  toolOutputItem,
  userItem,
  type PendingCall,
} from '@/lib/ai/conversations';

// Streaming, cookies and the Node crypto used to decrypt the stored token all
// need the Node runtime; none of this can run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A turn that keeps calling tools is a turn that has stopped making progress. */
const MAX_TOOL_ROUNDS = 12;

interface ChatBody {
  conversationId?: string;
  message?: string;
  approve?: string[];
  reject?: string[];
  page?: { kind: PageKind; id: string; label: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

  let body: ChatBody;
  try {
    const parsed: unknown = await request.json();
    if (!isRecord(parsed)) throw new Error('not an object');
    body = {
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      approve: stringList(parsed.approve),
      reject: stringList(parsed.reject),
      page: readPage(parsed.page),
    };
  } catch {
    return problem(400, 'bad_request', 'That request was not readable.');
  }

  const hasMessage = (body.message ?? '').trim() !== '';
  const answering = (body.approve ?? []).length > 0 || (body.reject ?? []).length > 0;
  if (!hasMessage && !answering) {
    return problem(400, 'bad_request', 'Send a message, or an answer to a pending change.');
  }

  let connection: Awaited<ReturnType<typeof loadConnection>>;
  try {
    connection = await loadConnection(account.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the connection could not be read';
    return problem(409, 'not_connected', `That ChatGPT connection is no longer usable: ${detail}`);
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

  const preferences = await supabase.rpc('app_my_preferences');
  const prefs = Array.isArray(preferences.data) ? preferences.data[0] : preferences.data;
  const reasoning: Reasoning = isReasoning(prefs?.ai_reasoning) ? prefs.ai_reasoning : 'high';
  const confirmChanges = prefs?.ai_confirm_changes === true;

  // The tool client. Same cookies, same JWT, same row-level security — the two
  // headers only tell the database HOW the change was made, and
  // `app_request_via()` fails closed to 'user' for anything else.
  const toolSupabase = await createClientWithHeaders({
    'x-edison-via': 'ai',
    'x-edison-ai-model': AI_MODEL,
  });
  const toolContext: ToolContext = {
    supabase: toolSupabase,
    actor: { id: account.id, displayName: account.displayName, role: account.role },
  };

  let conversationId: string;
  try {
    conversationId =
      body.conversationId && body.conversationId.trim() !== ''
        ? body.conversationId.trim()
        : await createConversation(supabase, account.id, body.message ?? 'New conversation');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the conversation could not be opened';
    return problem(500, 'conversation_failed', detail);
  }

  const controller = new AbortController();
  // A closed panel, a navigation, a reload: all end up here, and everything
  // downstream is bound to this signal.
  request.signal.addEventListener('abort', () => controller.abort());

  const encoder = new TextEncoder();
  const tools = toolsFor(account.role);
  const instructions = systemInstructions({
    actorName: account.displayName,
    role: account.role,
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

        const loaded = await loadConversation(supabase, conversationId);
        const input: InputItem[] = [...loaded.items];

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

        // --- What the person just typed ----------------------------------
        if (hasMessage) {
          const item = userItem((body.message ?? '').trim());
          await appendItems(supabase, conversationId, 'user', [item]);
          input.push(item);
        }

        void touchUsed(account.id);

        // --- The turn -----------------------------------------------------
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

          const summary = describeCall(pendingCall.name, args);
          const needsApproval = confirmChanges && isWriteCall(pendingCall.name, args);

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

          if (round === MAX_TOOL_ROUNDS - 1) {
            send({
              type: 'error',
              message: 'The assistant used its limit of steps for one message. Ask again to carry on.',
            });
          }
        }

        send({ type: 'done' });
      } catch (error) {
        if (!controller.signal.aborted) {
          const detail = error instanceof Error ? error.message : 'something went wrong';
          send({ type: 'error', message: detail });
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
