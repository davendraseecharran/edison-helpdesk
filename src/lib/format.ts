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

/**
 * The moment a request is being rendered, in epoch milliseconds.
 *
 * For server components that hand a clock to a client component, so the
 * server render and the hydrated first paint compute the same relative times.
 * Pages in the authenticated group are rendered per request, never cached.
 */
export function requestTime(): number {
  return Date.now();
}

/** Parses a `YYYY-MM-DD` key into a local Date at midnight. */
function fromDateKey(key: string): Date | null {
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

/**
 * Turning a school day into the pair of instants that bound it.
 *
 * A date filter means the day the desk worked, not a slice of UTC. Postgres
 * compares `timestamptz`, so `2026-09-13` has to become the instant the school
 * day began and the instant it ended — which differ by five hours from UTC in
 * winter, four in summer, and by twenty-three or twenty-five hours from each
 * other on the two days a year the clocks move.
 *
 * `Intl` is the only clock that knows the rules, so it is asked what the wall
 * clock reads at a candidate instant; the difference is the offset in force.
 * The first guess uses the offset at the UTC-naive instant, which can land on
 * the far side of a transition, so the result is computed again with the offset
 * at that guess. Two passes settle every real case: offsets change by an hour,
 * never by more than the distance one pass corrects.
 */
const schoolWallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * The school's own hour and weekday at an instant.
 *
 * For anything that changes with the time of day — a greeting, a Friday
 * afternoon — computed on the server and handed down, so the browser's own
 * timezone never disagrees with the page it hydrates. `weekday` is 0 for
 * Sunday, matching `Date.getDay()`.
 */
export function schoolHour(date: Date = new Date()): number {
  const hour = Number(
    schoolWallClock.formatToParts(date).find((part) => part.type === 'hour')?.value ?? '0',
  );
  // en-US with hour12:false renders midnight as 24 in some ICU versions.
  return hour % 24;
}

export function schoolWeekday(date: Date = new Date()): number {
  const [year, month, day] = toDateKey(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Milliseconds the school's wall clock runs ahead of UTC at this instant. */
function schoolOffsetAt(instant: number): number {
  const parts = schoolWallClock.formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // en-US with hour12:false renders midnight as 24 in some ICU versions.
  const hour = value('hour') % 24;
  const wall = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    hour,
    value('minute'),
    value('second'),
  );
  // Intl reports whole seconds, so the instant's own milliseconds have to be
  // put back. Without this the offset absorbs them and the end of a day lands
  // 999ms into the next one — an hour of arithmetic ruined by a rounding.
  const milliseconds = ((instant % 1000) + 1000) % 1000;
  return wall + milliseconds - instant;
}

/** The instant a school-local wall-clock time falls on, or null for a bad key. */
function schoolInstant(key: string, hour: number, minute: number, second: number, ms: number): string | null {
  if (!isValidDateKey(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const guess = wall - schoolOffsetAt(wall);
  return new Date(wall - schoolOffsetAt(guess)).toISOString();
}

/**
 * Midnight at the start of a school-local day, as an ISO instant.
 *
 * On the spring-forward day there is no 2 a.m., but there is still a midnight,
 * so the start of the day is unremarkable; it is the day's LENGTH that changes,
 * which is why the end is computed separately rather than by adding a day.
 */
export function schoolDayStart(key: string): string | null {
  return schoolInstant(key, 0, 0, 0, 0);
}

/**
 * The last millisecond of a school-local day, so a "to" filter includes it.
 *
 * Inclusive because that is what a person means by "to the 13th", and because
 * the audit RPC compares `at <= p_to`.
 */
export function schoolDayEnd(key: string): string | null {
  return schoolInstant(key, 23, 59, 59, 999);
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
