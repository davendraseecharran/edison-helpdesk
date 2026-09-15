/**
 * Where a scanned code goes.
 *
 * A barcode is not a search. A technician holding a Chromebook and pointing a
 * camera at its asset tag has already decided which machine they mean, and the
 * only useful answer is that machine's page. Until now the code went into the
 * lookup field instead, so the operator scanned, waited for a search, and then
 * picked the single result out of a list of one.
 *
 * `app_lookup_inventory_code` (20260914130000) answers the question properly:
 * exact matches only, across the inventory id, the asset tag and the serial,
 * and NOTHING for a code that names two machines, because a scanner has nobody
 * to ask which one is in the operator's hand. This module is the decision that
 * follows from its answer, kept apart from the two components that make it so
 * the palette's camera button and the paired phone cannot drift.
 *
 * The fallback is the old behaviour and it is the right one: a code the
 * inventory does not know may still be a serial written on a ticket, half an
 * OSIS, or a tag from a district the school shares a building with, and the
 * palette's recogniser is better at those than this is. It is a fallback, not
 * a failure, so nothing is said about it on screen.
 */

/** What `app_lookup_inventory_code` returns for a code it recognises. */
export interface ScannedDevice {
  id: string;
  label: string;
}

export type ScanRoute =
  /** Exactly one machine answers to this code: open it. */
  | { kind: 'device'; id: string; label: string; href: string }
  /** No machine, or more than one: search for the code instead. */
  | { kind: 'search'; query: string };

/** The page one inventory machine lives on. */
export function devicePath(id: string): string {
  return `/devices/${id}`;
}

/**
 * The decision, given a scanned code and what the inventory made of it.
 *
 * `match` is null for a code that names no machine AND for one that names two:
 * the lookup deliberately returns nothing in both cases, and both end in the
 * same place, with the code in the search field for a person to choose from.
 */
export function routeScannedCode(code: string, match: ScannedDevice | null): ScanRoute {
  const query = code.trim();
  if (query !== '' && match !== null && match.id !== '') {
    return { kind: 'device', id: match.id, label: match.label, href: devicePath(match.id) };
  }
  return { kind: 'search', query };
}
