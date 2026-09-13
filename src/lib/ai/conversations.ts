import 'server-only';

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
 * One row per Responses API input item, stored as sent. Rebuilding items from
 * rendered text would drop the encrypted reasoning and the exact function_call
 * shape the next request has to replay, so nothing here reinterprets what it
 * stores — except the pending-approval row, which is this application's own and
 * is filtered back out before the items are sent.
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

export async function loadConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<LoadedConversation> {
  const { data, error } = await supabase
    .from('ai_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);

  const items: InputItem[] = [];
  const pending: PendingCall['call'][] = [];
  for (const row of data ?? []) {
    const content = row.content as unknown;
    if (isPending(content)) {
      pending.push(content.call as PendingCall['call']);
      continue;
    }
    if (isRecord(content)) items.push(content);
  }
  return { id: conversationId, items, pending };
}

export async function appendItems(
  supabase: SupabaseClient,
  conversationId: string,
  role: MessageRole,
  items: InputItem[],
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await supabase
    .from('ai_messages')
    .insert(items.map((content) => ({ conversation_id: conversationId, role, content })));
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
  const { data, error } = await supabase
    .from('ai_messages')
    .select('id, content')
    .eq('conversation_id', conversationId)
    .eq('role', 'tool');
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
