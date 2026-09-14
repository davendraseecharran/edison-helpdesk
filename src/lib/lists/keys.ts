/**
 * The keyboard model for every list in the application.
 *
 * One model, learned once: `j` and `k` move, `o` opens, `c` claims, `r`
 * resolves, `e` edits, and the number keys jump. Today and the queue use the
 * same keys for the same meanings, because the cost of a shortcut is learning
 * it and that cost should be paid once rather than per screen.
 *
 * Everything here is pure, so the movement rules are a unit test rather than a
 * page somebody has to sit in front of and press `j` on. The hook that binds
 * the keys lives in `src/components/ui/useRowKeys.ts`; this file only answers
 * "given where the focus is and which key was pressed, where does it go".
 *
 * None of these keys is the only way to do anything. Every one of them presses
 * a control that is visible on the row, which is the rule that keeps the list
 * usable by somebody who has never read this file.
 */

/** What a list can be asked to do. */
export type ListAction = 'open' | 'claim' | 'resolve' | 'edit';

/** The keys that run an action on the focused row, in the order they are documented. */
export const ACTION_KEYS: Record<string, ListAction> = {
  o: 'open',
  enter: 'open',
  c: 'claim',
  r: 'resolve',
  e: 'edit',
};

/** How each action is named where the row shows its key. */
export const ACTION_LABELS: Record<ListAction, string> = {
  open: 'Open',
  claim: 'Claim',
  resolve: 'Resolve',
  edit: 'Edit',
};

/**
 * Where the focus goes for a movement key, or null when the key moves nothing.
 *
 * Movement CLAMPS rather than wraps. A list is a plan read top to bottom, and
 * wrapping from the last row to the first means holding `j` quietly loses your
 * place; clamping means the end of the list is the end of the list.
 *
 * `index` may be -1, which is "nothing focused yet": the first `j` then lands
 * on the first row rather than the second, and the first `k` lands on the last,
 * which is what somebody reaching for the bottom of a list expects.
 */
export function nextFocus(index: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  const last = length - 1;
  const at = Number.isInteger(index) ? index : -1;

  switch (key.toLowerCase()) {
    case 'j':
    case 'arrowdown':
      return at < 0 ? 0 : Math.min(last, at + 1);
    case 'k':
    case 'arrowup':
      return at < 0 ? last : Math.max(0, at - 1);
    case 'home':
      return 0;
    case 'end':
      return last;
    default:
      break;
  }

  // The number keys jump. On a list of seven things to do, "the fourth one" is
  // a thought somebody already had before their hand reached the keyboard.
  if (/^[1-9]$/.test(key)) {
    const target = Number(key) - 1;
    return target <= last ? target : null;
  }
  return null;
}

/** The action a key runs, or null. */
export function actionFor(key: string): ListAction | null {
  return ACTION_KEYS[key.toLowerCase()] ?? null;
}

/**
 * Where the focus should sit after the list changes underneath it.
 *
 * A row is claimed and leaves the list; a filter narrows it; another NetRider
 * resolves something while you are reading. The focus follows the identity it
 * was on, and when that identity has gone it stays at the same POSITION, which
 * is the next row down — the one that moved up into the space. Falling back to
 * the top of the list every time somebody else committed a change is what makes
 * a keyboard list feel like it is fighting you.
 */
export function focusAfterChange(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  focusedKey: string | null,
): string | null {
  if (nextKeys.length === 0) return null;
  if (focusedKey !== null && nextKeys.includes(focusedKey)) return focusedKey;

  const wasAt = focusedKey === null ? -1 : previousKeys.indexOf(focusedKey);
  if (wasAt < 0) return null;
  return nextKeys[Math.min(wasAt, nextKeys.length - 1)];
}
