import 'server-only';

/**
 * Authorized reads for self check-in.
 *
 * The officer's reads are the SECURITY DEFINER functions on the signed-in
 * user's client. The public read goes through the nobody client that the
 * public form uses (`anonymousClient`), so what an officer sees when they
 * test the poster's link on their own phone is exactly what a student sees.
 */

import QRCode from 'qrcode';
import { createClient } from '@/lib/supabase/server';
import { appOrigin } from '@/lib/supabase/config';
import { anonymousClient } from '@/lib/data/forms';
import {
  CHECKIN_SLUG,
  checkinFromJson,
  checkinPath,
  isCheckinState,
  publicCheckinFromJson,
  type CheckinSettings,
  type CheckinState,
  type PublicCheckin,
} from '@/lib/domain/checkin';

export async function loadEventCheckin(eventId: string): Promise<CheckinSettings | null> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_event_checkin', { p_event: eventId });
  if (error) return null;
  return checkinFromJson(data);
}

/** Which of a group's events take self check-in, and whether each is open today. */
export async function loadGroupEventCheckins(groupId: string): Promise<Record<string, CheckinState>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_group_event_checkins', { p_group: groupId });
  if (error || !Array.isArray(data)) return {};
  const states: Record<string, CheckinState> = {};
  for (const row of data as Array<Record<string, unknown>>) {
    if (typeof row.event_id === 'string' && isCheckinState(row.state)) states[row.event_id] = row.state;
  }
  return states;
}

export async function loadPublicCheckin(slug: string): Promise<PublicCheckin | null> {
  if (!CHECKIN_SLUG.test(slug)) return null;
  const { data, error } = await anonymousClient().rpc('app_public_checkin', { p_slug: slug });
  if (error) return null;
  return publicCheckinFromJson(data);
}

export function checkinUrl(slug: string): string {
  return new URL(checkinPath(slug), appOrigin()).toString();
}

/**
 * The code a phone scans, drawn on the server so `qrcode` stays out of the
 * browser bundle: an SVG for the screen and the poster, and a PNG large
 * enough to print across a page for "Download QR". Error correction is H, so
 * a poster that has been folded, taped over at a corner or photographed at an
 * angle still reads.
 */
export async function checkinCode(slug: string): Promise<{ url: string; svg: string; png: string }> {
  const url = checkinUrl(slug);
  const [svg, png] = await Promise.all([
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'H' }),
    QRCode.toDataURL(url, { type: 'image/png', margin: 4, width: 1200, errorCorrectionLevel: 'H' }),
  ]);
  return { url, svg, png };
}
