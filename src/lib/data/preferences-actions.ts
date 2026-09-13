'use server';

/**
 * Changes an account makes to itself: its display name and its settings.
 *
 * Both call an RPC with the signed-in user's own JWT, so the database
 * re-derives the actor from auth.uid() through `app_require_actor()` and refuses
 * a session that is inactive, mid-recovery or superseded. Nothing here trusts an
 * account id from the browser: there is no account parameter to trust. The patch
 * is narrowed to the five keys the RPC whitelists before it is sent, which saves
 * a round trip on an obvious mistake without being the thing that enforces it.
 *
 * Only the settings that belong to one person live here. Role, status and
 * everything an administrator decides about an account stay in
 * `account-actions.ts` behind their own admin checks.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { displayNameError, preferencePatch, type PreferencePatch } from '@/lib/domain/preferences';
import type { ActionResult } from '@/lib/data/actions';

/** Fast fail for a session that plainly cannot write. The database decides for real. */
async function requireActiveSession(): Promise<ActionResult | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }
  return null;
}

/**
 * The theme lives in the shell and the name is rendered on every history entry,
 * so a saved setting has to reach every server-rendered surface, not just the
 * settings page.
 */
function revalidateEverything(): void {
  revalidatePath('/', 'layout');
}

export async function updatePreferencesAction(patch: PreferencePatch): Promise<ActionResult> {
  const narrowed = preferencePatch(patch);
  if (!narrowed.ok) return { ok: false, error: narrowed.error };

  const rejected = await requireActiveSession();
  if (rejected) return rejected;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_update_preferences', { p_patch: narrowed.patch });
  if (error) return { ok: false, error: error.message };

  revalidateEverything();
  return { ok: true };
}

export async function updateDisplayNameAction(name: string): Promise<ActionResult> {
  const invalid = displayNameError(name);
  if (invalid) return { ok: false, error: invalid };

  const rejected = await requireActiveSession();
  if (rejected) return rejected;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_update_display_name', { p_name: name.trim() });
  if (error) return { ok: false, error: error.message };

  revalidateEverything();
  return { ok: true };
}
