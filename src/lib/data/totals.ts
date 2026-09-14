import 'server-only';

/**
 * The three numbers on the sign-in screen.
 *
 * `app_public_totals()` is the one function in the schema `anon` may call. It
 * takes no argument and returns three bigints — machines in the inventory,
 * people in the directory, tickets resolved — so a signed-out caller learns
 * three magnitudes and cannot use it to ask about any particular row. The
 * cookie-bound client is still what makes the call: somebody already signed in
 * reaching /login gets the same answer, through the same policy-less path.
 *
 * A failure here is never an error the reader should see. The sign-in form is
 * the point of the page, and it works whether or not a count arrives, so a
 * database that is unreachable, mid-migration or empty simply returns null and
 * the panel falls back to its tagline.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export interface PublicTotals {
  devices: number;
  people: number;
  ticketsResolved: number;
}

interface PublicTotalsRow {
  devices: number | string | null;
  people: number | string | null;
  tickets_resolved: number | string | null;
}

/** A bigint arrives as a string once it passes 2^53; treat anything unusable as zero. */
function toCount(value: number | string | null | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export const loadPublicTotals = cache(async function loadPublicTotals(): Promise<PublicTotals | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('app_public_totals');
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as PublicTotalsRow | undefined;
    if (!row) return null;
    const totals = {
      devices: toCount(row.devices),
      people: toCount(row.people),
      ticketsResolved: toCount(row.tickets_resolved),
    };
    // Nothing to say is better than three zeros dressed up as a headline.
    return totals.devices + totals.people + totals.ticketsResolved > 0 ? totals : null;
  } catch {
    return null;
  }
});
