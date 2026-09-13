import 'server-only';

/**
 * The linked ChatGPT account, stored where no session can reach it.
 *
 * `ai_connections` has row-level security on and deliberately no policies, and
 * every privilege is revoked from anon and authenticated, so this module uses
 * the service-role client — the one documented exception in `admin.ts`'s rules,
 * because a technician genuinely cannot write this row on their own behalf.
 * Two things keep that narrow:
 *
 *   1. Every function here is keyed by an `accountId` the CALLER has already
 *      verified through `activeAccount()`. Nothing takes an id from a request
 *      body, and nothing here reads a row it was not asked for by id.
 *   2. What is stored is already ciphertext. This module encrypts before the
 *      write and decrypts after the read, so the service key alone does not
 *      open a connection either.
 *
 * Refresh is lazy and happens on load: a token within five minutes of expiry is
 * exchanged and written back before it is handed out, which is what stops a long
 * conversation dying halfway through a tool call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '@/lib/supabase/admin';
import { decryptJson, encryptJson } from './crypto';
import { claimsFromToken, refreshTokens, type CodexTokens } from './codex-auth';

/** How close to expiry is close enough to renew first. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface LoadedConnection {
  tokens: CodexTokens;
  chatgptAccountId: string;
}

function client(): SupabaseClient {
  return adminClient();
}

/**
 * The account id and label come from the tokens rather than from the caller, so
 * a connection can never be filed under somebody else's ChatGPT account.
 */
function labelFor(tokens: CodexTokens) {
  const fromId = claimsFromToken(tokens.idToken);
  // Some issuers put the auth claim only on the access token; read both rather
  // than showing a connected account with no name against it.
  const fromAccess = claimsFromToken(tokens.accessToken);
  return {
    chatgptAccountId: fromId.chatgptAccountId ?? fromAccess.chatgptAccountId,
    email: fromId.email ?? fromAccess.email,
    planType: fromId.planType ?? fromAccess.planType,
  };
}

export async function saveConnection(accountId: string, tokens: CodexTokens): Promise<void> {
  const label = labelFor(tokens);
  const supabase = client();

  // `connected_at` belongs to the FIRST link and must survive a refresh, so the
  // update path never touches it. An upsert would reset it on every renewal and
  // the panel would report that a months-old connection was made a minute ago.
  const { data: existing, error: readError } = await supabase
    .from('ai_connections')
    .select('account_id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const ciphertext = encryptJson(tokens);
  if (existing) {
    const { error } = await supabase
      .from('ai_connections')
      .update({
        ciphertext,
        chatgpt_account_id: label.chatgptAccountId,
        account_email: label.email,
        plan_type: label.planType,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from('ai_connections').insert({
    account_id: accountId,
    provider: 'codex',
    ciphertext,
    chatgpt_account_id: label.chatgptAccountId,
    account_email: label.email,
    plan_type: label.planType,
  });
  if (error) throw new Error(error.message);
}

/**
 * The usable token set, or null when this account has linked nothing.
 *
 * A stored row that cannot be decrypted — the key was rotated, or the column was
 * edited — is treated as "not connected" rather than as an error, because the
 * only thing the operator can do about it is connect again, and that is what the
 * panel then offers.
 */
export async function loadConnection(accountId: string): Promise<LoadedConnection | null> {
  const supabase = client();
  const { data, error } = await supabase
    .from('ai_connections')
    .select('ciphertext, chatgpt_account_id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  let tokens: CodexTokens;
  try {
    tokens = decryptJson<CodexTokens>(data.ciphertext as string);
  } catch {
    return null;
  }
  if (typeof tokens?.accessToken !== 'string' || typeof tokens?.refreshToken !== 'string') {
    return null;
  }

  const expiresAt = Date.parse(tokens.expiresAt ?? '');
  const stale = !Number.isFinite(expiresAt) || expiresAt - Date.now() <= REFRESH_WINDOW_MS;
  if (stale) {
    const renewed = await refreshTokens(tokens);
    await saveConnection(accountId, renewed);
    tokens = renewed;
  }

  const chatgptAccountId =
    labelFor(tokens).chatgptAccountId ?? (data.chatgpt_account_id as string | null) ?? '';
  return { tokens, chatgptAccountId };
}

export async function disconnect(accountId: string): Promise<void> {
  const { error } = await client().from('ai_connections').delete().eq('account_id', accountId);
  if (error) throw new Error(error.message);
}

/**
 * Records that the connection was used. Failure is swallowed on purpose: this
 * is a timestamp for the settings screen, and losing it must never be the reason
 * a reply does not arrive.
 */
export async function touchUsed(accountId: string): Promise<void> {
  try {
    await client()
      .from('ai_connections')
      .update({ last_used_at: new Date().toISOString() })
      .eq('account_id', accountId);
  } catch {
    // Deliberately ignored. See above.
  }
}
