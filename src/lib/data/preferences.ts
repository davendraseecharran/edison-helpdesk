import 'server-only';

/**
 * Reads of the signed-in account's own settings.
 *
 * Both reads run in the caller's session, so the database decides what comes
 * back: `app_my_preferences()` re-derives the actor and creates the default row
 * the first time it is asked for, and `app_my_ai_connection()` returns nothing
 * at all to a caller who is not active. A failure here is never an error screen
 * — the settings page still renders, showing the defaults and no connection —
 * because a preference that could not be read is not a reason to lock somebody
 * out of the rest of the page.
 *
 * Memoised for the render pass, so the layout and the settings page inside it
 * ask once between them.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import {
  DEFAULT_PREFERENCES,
  preferencesFromRow,
  type Preferences,
} from '@/lib/domain/preferences';

export type { Preferences };

/** What a session may learn about its linked ChatGPT account. Never the token. */
export interface AiConnectionView {
  connected: boolean;
  accountEmail: string | null;
  /** The ChatGPT plan the account is on, as the id token reported it. */
  planType: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
}

/**
 * The one note the whole school shares with the assistant.
 *
 * Read through an RPC rather than off the table, the same way preferences are,
 * because the screen shows WHO last edited it and a NetRider cannot read another
 * account's name for themselves. `app_assistant_notes_shared()` is what decides
 * how much of that account is answered with: one display name.
 */
export interface SharedAssistantNotes {
  body: string;
  /** Who last edited it, or null when nobody has. */
  updatedByName: string | null;
  updatedAt: string | null;
}

export const NO_SHARED_NOTES: SharedAssistantNotes = {
  body: '',
  updatedByName: null,
  updatedAt: null,
};

export const NO_AI_CONNECTION: AiConnectionView = {
  connected: false,
  accountEmail: null,
  planType: null,
  connectedAt: null,
  lastUsedAt: null,
};

export const loadPreferences = cache(async (): Promise<Preferences> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_my_preferences');
  if (error || !data) return DEFAULT_PREFERENCES;
  // The function returns one composite row; PostgREST may hand it back on its
  // own or inside a single-element array depending on how it is invoked.
  return preferencesFromRow(Array.isArray(data) ? data[0] : data);
});

export const loadSharedAssistantNotes = cache(async (): Promise<SharedAssistantNotes> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_assistant_notes_shared');
  // No rows is the answer a caller who is not active gets, and an empty note is
  // the answer before anybody has written one. Both render the same way, which
  // is the right outcome: a settings screen that could not read the shared note
  // shows an empty box rather than an error.
  if (error || !Array.isArray(data) || data.length === 0) return NO_SHARED_NOTES;

  const row = data[0] as {
    body: string | null;
    updated_by_name: string | null;
    updated_at: string | null;
  };

  return {
    body: typeof row.body === 'string' ? row.body : '',
    updatedByName: row.updated_by_name ?? null,
    updatedAt: row.updated_at ?? null,
  };
});

export const loadAiConnection = cache(async (): Promise<AiConnectionView> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_my_ai_connection');
  if (error || !Array.isArray(data) || data.length === 0) return NO_AI_CONNECTION;

  const row = data[0] as {
    connected: boolean;
    account_email: string | null;
    plan_type: string | null;
    connected_at: string | null;
    last_used_at: string | null;
  };

  return {
    connected: row.connected === true,
    accountEmail: row.account_email ?? null,
    planType: row.plan_type ?? null,
    connectedAt: row.connected_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
  };
});
