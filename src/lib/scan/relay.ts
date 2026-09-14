/**
 * The rules the phone scanner relay is made of, with nothing around them.
 *
 * Four decisions live here rather than in a component, because each one is
 * made in more than one place and each one is a rule rather than a rendering:
 *
 *   - What `?next=` on the login page is allowed to be. The sign-in path and
 *     the Google callback both have to answer that question, and they must
 *     answer it identically. The answer is "one of this feature's own pages,
 *     and nothing else": not a full URL, not a protocol-relative `//host`,
 *     not another route of this application.
 *   - What a session id looks like, so a path segment out of the address bar
 *     is never handed to the database or pasted back into a redirect.
 *   - Which barcode symbologies are recorded. The phone reports whatever its
 *     detector was built with; anything outside the list the session asked
 *     for is stored as "no format" rather than as a string from the browser.
 *   - How long the same code stays ignored after it is sent. A phone left
 *     face-up reads one barcode until its battery dies; this is the client's
 *     half of the answer to that (the database's half is the 500-scan cap).
 *
 * Pure, dependency-free and imported from both the server and the browser:
 * `src/lib/auth/actions.ts` and `/scan/[session]` are on one side of it and
 * `PhoneScanner` on the other.
 */

/** A session id: exactly the uuid Postgres generated, lowercase. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Is this the id of a pairing session?
 *
 * Everything that reaches the database or a redirect goes through here first.
 * Uppercase is refused rather than folded: every id this application produces
 * comes from `gen_random_uuid()` and is lowercase, so an uppercase one was
 * typed by somebody, and there is no reason to be helpful about that. That is
 * why this keeps its own pattern instead of calling `isUuid` from `lib/guards`,
 * which folds case for the ids people and the assistant type.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The phone page for one session. The only path `isScanPath` accepts. */
export function scanPath(session: string): string {
  return `/scan/${session}`;
}

/**
 * Is this a `?next=` the login page may send somebody to after signing in?
 *
 * The allow-list is one shape: this feature's own phone page. A technician
 * whose phone opened `/scan/<id>` while signed out has to come back to that
 * exact page or the pairing is lost, and no other screen in the application
 * has that problem — every other route is reachable from the queue.
 *
 * So this is not a general redirect helper and must not become one. It takes
 * a relative path only, and the caller resolves it against the application's
 * own origin, which means no `next` can ever name another host: `//evil.test`
 * has no `/scan/` prefix, `https://evil.test` has no leading slash, and a
 * uuid is the only thing allowed after the prefix. JavaScript anchors `$` at
 * the true end of the string, so a trailing newline does not slip past it.
 */
export function isScanPath(next: unknown): next is string {
  if (typeof next !== 'string' || !next.startsWith('/scan/')) return false;
  return isSessionId(next.slice('/scan/'.length));
}

/**
 * Where a Google sign-in should land when it was interrupted on its way to
 * the phone scanner.
 *
 * A COOKIE rather than a query parameter on the provider's `redirectTo`, and
 * that is not a stylistic choice: the redirect target is checked against an
 * allow-list of EXACT urls in the Supabase project's configuration, so a
 * query string that differs on every sign-in could not be allow-listed in the
 * local config and the hosted project both. Keeping the destination on this
 * origin also means it never travels to the provider at all.
 *
 * Written short-lived and httpOnly by the sign-in action, read and cleared by
 * `/auth/callback`, and passed through `isScanPath` at both ends. The name
 * lives here, with the rule, rather than in either of them: a `'use server'`
 * module may export async functions and nothing else.
 */
export const SCAN_NEXT_COOKIE = 'edison-scan-next';

/**
 * The symbologies the phone is asked to read: the formats asset tags, serial
 * numbers and printed labels actually come in, plus the two square codes a
 * manufacturer's sticker uses. Ordered as the detector is configured.
 */
export const SCAN_FORMATS = [
  'code_128',
  'code_39',
  'ean_13',
  'ean_8',
  'upc_a',
  'qr_code',
  'data_matrix',
] as const;

export type ScanFormat = (typeof SCAN_FORMATS)[number];

/**
 * The format to record for a detection, or null for "not one of ours".
 *
 * `BarcodeDetector` is asked for the list above, but the value it hands back
 * is a string from the browser, and a browser that reports something else
 * (or nothing) should not put that string in the database. `null` is already
 * the column's value for a code that was typed by hand, and it is the right
 * answer here too: the code is what matters, the symbology is a footnote.
 */
export function scanFormat(raw: unknown): ScanFormat | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (SCAN_FORMATS as readonly string[]).includes(value) ? (value as ScanFormat) : null;
}

/**
 * How long the same code is ignored after it has been sent, in milliseconds.
 *
 * Long enough that a camera held steady over one label sends it once; short
 * enough that a technician who deliberately scans the same asset tag twice
 * (two tickets, the same laptop) is not left wondering why nothing happened.
 */
export const DEDUPE_WINDOW_MS = 1500;

/** The last code this phone sent, and when. */
export interface LastScan {
  code: string;
  at: number;
}

/**
 * Should this reading be sent?
 *
 * Only the immediately preceding code is remembered, not every code of the
 * session: scanning a shelf of laptops means A, B, A again when a technician
 * checks their work, and refusing the third one would be wrong. What is being
 * suppressed is one label under a running camera, which is always the code
 * that came immediately before.
 */
export function shouldSend(code: string, last: LastScan | null, now: number): boolean {
  if (code.trim() === '') return false;
  if (!last || last.code !== code) return true;
  return now - last.at >= DEDUPE_WINDOW_MS;
}
