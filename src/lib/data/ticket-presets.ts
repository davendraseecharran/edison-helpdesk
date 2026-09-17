import 'server-only';

/**
 * Reads of the desk's quick tickets.
 *
 * Both run in the caller's own session, so the database decides what comes
 * back: the row policy on `ticket_presets` answers an account that does not
 * work tickets with nothing at all. A failure here is never an error screen —
 * the settings section shows an empty list and the intake form opens blank —
 * because a shortcut that could not be read is not a reason to stop somebody
 * filing a ticket by hand.
 *
 * Memoised for the render pass, so a page and the layout around it ask once
 * between them.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import {
  orderPresets,
  presetFromRow,
  type TicketPreset,
} from '@/lib/domain/ticket-presets';
import { TICKET_CATEGORY_LABELS, type TicketCategory } from '@/lib/domain/types';

export type { TicketPreset };

export const loadTicketPresets = cache(async (): Promise<TicketPreset[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_ticket_presets');
  if (error || !Array.isArray(data)) return [];

  const presets = data
    .map((row) => presetFromRow(row as Record<string, unknown>))
    .filter((preset): preset is TicketPreset => preset !== null);
  // The function already orders them; sorting again costs nothing and keeps
  // the browser's copy and the server's copy in the same order whatever a
  // future caller does to the query.
  return orderPresets(presets);
});

/**
 * One preset by id, for `/tickets/new?preset=…`.
 *
 * An id that names nothing is null rather than an error: the link may have
 * been bookmarked, and a preset somebody deleted since should open the ordinary
 * empty intake form rather than a page that refuses to load.
 */
export async function loadTicketPreset(id: string): Promise<TicketPreset | null> {
  if (id.trim() === '') return null;
  const presets = await loadTicketPresets();
  return presets.find((preset) => preset.id === id) ?? null;
}

/**
 * The category vocabulary and its labels, from the database.
 *
 * `app_category_labels()` is what the tickets themselves are validated against,
 * so the settings select offers exactly the categories a preset may be saved
 * with. The local table is the fallback rather than the source: it mirrors the
 * function, and a screen that could not reach the database should still show a
 * usable list.
 */
export const loadCategoryLabels = cache(async (): Promise<Record<string, string>> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_category_labels');
  if (error || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return TICKET_CATEGORY_LABELS as Record<TicketCategory, string>;
  }

  const labels: Record<string, string> = {};
  for (const [value, label] of Object.entries(data as Record<string, unknown>)) {
    if (typeof label === 'string') labels[value] = label;
  }
  return Object.keys(labels).length > 0 ? labels : TICKET_CATEGORY_LABELS;
});
