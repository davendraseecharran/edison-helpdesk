/**
 * The pairing ticket for a ChatGPT device sign-in.
 *
 * The device flow issues two halves: a `device_auth_id` the service uses to
 * identify the pending sign-in, and a short `user_code` the person types into
 * chatgpt.com. Whoever polls with both halves receives the tokens, and the poll
 * stores them against the account that asked. So the id must never be something
 * a second browser can supply: a colleague reading the code off the initiator's
 * screen could otherwise poll with it and have the approved tokens saved to
 * THEIR account, silently borrowing the other person's ChatGPT plan.
 *
 * The id therefore stays on the server, sealed into an httpOnly cookie:
 *
 *   * Sealed with the same AES-GCM envelope as the stored tokens, keyed by
 *     `AI_TOKEN_KEY`, so the cookie is opaque and cannot be edited undetected.
 *   * Bound to the account id that started the flow, so a cookie copied into
 *     another session opens to a different account and is refused rather than
 *     honoured.
 *   * Stamped with the moment it was issued, so a ticket older than the flow's
 *     own fifteen minutes is refused even if the browser kept the cookie.
 *
 * The browser still sends the user code — it is on screen anyway — and the
 * server pairs it with the id only it holds.
 *
 * No `server-only` import, and nothing here touches a request: the unit suite
 * imports this module directly. The cookie jar itself is handled by
 * `ai-actions.ts`, which IS server-only.
 */

import { decryptJson, encryptJson } from './crypto';

export const DEVICE_COOKIE = 'edison_ai_device';

/** Fifteen minutes, the life of a device code, in seconds and milliseconds. */
export const DEVICE_COOKIE_MAX_AGE = 15 * 60;
const MAX_AGE_MS = DEVICE_COOKIE_MAX_AGE * 1000;

interface DeviceTicket {
  accountId: string;
  deviceAuthId: string;
  /** Epoch milliseconds, from the server that issued it. */
  issuedAt: number;
}

/** The cookie value for a sign-in this account has just started. */
export function sealDeviceAuth(
  accountId: string,
  deviceAuthId: string,
  now: number = Date.now(),
  keyB64 = process.env.AI_TOKEN_KEY,
): string {
  const ticket: DeviceTicket = { accountId, deviceAuthId, issuedAt: now };
  return encryptJson(ticket, keyB64);
}

/**
 * The device auth id inside a cookie, or null.
 *
 * Null for every reason a caller cannot tell apart and should not act on
 * differently: no cookie, a cookie this key does not open, one that was edited,
 * one that belongs to another account, and one that has run out of time. Every
 * one of them means the same thing to the operator — start the sign-in again.
 */
export function openDeviceAuth(
  payload: string | undefined,
  accountId: string,
  now: number = Date.now(),
  keyB64 = process.env.AI_TOKEN_KEY,
): string | null {
  if (typeof payload !== 'string' || payload === '') return null;

  let ticket: unknown;
  try {
    ticket = decryptJson<unknown>(payload, keyB64);
  } catch {
    return null;
  }

  if (typeof ticket !== 'object' || ticket === null) return null;
  const { accountId: owner, deviceAuthId, issuedAt } = ticket as Partial<DeviceTicket>;
  if (typeof owner !== 'string' || owner === '' || owner !== accountId) return null;
  if (typeof deviceAuthId !== 'string' || deviceAuthId === '') return null;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  if (now < issuedAt || now - issuedAt > MAX_AGE_MS) return null;

  return deviceAuthId;
}
