/**
 * One vocabulary for what a machine is.
 *
 * `inventory_devices.device_type` is free text with no CHECK constraint — the
 * district's own word for the machine, arriving from its own records — and
 * `app_device_catalog` hands back the distinct values it actually holds. That
 * is the right shape for the data and the wrong shape for a sentence: the same
 * machine was a "Chromebook" in a table cell and a "chromebook" in the line
 * under its heading, because one screen printed the column and another
 * lowercased it to make it fit a phrase.
 *
 * Lowercasing is the part that is actually wrong. Most of these words are
 * generic and a sentence would happily take them in either case, but
 * "Chromebook" is a product name, and a product name does not stop being one
 * because it is in the middle of a line. So the vocabulary below fixes the
 * casing of the words the district uses, `deviceTypeLabel` is the only way a
 * type reaches a screen, and no screen lowercases one again.
 *
 * A word this application has never seen passes through exactly as it was
 * typed — the same rule `deviceStatusClass` follows for a status. The district
 * may invent a type tomorrow, and a type it invented is better plain than
 * mangled by a guess about how it should be capitalised.
 */

/**
 * The types this product knows the casing of, in the order they are offered:
 * the two machines a school has thousands of, then the rest of the room.
 */
export const DEVICE_TYPES = [
  'Chromebook',
  'Laptop',
  'Desktop',
  'Tablet',
  'Projector',
  'Interactive panel',
  'Printer',
  'Phone',
  'Network equipment',
] as const;

export type KnownDeviceType = (typeof DEVICE_TYPES)[number];

const CANONICAL = new Map<string, string>(
  DEVICE_TYPES.map((type) => [type.toLowerCase(), type as string]),
);

/**
 * A device type as it is written on a screen.
 *
 * Empty in, empty out, so a caller can keep using `||` to decide whether there
 * is anything to show at all.
 */
export function deviceTypeLabel(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (text === '') return '';
  return CANONICAL.get(text.toLowerCase()) ?? text;
}

/**
 * The vocabulary a datalist offers: everything the inventory actually holds,
 * in its canonical spelling, plus the words this product knows that the
 * inventory has not used yet. Deduplicated case-insensitively, so a catalogue
 * holding both "chromebook" and "Chromebook" offers one option, and sorted,
 * because a suggestion list somebody scans is looked up by its first letter.
 */
export function deviceTypeOptions(fromCatalog: readonly string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const value of [...fromCatalog, ...DEVICE_TYPES]) {
    const label = deviceTypeLabel(value);
    if (label === '') continue;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, label);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
