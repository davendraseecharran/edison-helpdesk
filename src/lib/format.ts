/**
 * Display formatting helpers. Kept free of React so tests and future server
 * code can use them.
 *
 * Calendar dates are handled as `YYYY-MM-DD` keys in school-local time, never as
 * UTC instants, so a backdated submission date cannot shift by a day.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const SCHOOL_TIME_ZONE = 'America/New_York';
const schoolDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const schoolClock = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true,
});

/** School-local date, independent of the browser or server's timezone. */
export function toDateKey(date: Date): string {
  const parts = schoolDate.formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Today's school-local date key. Safe on the server and in the browser. */
export function schoolToday(): string {
  return toDateKey(new Date());
}

/** Parses a `YYYY-MM-DD` key into a local Date at midnight. */
export function fromDateKey(key: string): Date | null {
  const match = key.match(DATE_KEY_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function isValidDateKey(key: string): boolean {
  return fromDateKey(key) !== null;
}

/** "Thu, Sep 10" — or "Thu, Sep 10, 2025" when the year differs from `reference`. */
export function formatDateKey(key: string, reference?: string): string {
  const date = fromDateKey(key);
  if (!date) return key;
  const weekday = WEEKDAYS[date.getDay()];
  const base = `${weekday}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
  const referenceYear = reference ? Number(reference.slice(0, 4)) : date.getFullYear();
  return date.getFullYear() === referenceYear ? base : `${base}, ${date.getFullYear()}`;
}

export function formatClockTime(iso: string): string {
  return schoolClock.format(new Date(iso));
}

/** "Sep 10, 2026, 9:15 AM" */
export function formatDateTime(iso: string): string {
  const [year, month, day] = toDateKey(new Date(iso)).split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}, ${formatClockTime(iso)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact queue age: "12m", "4h", "2d 3h". */
export function formatAge(iso: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - new Date(iso).getTime());
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    const minutes = Math.floor((elapsed % HOUR) / MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(elapsed / DAY);
  const hours = Math.floor((elapsed % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const WEEK = 7 * DAY;

/**
 * The one-token age shown in queue rows: "just now", "12m", "3h", "2d", "5w".
 *
 * Coarser than `formatAge` on purpose. A queue is scanned, not read, so the
 * column holds a single unit and a number; hover on the cell gives the full
 * timestamp. A clock slightly ahead of the server reads as "just now".
 */
export function ageLabel(createdAt: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(createdAt).getTime());
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / WEEK)}w`;
}

/** Timeline wording: "4h ago". */
export function formatRelative(iso: string, nowMs: number): string {
  const elapsed = nowMs - new Date(iso).getTime();
  if (elapsed < 0) return formatDateTime(iso);
  if (elapsed < MINUTE) return 'just now';
  return `${formatAge(iso, nowMs)} ago`;
}

/** Person-minutes as "1h 25m". Callers decide how to render "not recorded". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}
