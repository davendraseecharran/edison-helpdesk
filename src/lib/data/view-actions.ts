'use server';

/**
 * Saved views, written where they belong.
 *
 * One action, one RPC. `app_set_saved_views` replaces the whole list, rebuilds
 * every element from the four fields this application understands, and refuses
 * a path that is not in-app — so nothing a page script invents can be stored
 * and handed back to a later render as a link.
 *
 * The list is narrowed here as well, which saves a round trip on an obvious
 * mistake without being the thing that enforces it. The browser keeps its own
 * copy either way: a NetRider on a machine that cannot reach the database for a
 * minute should still have their chips.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { parseSavedViews, type SavedView } from '@/lib/domain/saved-views';
import type { ActionResult } from '@/lib/data/actions';

export async function saveViewsAction(views: SavedView[]): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_set_saved_views', {
    p_views: parseSavedViews(views),
  });
  if (error) return { ok: false, error: error.message };

  // The list is read in the layout, so every page render sees the new chips.
  revalidatePath('/', 'layout');
  return { ok: true };
}
