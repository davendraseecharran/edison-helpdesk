'use server';

/**
 * The phone scanner relay, from the browser's side.
 *
 * Five actions over the five reviewed RPCs, and nothing else: the pairing is
 * opened and stopped, a code is recorded, the codes are read back, and the
 * session is asked whether it is still live. Every one of them runs as the
 * signed-in user, so the database re-derives the actor from `auth.uid()` and
 * decides for itself whose session this is. Nothing here compares an account
 * id, and nothing here trusts the session id in the URL: a photographed QR
 * code is not a credential, and the database says so by returning the same
 * words for another technician's session as for one that never existed.
 *
 * Deliberately NOT calling `revalidatePath`, which every ticket action does:
 * a scan changes no page's data, and re-rendering the whole layout on each
 * barcode would turn a relay into a page reload once a second.
 *
 * The QR code is rendered here rather than in the browser so `qrcode` stays
 * out of the client bundle, and it is rendered from the application's own
 * configured origin so the pairing URL can never be pointed somewhere else.
 */

import QRCode from 'qrcode';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { appOrigin } from '@/lib/supabase/config';
import { isSessionId, scanPath } from '@/lib/scan/relay';

/** One barcode, as the desktop and the phone both show it. */
export interface ScanEventView {
  id: string;
  code: string;
  format: string | null;
  scannedAt: string;
}

/** Whether a pairing still takes scans, for the phone's status line. */
export interface ScanSessionView {
  id: string;
  label: string | null;
  expiresAt: string;
  endedAt: string | null;
  active: boolean;
}

export type StartScanResult =
  | {
      ok: true;
      id: string;
      /** ISO instant the pairing stops accepting scans on its own. */
      expiresAt: string;
      /** The pairing URL drawn as an SVG, ready to be put on screen. */
      qrSvg: string;
      /** The same URL in words, for somebody who would rather type it. */
      url: string;
    }
  | { ok: false; error: string };

export interface ScanResult {
  ok: boolean;
  error?: string;
}

const NOT_SIGNED_IN = 'Your session cannot scan. Sign in again.';
const NO_SESSION = 'That scan session is not available to this account.';

/**
 * The signed-in Supabase client, or null when this request has no account
 * that may act. A fast fail for an unusable session, not the security
 * boundary: every RPC below re-checks identity inside the database.
 */
async function activeClient() {
  const actor = await loadActor();
  if (actor.kind !== 'active') return null;
  return createClient();
}

/**
 * Opens a pairing and draws it.
 *
 * `label` is what the desktop was asking for — "Serial number", "Asset tag" —
 * and is shown on the phone so a technician filling two fields knows which
 * one this camera is feeding. The database trims it and refuses one over 80
 * characters.
 */
export async function startScanSessionAction(label?: string): Promise<StartScanResult> {
  const supabase = await activeClient();
  if (!supabase) return { ok: false, error: NOT_SIGNED_IN };

  const { data, error } = await supabase.rpc('app_start_scan_session', {
    p_label: typeof label === 'string' && label.trim() !== '' ? label.trim() : null,
  });
  if (error) return { ok: false, error: error.message };

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id?: unknown; expires_at?: unknown }
    | null;
  const id = typeof row?.id === 'string' ? row.id : '';
  if (!isSessionId(id)) {
    return { ok: false, error: 'The pairing could not be opened. Try again.' };
  }

  // Built from the configured origin, never from a request header: the phone
  // has to reach this application, and only this application.
  const url = new URL(scanPath(id), appOrigin()).toString();
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0 });

  return {
    ok: true,
    id,
    expiresAt: typeof row?.expires_at === 'string' ? row.expires_at : '',
    qrSvg,
    url,
  };
}

/** Stops a pairing. Both ends offer this, and pressing it twice is not an error. */
export async function endScanSessionAction(session: string): Promise<ScanResult> {
  if (!isSessionId(session)) return { ok: false, error: NO_SESSION };

  const supabase = await activeClient();
  if (!supabase) return { ok: false, error: NOT_SIGNED_IN };

  const { error } = await supabase.rpc('app_end_scan_session', { p_session: session });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Records one barcode against a live pairing.
 *
 * The code is passed through as it was read: the database trims it and cuts
 * it to 200 characters rather than refusing a long misread, so a technician
 * sees what the camera got and can reject it themselves.
 */
export async function recordScanAction(
  session: string,
  code: string,
  format?: string | null,
): Promise<ScanResult> {
  if (!isSessionId(session)) return { ok: false, error: NO_SESSION };

  const supabase = await activeClient();
  if (!supabase) return { ok: false, error: NOT_SIGNED_IN };

  const { error } = await supabase.rpc('app_record_scan', {
    p_session: session,
    p_code: typeof code === 'string' ? code : '',
    p_format: typeof format === 'string' && format !== '' ? format : null,
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * The scans of a pairing, oldest first.
 *
 * `after` is the newest instant the caller already holds, and passing it is
 * not optional in practice: the RPC returns the OLDEST 500, so a poll that
 * asks for everything each time would eventually stop seeing new codes. The
 * relay hook always passes it.
 *
 * Never throws. This is polled every couple of seconds behind a dialog that
 * must not fall over because one request did.
 */
export async function scanEventsAction(
  session: string,
  after?: string | null,
): Promise<ScanEventView[]> {
  if (!isSessionId(session)) return [];

  try {
    const supabase = await activeClient();
    if (!supabase) return [];

    const { data, error } = await supabase.rpc('app_scan_events', {
      p_session: session,
      p_after: after ?? null,
    });
    if (error) {
      console.error(`app_scan_events failed (${error.code ?? 'no code'})`);
      return [];
    }

    const events: ScanEventView[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const entry = row as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.code !== 'string') continue;
      events.push({
        id: entry.id,
        code: entry.code,
        format: typeof entry.format === 'string' ? entry.format : null,
        scannedAt: typeof entry.scanned_at === 'string' ? entry.scanned_at : '',
      });
    }
    return events;
  } catch (cause) {
    console.error(`scanEventsAction failed (${cause instanceof Error ? cause.name : 'unknown'})`);
    return [];
  }
}

/**
 * Whether a pairing is still live, for the phone's status line.
 *
 * Returns null for a session that has been swept, never existed, or belongs
 * to another account — deliberately the same answer for all three, which is
 * the answer the database gives.
 */
export async function scanSessionAction(session: string): Promise<ScanSessionView | null> {
  if (!isSessionId(session)) return null;

  try {
    const supabase = await activeClient();
    if (!supabase) return null;

    const { data, error } = await supabase.rpc('app_scan_session', { p_session: session });
    if (error) {
      console.error(`app_scan_session failed (${error.code ?? 'no code'})`);
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== 'string') return null;
    return {
      id: row.id,
      label: typeof row.label === 'string' ? row.label : null,
      expiresAt: typeof row.expires_at === 'string' ? row.expires_at : '',
      endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
      active: row.active === true,
    };
  } catch (cause) {
    console.error(`scanSessionAction failed (${cause instanceof Error ? cause.name : 'unknown'})`);
    return null;
  }
}
