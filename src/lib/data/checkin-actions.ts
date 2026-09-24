'use server';

/**
 * Turning self check-in on and off, and the two reads the event's page makes
 * while it is on: the code for the poster, and the roll as people arrive.
 *
 * Every call is a SECURITY DEFINER function on the signed-in user's own
 * client, so who may do what is the database's to decide: any active account
 * runs the chapter's own business, exactly as it takes the register.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { checkinCode, loadEventCheckin } from '@/lib/data/checkin';
import { loadEventRoll, type RollEntry } from '@/lib/data/group-events';
import {
  checkinFromJson,
  type CheckinCodeResult,
  type CheckinPatch,
  type CheckinSaveResult,
  type CheckinSettings,
} from '@/lib/domain/checkin';

const SESSION_ENDED = 'Your session is not able to make changes. Sign in again.';

function sentence(patch: CheckinPatch, settings: CheckinSettings): string {
  if (patch.open === true) {
    return settings.state === 'open'
      ? 'Self check-in is open.'
      : settings.state === 'early'
        ? 'Self check-in is on. It opens on the day of the event.'
        : 'Self check-in is on, but the event day has passed.';
  }
  if (patch.open === false) return 'Self check-in is closed.';
  return 'Check-in settings saved.';
}

export async function setEventCheckinAction(eventId: string, patch: CheckinPatch): Promise<CheckinSaveResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SESSION_ENDED };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_set_event_checkin', {
    p_event: eventId,
    p_open: patch.open ?? null,
    p_identity: patch.identity ?? null,
    p_walk_ins: patch.walkIns ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const settings = checkinFromJson(data);
  if (!settings) return { ok: false, error: 'That did not go through. Nothing changed.' };

  revalidatePath('/', 'layout');
  return { ok: true, settings, message: sentence(patch, settings) };
}

/** The link and its code, for the event's panel and the poster's download. */
export async function checkinCodeAction(eventId: string): Promise<CheckinCodeResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SESSION_ENDED };
  const settings = await loadEventCheckin(eventId);
  if (!settings) return { ok: false, error: 'Self check-in is not on for this event.' };
  const code = await checkinCode(settings.slug);
  return { ok: true, ...code };
}

/**
 * The register as it stands, for the event's page to keep current while
 * people check themselves in. Null when the look failed: the page keeps what
 * it has rather than blanking.
 */
export async function liveRollAction(
  eventId: string,
): Promise<{ roll: RollEntry[]; checkin: CheckinSettings | null } | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return null;
  const [roll, checkin] = await Promise.all([loadEventRoll(eventId), loadEventCheckin(eventId)]);
  if (roll === null) return null;
  return { roll, checkin };
}

/** One event's self check-in, for the group's list, which opens it in a sheet. */
export async function eventCheckinAction(eventId: string): Promise<CheckinSettings | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return null;
  return loadEventCheckin(eventId);
}
