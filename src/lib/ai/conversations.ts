/**
 * Where a conversation lives between turns.
 *
 * `ai_conversations` and `ai_messages` are the one place in this schema a
 * signed-in session writes a table directly (see the header of
 * 20260912100900_m5_ai_preferences.sql). That is on purpose, and it is why
 * everything here goes through the USER'S client: the policies pin every row to
 * the caller, so a conversation cannot be opened in somebody else's name or read
 * out of theirs, and there is no server-side ownership check to get wrong.
 *
 * One row per BATCH of Responses API input items, `content` holding the ordered
 * JSON array as sent. The array is what makes replay correct: an earlier version
 * wrote one row per item in a single insert, so every row of the batch shared
 * `created_at` and the tie was broken by a RANDOM uuid — which shuffles a
 * reasoning item after the function_call it belongs to, and the Responses API
 * refuses that input. Separate batches stay separate rows because each
 * PostgREST call is its own transaction, so `created_at` advances between them.
 *
 * Nothing here reinterprets what it stores. Rebuilding items from rendered text
 * would drop the encrypted reasoning and the exact function_call shape the next
 * request has to replay. The one exception is the pending-approval row, which is
 * this application's own and is filtered back out before the items are sent.
 *
 * No `server-only` import, for the same reason `crypto.ts` and `tools.ts` skip
 * it: nothing here holds a secret or reaches a service-role client — every
 * function takes the caller's own client as an argument — and the ordering and
 * trimming rules are exactly the part that has to be unit-tested. The module
 * that does hold the service role, `connections.ts`, keeps its `server-only`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InputItem } from './responses-client';
import { titleFromMessage } from './prompt';

/** Our own marker, never sent to the model. */
export interface PendingCall {
  pending: true;
  call: { callId: string; name: string; args: Record<string, unknown>; summary: string };
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface LoadedConversation {
  id: string;
  /** Ready to send: every stored item except the pending-approval markers. */
  items: InputItem[];
  pending: PendingCall['call'][];
}

type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPending(content: unknown): content is PendingCall {
  return isRecord(content) && content.pending === true && isRecord(content.call);
}

export async function listConversations(supabase: SupabaseClient): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from('ai_conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Opens a conversation, creating one when no id was given.
 *
 * `account_id` is set from the caller rather than taken from a request body;
 * the insert policy would refuse anything else, so this is the honest spelling
 * of what the database already enforces.
 */
export async function createConversation(
  supabase: SupabaseClient,
  accountId: string,
  firstMessage: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('ai_conversations')
    .insert({ account_id: accountId, title: titleFromMessage(firstMessage) })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/**
 * How many stored items are replayed to the model.
 *
 * A conversation that ran all afternoon would otherwise resend its whole history
 * every turn, which costs the operator their own quota and eventually exceeds the
 * context window outright. Sixty is roughly a dozen exchanges with their tool
 * calls, which is more than anybody refers back to in one sitting.
 */
export const MAX_REPLAY_ITEMS = 60;

/** PostgREST caps a response at its configured `max-rows`, so reads are paged. */
const MESSAGE_PAGE = 500;
const MAX_MESSAGE_PAGES = 40;

/**
 * Every message row of one conversation, in order.
 *
 * Paged rather than selected in one go: PostgREST silently truncates at
 * `max-rows` (1000 by default), and a truncated history replays as a
 * conversation that has forgotten its own middle rather than as an error.
 */
async function allMessageRows(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ content: unknown }[]> {
  const out: { content: unknown }[] = [];

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const from = page * MESSAGE_PAGE;
    const { data, error } = await supabase
      .from('ai_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + MESSAGE_PAGE - 1);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    for (const row of rows) out.push({ content: row.content as unknown });
    if (rows.length < MESSAGE_PAGE) break;
  }

  return out;
}

/**
 * Turns stored `content` values back into an ordered item list.
 *
 * Pure, and exported so the ordering can be tested without a database. Handles
 * both shapes: an array is one batch, flattened in place; a bare object is a row
 * written before batches were stored together, kept so old conversations still
 * replay.
 */
export function flattenStored(contents: readonly unknown[]): {
  items: InputItem[];
  pending: PendingCall['call'][];
} {
  const items: InputItem[] = [];
  const pending: PendingCall['call'][] = [];

  for (const content of contents) {
    if (isPending(content)) {
      pending.push(content.call);
      continue;
    }
    if (Array.isArray(content)) {
      for (const entry of content) if (isRecord(entry)) items.push(entry);
      continue;
    }
    if (isRecord(content)) items.push(content);
  }

  return { items, pending };
}

/**
 * The tail of a conversation, plus the request that started it.
 *
 * Two rules beyond "keep the last N":
 *
 *   * The FIRST user message is always kept. It is what the whole conversation
 *     is about, and losing it turns a long session into a model answering
 *     follow-ups to a question it can no longer see.
 *   * A `function_call_output` whose `function_call` fell outside the window is
 *     dropped. The Responses API rejects an output with no call, so trimming
 *     naively would turn a long conversation into a hard failure. Nothing is
 *     substituted in its place: there is no input item shape for "earlier turns
 *     omitted", and inventing a user or system message would put words in
 *     somebody's mouth.
 */
export function trimItems(items: readonly InputItem[], limit = MAX_REPLAY_ITEMS): InputItem[] {
  const window: InputItem[] = items.length <= limit ? [...items] : items.slice(items.length - limit);

  if (items.length > limit) {
    const firstUser = items.find(
      (item) => item.type === 'message' && item.role === 'user',
    );
    if (firstUser !== undefined && !window.includes(firstUser)) window.unshift(firstUser);
  }

  const called = new Set<string>();
  const kept: InputItem[] = [];
  for (const item of window) {
    if (item.type === 'function_call' && typeof item.call_id === 'string') called.add(item.call_id);
    if (item.type === 'function_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      if (!called.has(callId)) continue;
    }
    kept.push(item);
  }
  return kept;
}

export async function loadConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<LoadedConversation> {
  const rows = await allMessageRows(supabase, conversationId);
  const { items, pending } = flattenStored(rows.map((row) => row.content));
  return { id: conversationId, items, pending };
}

/**
 * Stores one batch as ONE row, `content` holding the ordered array.
 *
 * This is the fix for replay order. See the module header: a per-item insert
 * puts every row of the batch at the same `created_at`, and no column left can
 * break that tie in the order the model produced them.
 */
export async function appendItems(
  supabase: SupabaseClient,
  conversationId: string,
  role: MessageRole,
  items: InputItem[],
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await supabase
    .from('ai_messages')
    .insert({ conversation_id: conversationId, role, content: items });
  if (error) throw new Error(error.message);
}

export async function appendPending(
  supabase: SupabaseClient,
  conversationId: string,
  call: PendingCall['call'],
): Promise<void> {
  const { error } = await supabase
    .from('ai_messages')
    .insert({ conversation_id: conversationId, role: 'tool', content: { pending: true, call } });
  if (error) throw new Error(error.message);
}

/**
 * Clears the pending markers once they have been answered.
 *
 * Deleting rather than flagging: a pending call that has been approved or
 * rejected is not history, it is a question that has been answered, and the
 * function_call_output written next IS the record of what happened.
 */
export async function clearPending(
  supabase: SupabaseClient,
  conversationId: string,
  callIds: string[],
): Promise<void> {
  if (callIds.length === 0) return;
  // Filtered in the database on the marker itself rather than on `role`, which
  // a function_call_output batch also carries: a long conversation would
  // otherwise hit PostgREST's row cap before reaching the pending row, and the
  // approval card would come back on the next turn having already been answered.
  const { data, error } = await supabase
    .from('ai_messages')
    .select('id, content')
    .eq('conversation_id', conversationId)
    .eq('content->>pending', 'true');
  if (error) throw new Error(error.message);

  const doomed = (data ?? [])
    .filter((row) => {
      const content = row.content as unknown;
      return isPending(content) && callIds.includes(String(content.call.callId));
    })
    .map((row) => row.id as string);
  if (doomed.length === 0) return;

  const { error: deleteError } = await supabase.from('ai_messages').delete().in('id', doomed);
  if (deleteError) throw new Error(deleteError.message);
}

export async function deleteConversation(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('ai_conversations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** The Responses API shape for one thing the person typed. */
export function userItem(message: string): InputItem {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] };
}

/**
 * How much of a tool's result is worth sending back.
 *
 * A page of a hundred devices serialises to more than the answer needs, and
 * every round after it carries that weight again. Truncating with a note is
 * better than either sending it all or silently dropping rows: the model can see
 * that there was more and narrow its next call.
 */
const MAX_TOOL_OUTPUT = 24_000;

/** The Responses API shape for what one tool call produced. */
export function toolOutputItem(callId: string, output: unknown): InputItem {
  const json = JSON.stringify(output);
  const text =
    json.length <= MAX_TOOL_OUTPUT
      ? json
      : JSON.stringify({
          truncated: true,
          note: 'The result was too long to send in full. Narrow the search or ask for fewer rows.',
          preview: json.slice(0, MAX_TOOL_OUTPUT),
        });
  return { type: 'function_call_output', call_id: callId, output: text };
}
