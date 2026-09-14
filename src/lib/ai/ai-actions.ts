'use server';

/**
 * Everything the assistant panel does that is not the chat stream itself:
 * linking a ChatGPT account, reading and changing the AI settings, and listing
 * or deleting past conversations.
 *
 * Every action re-derives the actor with `activeAccount()` and then works only
 * against that account's own id. Nothing takes an account id, a conversation
 * owner or a role from the caller, and nothing returns a token: `aiStatusAction`
 * reports an address and a plan name, which is all the panel needs to show that
 * a connection exists.
 *
 * The device flow is deliberately split into start and poll. A single action
 * that waited for the browser to finish would hold a server function open for up
 * to fifteen minutes; instead the client asks again on the interval the service
 * named, and closing the panel simply stops the asking. The half of that flow
 * that must not be public — the device auth id — never reaches the browser at
 * all: it is sealed into an httpOnly cookie bound to this account, and the poll
 * reads it from there rather than from its caller. See `device-cookie.ts`.
 */

import { cookies } from 'next/headers';
import { isRecord, textOf } from '@/lib/guards';
import { activeAccount } from '@/lib/auth/session';
import { appOrigin } from '@/lib/supabase/config';
import { createClient } from '@/lib/supabase/server';
import { aiEnabled } from './crypto';
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  openDeviceAuth,
  sealDeviceAuth,
} from './device-cookie';
import { pollDeviceAuth, startDeviceAuth, type DeviceAuthStart } from './codex-auth';
import { disconnect, saveConnection } from './connections';
import {
  deleteConversation,
  listConversations,
  loadConversation,
  type ConversationSummary,
  type PendingCall,
} from './conversations';
import { describeCall } from './tools';
import { AI_MODEL, AI_MODEL_LABEL, isReasoning, type Reasoning } from './responses-client';

export interface AiActionResult {
  ok: boolean;
  error?: string;
}

export interface AiStatus {
  /** False when AI_TOKEN_KEY is not set, which turns the feature off entirely. */
  enabled: boolean;
  connected: boolean;
  email: string | null;
  planType: string | null;
  reasoning: Reasoning;
  confirmChanges: boolean;
  speakReplies: boolean;
  model: string;
  modelLabel: string;
}

export interface DeviceAuthStarted extends AiActionResult {
  start?: DeviceAuthStart;
}

export interface DeviceAuthPolled extends AiActionResult {
  status?: 'pending' | 'complete';
}

const SIGNED_OUT = 'Your session is not able to do that. Sign in again.';
const DISABLED = 'The assistant is not configured on this server. Set AI_TOKEN_KEY and restart.';

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'That did not work. Try again.';
}

const PAIRING_OVER = 'That sign-in has expired. Start it again.';

async function writeDeviceCookie(accountId: string, deviceAuthId: string): Promise<void> {
  const jar = await cookies();
  jar.set(DEVICE_COOKIE, sealDeviceAuth(accountId, deviceAuthId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || appOrigin().startsWith('https://'),
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
}

async function clearDeviceCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(DEVICE_COOKIE);
}

export async function startCodexAuthAction(): Promise<DeviceAuthStarted> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT };
  if (!aiEnabled()) return { ok: false, error: DISABLED };

  try {
    const start = await startDeviceAuth();
    await writeDeviceCookie(account.id, start.deviceAuthId);
    // The browser is told the code to type and where to type it, and nothing
    // else: the id it would have carried back is already in the cookie, and an
    // id on screen is an id somebody else can poll with.
    return { ok: true, start: { ...start, deviceAuthId: '' } };
  } catch (error) {
    await clearDeviceCookie();
    return { ok: false, error: failureText(error) };
  }
}

/**
 * One poll. `complete` means the tokens are already encrypted and stored, so the
 * panel's next status read will say connected.
 *
 * The device auth id never comes from the caller. It comes from the cookie
 * `startCodexAuthAction` wrote, which binds it to this account, so a code read
 * off a colleague's screen cannot be polled from another session into another
 * account's connection.
 */
export async function pollCodexAuthAction(userCode: string): Promise<DeviceAuthPolled> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT };
  if (!aiEnabled()) return { ok: false, error: DISABLED };

  const jar = await cookies();
  const deviceAuthId = openDeviceAuth(jar.get(DEVICE_COOKIE)?.value, account.id);
  if (deviceAuthId === null || typeof userCode !== 'string' || userCode === '') {
    await clearDeviceCookie();
    return { ok: false, error: PAIRING_OVER };
  }

  try {
    const result = await pollDeviceAuth(deviceAuthId, userCode);
    if (result.status === 'pending') return { ok: true, status: 'pending' };
    await saveConnection(account.id, result.tokens);
    await clearDeviceCookie();
    return { ok: true, status: 'complete' };
  } catch (error) {
    // Any answer other than "still waiting" ends this pairing: the code has
    // expired, been refused or been answered somewhere else, and the panel is
    // about to show its error. Nothing is left for a later poll to use.
    await clearDeviceCookie();
    return { ok: false, error: failureText(error) };
  }
}

export async function disconnectCodexAction(): Promise<AiActionResult> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT };

  try {
    await disconnect(account.id);
    await clearDeviceCookie();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }
}

/**
 * What the panel needs to render itself.
 *
 * `app_my_ai_connection()` is used for "is there a connection", not
 * `loadConnection`, because reading the status must not spend a refresh or
 * decrypt a token. The ciphertext never leaves the server, and this function
 * never even loads it.
 */
export async function aiStatusAction(): Promise<AiStatus> {
  const enabled = aiEnabled();
  const fallback: AiStatus = {
    enabled,
    connected: false,
    email: null,
    planType: null,
    reasoning: 'high',
    confirmChanges: false,
    speakReplies: false,
    model: AI_MODEL,
    modelLabel: AI_MODEL_LABEL,
  };

  const account = await activeAccount();
  if (!account) return fallback;

  const supabase = await createClient();
  const [connection, preferences] = await Promise.all([
    supabase.rpc('app_my_ai_connection'),
    supabase.rpc('app_my_preferences'),
  ]);

  const row = Array.isArray(connection.data) ? connection.data[0] : null;
  const prefs = Array.isArray(preferences.data) ? preferences.data[0] : preferences.data;

  return {
    enabled,
    connected: enabled && row?.connected === true,
    email: (row?.account_email as string | null) ?? null,
    planType: (row?.plan_type as string | null) ?? null,
    reasoning: isReasoning(prefs?.ai_reasoning) ? prefs.ai_reasoning : 'high',
    confirmChanges: prefs?.ai_confirm_changes === true,
    speakReplies: prefs?.ai_speak_replies === true,
    model: AI_MODEL,
    modelLabel: AI_MODEL_LABEL,
  };
}

export interface AiPreferencePatch {
  reasoning?: Reasoning;
  confirmChanges?: boolean;
  speakReplies?: boolean;
}

/**
 * Changes only the three AI settings.
 *
 * The patch is rebuilt key by key rather than forwarded, so a caller cannot
 * reach `theme` or `notify_in_app` through this action even though
 * `app_update_preferences` would accept them.
 */
export async function updateAiPreferencesAction(patch: AiPreferencePatch): Promise<AiActionResult> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT };

  const body: Record<string, unknown> = {};
  if (patch?.reasoning !== undefined) {
    if (!isReasoning(patch.reasoning)) {
      return { ok: false, error: 'Choose a reasoning level: low, medium, high or extra high.' };
    }
    body.ai_reasoning = patch.reasoning;
  }
  if (typeof patch?.confirmChanges === 'boolean') body.ai_confirm_changes = patch.confirmChanges;
  if (typeof patch?.speakReplies === 'boolean') body.ai_speak_replies = patch.speakReplies;
  if (Object.keys(body).length === 0) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_update_preferences', { p_patch: body });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export interface ConversationListResult extends AiActionResult {
  conversations: ConversationSummary[];
}

export async function listConversationsAction(): Promise<ConversationListResult> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT, conversations: [] };

  try {
    const supabase = await createClient();
    return { ok: true, conversations: await listConversations(supabase) };
  } catch (error) {
    return { ok: false, error: failureText(error), conversations: [] };
  }
}

export async function deleteConversationAction(id: string): Promise<AiActionResult> {
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT };
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'Say which conversation to delete.' };
  }

  try {
    // The delete policy is what scopes this to the caller's own conversations;
    // an id belonging to somebody else simply matches no row.
    const supabase = await createClient();
    await deleteConversation(supabase, id.trim());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }
}

/**
 * A stored conversation, reduced to what the panel can show.
 *
 * The rows hold Responses API items — messages, function calls, their
 * outputs, encrypted reasoning — and only the first three mean anything to a
 * reader. A call's summary is rebuilt with `describeCall` from the arguments
 * as stored, so a past chip says the same thing it said live.
 */
export type TranscriptItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; callId: string; name: string; summary: string; ok: boolean | null };

export interface ConversationTranscriptResult extends AiActionResult {
  title: string | null;
  items: TranscriptItem[];
  /** Calls still waiting for an answer, oldest first. */
  pending: PendingCall['call'][];
}

export async function loadConversationAction(id: string): Promise<ConversationTranscriptResult> {
  const empty = { title: null, items: [], pending: [] };
  const account = await activeAccount();
  if (!account) return { ok: false, error: SIGNED_OUT, ...empty };
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'Say which conversation to open.', ...empty };
  }

  try {
    // The select policy scopes both reads to the caller's own rows; somebody
    // else's id simply comes back empty.
    const supabase = await createClient();
    const conversationId = id.trim();
    const [loaded, titled] = await Promise.all([
      loadConversation(supabase, conversationId),
      supabase.from('ai_conversations').select('title').eq('id', conversationId).maybeSingle(),
    ]);

    const items: TranscriptItem[] = [];
    const calls = new Map<string, number>();

    for (const item of loaded.items) {
      const type = textOf(item.type);
      if (type === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .map((part: unknown) => (isRecord(part) ? textOf(part.text) : ''))
          .join('');
        if (text.trim() === '') continue;
        items.push({ role: item.role === 'user' ? 'user' : 'assistant', text });
      } else if (type === 'function_call') {
        const callId = textOf(item.call_id) || textOf(item.id);
        const name = textOf(item.name);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(textOf(item.arguments) || '{}');
          if (isRecord(parsed)) args = parsed;
        } catch {
          // Unreadable arguments: the summary still names the tool.
        }
        calls.set(callId, items.length);
        items.push({ role: 'tool', callId, name, summary: describeCall(name, args), ok: null });
      } else if (type === 'function_call_output') {
        const at = calls.get(textOf(item.call_id));
        if (at === undefined) continue;
        let ok: boolean | null = null;
        try {
          const parsed: unknown = JSON.parse(textOf(item.output));
          if (isRecord(parsed) && typeof parsed.ok === 'boolean') ok = parsed.ok;
        } catch {
          // An unreadable output is reported as unknown rather than as a failure.
        }
        const call = items[at];
        if (call.role === 'tool') items[at] = { ...call, ok };
      }
    }

    return {
      ok: true,
      title: textOf(titled.data?.title) || null,
      items,
      pending: loaded.pending,
    };
  } catch (error) {
    return { ok: false, error: failureText(error), ...empty };
  }
}
