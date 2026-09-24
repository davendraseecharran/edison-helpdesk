'use server';

/**
 * The one thing a stranger with a check-in link can do: say who they are.
 *
 * It runs as NOBODY — the anon key, no session — whether or not the phone
 * holds a helpdesk session, like the public form. The caller is forwarded to
 * the database as `x-edison-client`, where it is hashed before it is counted.
 *
 * The caller is the client address AND a random id this page keeps in a
 * cookie. A school puts every student on one public address, and the throttle
 * counted per address alone would lock out the thirtieth student because
 * twenty-nine classmates checked in first. A caller who clears the cookie only
 * gets a new bucket; the per-link ceiling in the database still holds.
 *
 * The honeypot is checked here, and a filled one is answered exactly like a
 * name nobody has, so a bot learns nothing.
 */

import { cookies, headers } from 'next/headers';
import { anonymousClient } from '@/lib/data/forms';
import {
  CHECKIN_SLUG,
  checkinMessage,
  foldId,
  foldName,
  isCheckinIdentity,
  isCheckinRefusal,
  type CheckinIdentity,
  type CheckinInput,
  type CheckinResult,
} from '@/lib/domain/checkin';

const DEVICE_COOKIE = 'edison_checkin_device';
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365;

async function callerKey(): Promise<string> {
  const incoming = await headers();
  const address =
    incoming.get('x-forwarded-for')?.split(',')[0]?.trim() || incoming.get('x-real-ip')?.trim() || 'unknown';
  const jar = await cookies();
  let device = jar.get(DEVICE_COOKIE)?.value ?? '';
  if (!/^[0-9a-f-]{36}$/.test(device)) {
    device = crypto.randomUUID();
    jar.set(DEVICE_COOKIE, device, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/c',
      maxAge: DEVICE_MAX_AGE,
    });
  }
  return `${address}|${device}`;
}

function clean(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export async function publicCheckinAction(
  slug: string,
  input: CheckinInput,
  context: { identity: CheckinIdentity; groupName: string; mode: 'osis' | 'name' },
  honeypot: string,
): Promise<CheckinResult> {
  const identity = isCheckinIdentity(context.identity) ? context.identity : 'either';
  const mode = context.mode === 'osis' ? 'osis' : 'name';
  const say = { identity, groupName: clean(context.groupName, 120), mode } as const;

  if (!CHECKIN_SLUG.test(clean(slug, 20))) {
    return { ok: false, reason: 'missing', message: checkinMessage('missing', say) };
  }
  if (clean(honeypot, 200) !== '') {
    return { ok: false, reason: 'no_match', message: checkinMessage('no_match', say) };
  }

  // Only what the page asked for goes up. With `either` on the OSIS, a name
  // left in the boxes the person switched away from is not sent; on the name,
  // an OSIS is sent only when they added one because the name was shared.
  const sendOsis = identity !== 'name';
  const sendName = identity !== 'osis' && !(identity === 'either' && mode === 'osis');
  const osis = sendOsis ? clean(input?.osis, 40) : '';
  const first = sendName ? clean(input?.first, 80) : '';
  const last = sendName ? clean(input?.last, 80) : '';
  if (foldId(osis) === '' && (foldName(first) === '' || foldName(last) === '')) {
    return { ok: false, reason: 'incomplete', message: checkinMessage('incomplete', say) };
  }

  const client = anonymousClient({ 'x-edison-client': await callerKey() });
  const { data, error } = await client.rpc('app_public_checkin_submit', {
    p_slug: slug,
    p_osis: osis,
    p_first: first,
    p_last: last,
  });
  if (error || !data || typeof data !== 'object') {
    return { ok: false, reason: 'error', message: checkinMessage('error', say) };
  }

  const row = data as Record<string, unknown>;
  if (row.ok === true) {
    return {
      ok: true,
      outcome: row.outcome === 'already' ? 'already' : 'present',
      firstName: typeof row.first_name === 'string' ? row.first_name : '',
    };
  }
  const reason = isCheckinRefusal(row.reason) ? row.reason : 'error';
  return { ok: false, reason, message: checkinMessage(reason, say) };
}
