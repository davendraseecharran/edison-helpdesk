/**
 * What a toast is, in numbers.
 *
 * The queue itself is Sonner's now. What used to be a hand-written reducer —
 * a stack, per-toast clocks, hold records, a hidden-tab flag and one armed
 * timer — was a correct implementation of a thing that is solved: Sonner
 * stacks, pauses on hover, pauses while the tab is hidden, takes a swipe, and
 * keeps its own timers. Deleting it removed the two bugs that live in every
 * hand-rolled toast queue (a hold left behind by a toast that unmounted, and a
 * timer that lands a millisecond short and re-arms forever).
 *
 * What did not move to the library is the product's opinion, which is these
 * four rules, kept pure so they can be read and tested without a DOM:
 *
 *   - A success leaves by itself after five seconds. An error does not leave
 *     at all, because it is asking for a decision and nobody decides in five
 *     seconds.
 *   - A message that is being read has no clock. Sonner stops one under the
 *     pointer; `toastDuration(kind, true)` is the same rule for the keyboard,
 *     applied while focus rests inside the toast.
 *   - The same message twice is one message. The id is the message, so a
 *     repeat refreshes what is on screen instead of stacking a duplicate.
 *   - Three at once. Beyond that the oldest goes, because a corner of the
 *     screen holding five messages is not a notification, it is a log.
 */

export type ToastKind = 'success' | 'error';

/** How long a success stays when nothing is holding it. */
export const TOAST_LIFETIME_MS = 5_000;

/** The most toasts on screen at once; beyond this the oldest goes. */
export const TOAST_LIMIT = 3;

/** Bottom-right where there is room; on a phone the bottom belongs to the tabs. */
export type ToastPosition = 'bottom-right' | 'top-center';

/**
 * The id of a message, which is the message.
 *
 * Sonner replaces a toast whose id is already on the stack, so two identical
 * confirmations a second apart are one confirmation with its clock restarted.
 * Kind is part of the id so a success and an error that happen to read the
 * same are still two different things.
 */
export function toastKey(kind: ToastKind, text: string): string {
  return `${kind}:${text}`;
}

/**
 * The life of a toast in milliseconds, or `Infinity` for one that stays.
 *
 * `held` is the keyboard's half of the pause: Sonner stops the clock under the
 * pointer on its own, and this is the same courtesy for somebody who arrived
 * at the dismiss button with Tab.
 */
export function toastDuration(kind: ToastKind, held = false): number {
  if (held || kind === 'error') return Number.POSITIVE_INFINITY;
  return TOAST_LIFETIME_MS;
}

/**
 * Where the stack lives.
 *
 * Bottom-right on a desktop, beside the work and out of the way. On a phone
 * the bottom edge is the tab bar and the thumb, so the stack moves to the top
 * where it covers a page header rather than a control.
 */
export function toastPosition(phone: boolean): ToastPosition {
  return phone ? 'top-center' : 'bottom-right';
}
