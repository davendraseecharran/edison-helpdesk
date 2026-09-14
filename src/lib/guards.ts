/**
 * The three checks that were being written out again in every file that reads
 * something it did not create: an RPC result, a stream frame, a request body, a
 * query string.
 *
 * They were identical copies, which is worse than it sounds — a narrowing this
 * small is exactly the kind that gets "improved" in one copy and not the other
 * five, and then two files disagree about what a record is. One definition, one
 * behaviour, one place to read.
 *
 * Pure and dependency-free, so the server, the browser and the unit suite can
 * all import it.
 */

/**
 * A plain object, and not an array.
 *
 * `typeof null === 'object'` and arrays are objects too, so both are ruled out
 * before the type is narrowed. The values stay `unknown`: knowing that a key
 * exists is not knowing what is behind it.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The string that was there, or an empty one.
 *
 * Used where a missing field and a field holding a number, null or an object all
 * mean the same thing to the screen: nothing to show. It never stringifies —
 * "[object Object]" in a ticket title helps nobody.
 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A uuid, in either case.
 *
 * Case-folding is deliberate here: these ids are typed by people and quoted
 * back by a language model, and Postgres accepts either case for the `uuid`
 * type. The scanner's session ids are the one exception — `isSessionId` in
 * `lib/scan/relay.ts` refuses uppercase on purpose, and says why.
 *
 * Nothing is trimmed: a caller that may be holding surrounding space trims it
 * first and passes on the trimmed value, so the id that was checked is the id
 * that travels.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
