/**
 * When a ticket was opened, and when it was resolved, as intake says it.
 *
 * Almost every ticket is opened now, so "now" is not a value here but the
 * absence of one: `null`. A moment is only carried when somebody chose an
 * earlier one, and then it is an ISO instant built from the school-local date
 * and wall clock they picked — never from the browser's own zone, because a
 * NetRider's laptop set to UTC must not log a 9 a.m. walk-in at 5 a.m.
 *
 * The bounds are the database's (`app_check_history_moment`): not in the
 * future, not before 2020. They are said again here so the picker can refuse a
 * moment while it is being chosen rather than after Create is pressed.
 */

import { schoolClockKey, schoolWallTime, toDateKey, formatClockTime } from '@/lib/format';

/** The first school day a ticket may be opened on. */
export const HISTORY_FLOOR_KEY = '2020-01-01';

/** Within this of now, a chosen moment IS now; the database draws the same line. */
export const NOW_TOLERANCE_MS = 60_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The school-local date and `HH:MM` of an instant, as the two fields take them. */
export function momentParts(iso: string | number): { date: string; time: string } {
  const date = new Date(iso);
  return { date: toDateKey(date), time: schoolClockKey(date) };
}

/** The instant a picked school-local date and `HH:MM` name, or null. */
export function momentFromParts(dateKey: string, time: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  return schoolWallTime(dateKey, Number(match[1]), Number(match[2]));
}

/**
 * What is wrong with a chosen moment, in a sentence, or null.
 *
 * `what` names it the way the error does: "The opened time", "The resolved
 * time". `notBefore` is the other end of the ticket when there is one — a
 * resolution cannot come before the opening.
 */
export function momentProblem(
  iso: string,
  nowMs: number,
  what: string,
  notBefore?: { iso: string; what: string } | null,
): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return `${what} is not a date and time.`;
  if (at > nowMs + NOW_TOLERANCE_MS) return `${what} cannot be in the future.`;
  if (toDateKey(new Date(at)) < HISTORY_FLOOR_KEY) return `${what} cannot be before 2020.`;
  if (notBefore) {
    const floor = Date.parse(notBefore.iso);
    if (!Number.isNaN(floor) && at < floor) return `${what} cannot be before ${notBefore.what}.`;
  }
  return null;
}

/**
 * The chosen moment as the database should receive it: null when it is now,
 * or near enough that the difference is a clock and not a history.
 */
export function momentForSubmit(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.abs(nowMs - at) <= NOW_TOLERANCE_MS ? null : iso;
}

/**
 * The quiet control's label: "Now", "Today, 9:05 AM", "Yesterday, 4:10 PM",
 * "Sep 12, 9:05 AM", or "Mar 2, 2025, 9:05 AM" when the year is not this one.
 */
export function momentLabel(iso: string | null, nowMs: number): string {
  if (iso === null) return 'Now';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Now';
  const key = toDateKey(at);
  const today = toDateKey(new Date(nowMs));
  const clock = formatClockTime(iso);
  if (key === today) return `Today, ${clock}`;
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (key === yesterday.toISOString().slice(0, 10)) return `Yesterday, ${clock}`;
  const [year, month, day] = key.split('-').map(Number);
  const base = `${MONTHS[month - 1]} ${day}`;
  return key.slice(0, 4) === today.slice(0, 4) ? `${base}, ${clock}` : `${base}, ${year}, ${clock}`;
}
