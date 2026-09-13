/**
 * M5 account preferences, the Codex connection, and AI conversations.
 *
 * Three quite different kinds of private data land in one migration, and the
 * rules that separate them are the point of this suite.
 *
 *   1. PREFERENCES are per-account settings with a vocabulary. A row is created
 *      the first time an account asks for one, the patch that changes it accepts
 *      only the five keys it knows and IGNORES the rest, and every value is
 *      checked against the list it has to come from. The defaults matter: the
 *      product ships dark, and it does not ask the operator to confirm every AI
 *      change.
 *
 *   2. The CODEX CONNECTION holds an encrypted OAuth token. The ciphertext must
 *      never leave the database through a client role, so `ai_connections` has
 *      row-level security enabled and NO policies at all, every privilege is
 *      revoked from anon and authenticated, and the only way to learn anything
 *      about it is a function that reports whether a connection exists and never
 *      returns the secret.
 *
 *   3. CONVERSATIONS are the one place in this schema where a signed-in session
 *      writes a table directly. That is deliberate — a chat turn is the user's
 *      own data, not a helpdesk record, and routing it through an RPC would buy
 *      nothing — so the policies have to carry the whole weight: a row may only
 *      ever be written for the caller's own account, and a message only into a
 *      conversation the caller owns.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, so no test proves something about a privileged path the
 * application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

/** insufficient_privilege and check_violation, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let helper: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let denied: SupabaseClient;

interface Preferences {
  account_id: string;
  theme: string;
  ai_reasoning: string;
  ai_confirm_changes: boolean;
  ai_speak_replies: boolean;
  notify_in_app: boolean;
  updated_at: string;
}

interface AiConnectionReport {
  connected: boolean;
  account_email: string | null;
  plan_type: string | null;
  connected_at: string | null;
  last_used_at: string | null;
}

interface Conversation {
  id: string;
  account_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

async function myPreferences(client: SupabaseClient): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_my_preferences');
}

async function updatePreferences(
  client: SupabaseClient,
  patch: Record<string, unknown>,
): Promise<Preferences> {
  return rpcOk<Preferences>(client, 'app_update_preferences', { p_patch: patch });
}

async function rawPreferences(accountId: string): Promise<Preferences | null> {
  const { data, error } = await service
    .from('account_preferences')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`Could not read preferences: ${error.message}`);
  return (data ?? null) as Preferences | null;
}

async function accountEvents(accountId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('record_events')
    .select('*')
    .eq('entity_type', 'account')
    .eq('entity_id', accountId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read account history: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function rawAccount(accountId: string): Promise<Record<string, unknown>> {
  const { data, error } = await service
    .from('app_accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`Could not read account: ${error.message}`);
  return data as Record<string, unknown>;
}

/** Starts a conversation the way the application will: a direct insert. */
async function startConversation(
  client: SupabaseClient,
  accountId: string,
  title = 'Why will this projector not wake up?',
) {
  return client
    .from('ai_conversations')
    .insert({ account_id: accountId, title })
    .select()
    .single();
}

async function rawConversation(id: string): Promise<Conversation | null> {
  const { data, error } = await service
    .from('ai_conversations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read conversation: ${error.message}`);
  return (data ?? null) as Conversation | null;
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, helper, unrelated, pending, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('denied'),
  ]);
});

describe('account preferences', () => {
  it('creates the row on first ask, dark and without a confirmation step', async () => {
    expect(await rawPreferences(identity('owner').id)).toBeNull();

    const row = await myPreferences(owner);

    expect(row.account_id).toBe(identity('owner').id);
    expect(row.theme).toBe('dark');
    expect(row.ai_reasoning).toBe('high');
    expect(row.ai_confirm_changes).toBe(false);
    expect(row.ai_speak_replies).toBe(false);
    expect(row.notify_in_app).toBe(true);

    expect(await rawPreferences(identity('owner').id)).not.toBeNull();
  });

  it('asking twice returns the same row rather than a second one', async () => {
    const first = await myPreferences(helper);
    const second = await myPreferences(helper);

    expect(second.account_id).toBe(first.account_id);
    expect(second.updated_at).toBe(first.updated_at);

    const { count, error } = await service
      .from('account_preferences')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', identity('collaborator').id);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });

  it('applies a patch and leaves the keys it was not sent alone', async () => {
    await myPreferences(owner);

    const row = await updatePreferences(owner, { theme: 'light', ai_reasoning: 'medium' });

    expect(row.theme).toBe('light');
    expect(row.ai_reasoning).toBe('medium');
    expect(row.notify_in_app).toBe(true);
    expect(row.ai_confirm_changes).toBe(false);

    const stored = await rawPreferences(identity('owner').id);
    expect(stored?.theme).toBe('light');

    // Put it back so the rest of the suite sees the shipped defaults.
    const restored = await updatePreferences(owner, { theme: 'dark', ai_reasoning: 'high' });
    expect(restored.theme).toBe('dark');
  });

  it('ignores a key it does not know instead of refusing the whole patch', async () => {
    const row = await updatePreferences(owner, {
      theme: 'system',
      account_id: identity('admin').id,
      updated_at: '1999-01-01T00:00:00Z',
      favourite_colour: 'chartreuse',
    });

    expect(row.theme).toBe('system');
    expect(row.account_id).toBe(identity('owner').id);
    expect(new Date(row.updated_at).getUTCFullYear()).toBeGreaterThan(2000);

    await updatePreferences(owner, { theme: 'dark' });
  });

  it('refuses a theme and a reasoning level that are not in the vocabulary', async () => {
    const theme = await rpcFails(owner, 'app_update_preferences', {
      p_patch: { theme: 'midnight' },
    });
    expect(theme.code).toBe(REJECTED);
    expect(theme.message).toMatch(/system, light or dark/i);

    const reasoning = await rpcFails(owner, 'app_update_preferences', {
      p_patch: { ai_reasoning: 'maximum' },
    });
    expect(reasoning.code).toBe(REJECTED);
    expect(reasoning.message).toMatch(/low, medium, high or xhigh/i);
  });

  it('refuses a switch that is not true or false', async () => {
    const failure = await rpcFails(owner, 'app_update_preferences', {
      p_patch: { ai_confirm_changes: 'yes please' },
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/true or false/i);
  });

  it('refuses a patch that is not an object of fields', async () => {
    const failure = await rpcFails(owner, 'app_update_preferences', { p_patch: 'dark' });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/object of fields/i);
  });

  it('creates the row for an account that patches before it ever reads', async () => {
    expect(await rawPreferences(identity('unrelated').id)).toBeNull();

    const row = await updatePreferences(unrelated, { ai_speak_replies: true });

    expect(row.ai_speak_replies).toBe(true);
    expect(row.theme).toBe('dark');
    expect(await rawPreferences(identity('unrelated').id)).not.toBeNull();
  });

  it("keeps one account's settings out of every other account", async () => {
    await myPreferences(owner);

    const { data, error } = await helper.from('account_preferences').select('account_id');
    expect(error).toBeNull();
    expect((data ?? []).map((row) => (row as { account_id: string }).account_id)).toEqual([
      identity('collaborator').id,
    ]);

    // Not even an administrator reads somebody else's settings.
    const asAdmin = await admin.from('account_preferences').select('account_id');
    expect((asAdmin.data ?? []).every((row) => (row as { account_id: string }).account_id ===
      identity('admin').id)).toBe(true);
  });

  it('is not writable straight from a session', async () => {
    const insert = await owner
      .from('account_preferences')
      .insert({ account_id: identity('admin').id, theme: 'light' });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await owner
      .from('account_preferences')
      .update({ theme: 'light' })
      .eq('account_id', identity('owner').id);
    expect(update.error?.message).toMatch(/permission denied/i);

    expect((await rawPreferences(identity('owner').id))?.theme).toBe('dark');
  });

  it('refuses an account that cannot reach helpdesk records at all', async () => {
    const failure = await rpcFails(pending, 'app_my_preferences');
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/cannot access helpdesk records/i);

    const refused = await rpcFails(denied, 'app_update_preferences', { p_patch: { theme: 'light' } });
    expect(refused.code).toBe(REFUSED);
  });
});

describe('changing your own display name', () => {
  it('trims the name, stores it, and records the change against the account', async () => {
    const before = String((await rawAccount(identity('unrelated').id)).display_name);

    await rpcOk(unrelated, 'app_update_display_name', { p_name: '  Robin Ashford  ' });

    expect((await rawAccount(identity('unrelated').id)).display_name).toBe('Robin Ashford');

    const events = await accountEvents(identity('unrelated').id);
    const renamed = events.filter((event) => event.kind === 'renamed');
    expect(renamed).toHaveLength(1);
    expect(String(renamed[0].summary)).toContain('Robin Ashford');
    // The name they used to go by is not spread through the history.
    expect(String(renamed[0].summary)).not.toContain(before);
    expect(renamed[0].detail).toBeNull();
    expect(renamed[0].actor_id).toBe(identity('unrelated').id);

    // Put the seeded name back so the rest of the suite reads as it expects.
    await rpcOk(unrelated, 'app_update_display_name', { p_name: before });
    expect((await rawAccount(identity('unrelated').id)).display_name).toBe(before);
  });

  it('refuses a name that is too short and one that is too long', async () => {
    const short = await rpcFails(owner, 'app_update_display_name', { p_name: ' P ' });
    expect(short.code).toBe(REJECTED);
    expect(short.message).toMatch(/2 and 80 characters/i);

    const long = await rpcFails(owner, 'app_update_display_name', { p_name: 'q'.repeat(81) });
    expect(long.code).toBe(REJECTED);
    expect(long.message).toMatch(/2 and 80 characters/i);

    const blank = await rpcFails(owner, 'app_update_display_name', { p_name: null });
    expect(blank.code).toBe(REJECTED);
  });

  it('refuses an account that cannot reach helpdesk records', async () => {
    const failure = await rpcFails(pending, 'app_update_display_name', { p_name: 'Jordan P' });
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/cannot access helpdesk records/i);
  });
});

describe('the Codex connection', () => {
  it('is invisible and unwritable to a signed-in session, even after the server stores one', async () => {
    const stored = await service.from('ai_connections').insert({
      account_id: identity('owner').id,
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0LWZvci10ZXN0cw==',
      chatgpt_account_id: 'acct_synthetic_1',
      account_email: 'priya.raman@edison.example',
      plan_type: 'plus',
    });
    expect(stored.error).toBeNull();

    const read = await owner.from('ai_connections').select('*');
    expect(read.error?.message).toMatch(/permission denied/i);
    expect(read.data ?? []).toHaveLength(0);

    const write = await owner.from('ai_connections').insert({
      account_id: identity('owner').id,
      ciphertext: 'Zm9yZ2Vk',
    });
    expect(write.error?.message).toMatch(/permission denied|violates row-level security/i);

    const erase = await admin.from('ai_connections').delete().eq('account_id', identity('owner').id);
    expect(erase.error?.message).toMatch(/permission denied/i);

    const anonRead = await anonClient().from('ai_connections').select('account_id');
    expect(anonRead.error?.message).toMatch(/permission denied/i);
  });

  it('reports a connection without ever handing back the ciphertext', async () => {
    const [report] = await rpcOk<AiConnectionReport[]>(owner, 'app_my_ai_connection');

    expect(report.connected).toBe(true);
    expect(report.account_email).toBe('priya.raman@edison.example');
    expect(report.plan_type).toBe('plus');
    expect(report.connected_at).toBeTruthy();
    expect(report.last_used_at).toBeNull();
    expect(Object.keys(report).sort()).toEqual([
      'account_email',
      'connected',
      'connected_at',
      'last_used_at',
      'plan_type',
    ]);
    expect(JSON.stringify(report)).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
  });

  it('reports no connection for an account that has not linked one', async () => {
    const [report] = await rpcOk<AiConnectionReport[]>(helper, 'app_my_ai_connection');

    expect(report.connected).toBe(false);
    expect(report.account_email).toBeNull();
    expect(report.plan_type).toBeNull();
    expect(report.connected_at).toBeNull();
    expect(report.last_used_at).toBeNull();
  });

  it('tells a restricted account nothing at all', async () => {
    expect(await rpcOk<AiConnectionReport[]>(pending, 'app_my_ai_connection')).toHaveLength(0);
    expect(await rpcOk<AiConnectionReport[]>(denied, 'app_my_ai_connection')).toHaveLength(0);

    const failure = await rpcFails(anonClient(), 'app_my_ai_connection');
    expect(failure.message).toMatch(/permission denied|function|schema cache/i);
  });
});

describe('AI conversations and messages', () => {
  it('lets an account start a conversation of its own and write into it', async () => {
    const { data, error } = await startConversation(owner, identity('owner').id);
    expect(error).toBeNull();
    const conversation = data as Conversation;
    expect(conversation.account_id).toBe(identity('owner').id);
    expect(conversation.title).toBe('Why will this projector not wake up?');

    const message = await owner.from('ai_messages').insert({
      conversation_id: conversation.id,
      role: 'user',
      content: { type: 'input_text', text: 'The podium laptop shows no signal.' },
    });
    expect(message.error).toBeNull();

    const mine = await owner.from('ai_messages').select('*').eq('conversation_id', conversation.id);
    expect(mine.data ?? []).toHaveLength(1);
  });

  it('moves the conversation forward whenever a message is added to it', async () => {
    const { data } = await startConversation(owner, identity('owner').id, 'Printer queue stuck');
    const conversation = data as Conversation;
    const before = (await rawConversation(conversation.id))?.updated_at;

    await new Promise((resolve) => setTimeout(resolve, 25));
    const message = await owner.from('ai_messages').insert({
      conversation_id: conversation.id,
      role: 'assistant',
      content: { type: 'output_text', text: 'Clear the spooler and try again.' },
    });
    expect(message.error).toBeNull();

    const after = (await rawConversation(conversation.id))?.updated_at;
    expect(new Date(String(after)).getTime()).toBeGreaterThan(new Date(String(before)).getTime());
  });

  it("refuses a conversation opened in somebody else's name", async () => {
    const { error } = await startConversation(owner, identity('collaborator').id);

    expect(error?.message).toMatch(/violates row-level security/i);
  });

  it("refuses a message written into somebody else's conversation", async () => {
    const { data } = await startConversation(helper, identity('collaborator').id, 'Wi-fi drops');
    const theirs = data as Conversation;

    const forged = await owner.from('ai_messages').insert({
      conversation_id: theirs.id,
      role: 'user',
      content: { type: 'input_text', text: 'Written into a conversation I do not own.' },
    });

    expect(forged.error?.message).toMatch(/violates row-level security/i);
    const { count } = await service
      .from('ai_messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', theirs.id);
    expect(count).toBe(0);
  });

  it('shows an account only its own conversations and messages', async () => {
    const { data } = await startConversation(helper, identity('collaborator').id, 'Smartboard pen');
    const theirs = data as Conversation;
    await helper.from('ai_messages').insert({
      conversation_id: theirs.id,
      role: 'user',
      content: { type: 'input_text', text: 'The pen stopped tracking.' },
    });

    const ownerSees = await owner.from('ai_conversations').select('id, account_id');
    expect(
      (ownerSees.data ?? []).every(
        (row) => (row as { account_id: string }).account_id === identity('owner').id,
      ),
    ).toBe(true);
    expect((ownerSees.data ?? []).some((row) => (row as { id: string }).id === theirs.id)).toBe(
      false,
    );

    const ownerMessages = await owner
      .from('ai_messages')
      .select('id')
      .eq('conversation_id', theirs.id);
    expect(ownerMessages.data ?? []).toHaveLength(0);

    // Not an administrator's business either: these are personal chats.
    const adminSees = await admin.from('ai_conversations').select('id').eq('id', theirs.id);
    expect(adminSees.data ?? []).toHaveLength(0);

    const anonSees = await anonClient().from('ai_conversations').select('id');
    expect(anonSees.error?.message ?? '').toMatch(/permission denied|^$/i);
    expect(anonSees.data ?? []).toHaveLength(0);
  });

  it("lets an account rename and delete its own conversation, and nobody else's", async () => {
    const { data } = await startConversation(owner, identity('owner').id, 'Before renaming');
    const mine = data as Conversation;

    const renamed = await owner
      .from('ai_conversations')
      .update({ title: 'After renaming' })
      .eq('id', mine.id);
    expect(renamed.error).toBeNull();
    expect((await rawConversation(mine.id))?.title).toBe('After renaming');

    const { data: otherData } = await startConversation(
      helper,
      identity('collaborator').id,
      'Not yours to touch',
    );
    const theirs = otherData as Conversation;

    // No error, no effect: the policy makes the row invisible rather than
    // announcing that it exists.
    await owner.from('ai_conversations').update({ title: 'Hijacked' }).eq('id', theirs.id);
    expect((await rawConversation(theirs.id))?.title).toBe('Not yours to touch');

    await owner.from('ai_conversations').delete().eq('id', theirs.id);
    expect(await rawConversation(theirs.id)).not.toBeNull();

    await owner.from('ai_conversations').delete().eq('id', mine.id);
    expect(await rawConversation(mine.id)).toBeNull();
  });

  it('refuses to move a conversation to another account', async () => {
    const { data } = await startConversation(owner, identity('owner').id, 'Stays with me');
    const mine = data as Conversation;

    const moved = await owner
      .from('ai_conversations')
      .update({ account_id: identity('collaborator').id })
      .eq('id', mine.id);

    expect(moved.error?.message).toMatch(/violates row-level security/i);
    expect((await rawConversation(mine.id))?.account_id).toBe(identity('owner').id);
  });

  it('takes the messages with the conversation when it is deleted', async () => {
    const { data } = await startConversation(owner, identity('owner').id, 'Short lived');
    const mine = data as Conversation;
    await owner.from('ai_messages').insert({
      conversation_id: mine.id,
      role: 'user',
      content: { type: 'input_text', text: 'One turn.' },
    });

    await owner.from('ai_conversations').delete().eq('id', mine.id);

    const { count } = await service
      .from('ai_messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', mine.id);
    expect(count).toBe(0);
  });

  it('refuses a role that is not part of the conversation vocabulary', async () => {
    const { data } = await startConversation(owner, identity('owner').id, 'Bad role');
    const mine = data as Conversation;

    const failure = await owner.from('ai_messages').insert({
      conversation_id: mine.id,
      role: 'narrator',
      content: { type: 'input_text', text: 'Not a role.' },
    });

    expect(failure.error?.message).toMatch(/ai_messages_role_valid|check constraint/i);
  });

  it('shows a restricted account nothing and lets it write nothing', async () => {
    const seen = await pending.from('ai_conversations').select('id');
    expect(seen.data ?? []).toHaveLength(0);

    const written = await pending
      .from('ai_conversations')
      .insert({ account_id: identity('pending').id, title: 'Should never exist' });
    expect(written.error?.message).toMatch(/violates row-level security/i);

    const refused = await denied
      .from('ai_conversations')
      .insert({ account_id: identity('denied').id, title: 'Should never exist' });
    expect(refused.error?.message).toMatch(/violates row-level security/i);
  });
});
