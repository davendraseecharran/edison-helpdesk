'use server';

/**
 * The desk's quick tickets, read and written.
 *
 * Every write is one RPC with the signed-in user's own JWT, so the database
 * re-derives the actor through `app_require_actor()`, refuses an account that
 * does not work tickets, checks the same vocabularies the tickets table
 * carries, holds the list to twelve and records what changed. Nothing here
 * trusts a field from the browser; the narrowing below saves a round trip on an
 * obvious mistake without being the thing that enforces it.
 *
 * The list is shared by the whole desk, so a change has to reach every
 * server-rendered surface rather than only the settings page: `revalidatePath`
 * at the layout, exactly as a saved view does.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { loadTicketPresets } from '@/lib/data/ticket-presets';
import type { ActionResult } from '@/lib/data/actions';
import {
  movePreset,
  orderPresets,
  presetError,
  type TicketPreset,
} from '@/lib/domain/ticket-presets';

/** What the settings form sends. A null id is a new quick ticket. */
export interface TicketPresetInput {
  id: string | null;
  name: string;
  title: string;
  issue: string;
  category: string;
  priority: string;
  location: string;
  position?: number | null;
}

/** Fast fail for a session that plainly cannot write. The database decides for real. */
async function requireActiveSession(): Promise<ActionResult | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }
  return null;
}

/**
 * The list, for a browser that needs it outside a server render.
 *
 * The top bar's menu and the palette both want the presets on the client, and
 * neither is rendered on the server with them in hand. One call fills a cache
 * the browser keeps for the page's life (`src/lib/presets/store.ts`), so this
 * is asked once rather than on every keystroke.
 */
export async function listTicketPresetsAction(): Promise<TicketPreset[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return [];
  return loadTicketPresets();
}

export async function saveTicketPresetAction(input: TicketPresetInput): Promise<ActionResult> {
  const invalid = presetError({
    name: input.name,
    title: input.title,
    issue: input.issue,
    category: input.category as TicketPreset['category'],
    priority: input.priority as TicketPreset['priority'],
    location: input.location,
  });
  if (invalid) return { ok: false, error: invalid };

  const rejected = await requireActiveSession();
  if (rejected) return rejected;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_save_ticket_preset', {
    p_id: input.id,
    p_name: input.name.trim(),
    p_title: input.title.trim(),
    p_issue: input.issue.trim(),
    p_category: input.category,
    p_priority: input.priority,
    p_location: input.location.trim(),
    p_position: input.position ?? null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true, message: input.id ? 'Quick ticket saved.' : 'Quick ticket added.' };
}

export async function deleteTicketPresetAction(id: string): Promise<ActionResult> {
  const rejected = await requireActiveSession();
  if (rejected) return rejected;

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_delete_ticket_preset', { p_id: id });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Quick ticket deleted.' };
}

/**
 * One preset, one place up or down.
 *
 * The new order is worked out from the list as the database has it rather than
 * from what the browser was showing, so two people reordering at once cannot
 * write positions derived from a stale list. Only the rows whose position
 * actually changes are written — usually two — and each goes through the same
 * writer a normal edit does.
 */
export async function moveTicketPresetAction(
  id: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  const rejected = await requireActiveSession();
  if (rejected) return rejected;

  const presets = orderPresets(await loadTicketPresets());
  const moves = movePreset(presets, id, direction);
  // Already at the end it was moved towards: nothing to write, and nothing
  // went wrong.
  if (moves.length === 0) return { ok: true };

  const supabase = await createClient();
  for (const move of moves) {
    const preset = presets.find((one) => one.id === move.id);
    if (!preset) continue;
    const { error } = await supabase.rpc('app_save_ticket_preset', {
      p_id: preset.id,
      p_name: preset.name,
      p_title: preset.title,
      p_issue: preset.issue,
      p_category: preset.category,
      p_priority: preset.priority,
      p_location: preset.location,
      p_position: move.position,
    });
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}
