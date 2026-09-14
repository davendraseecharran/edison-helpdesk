/**
 * One number, its label and one line of context.
 *
 * The four figures at the top of the page are not charts and must not become
 * them: a single current value is a tile, and a one-bar bar chart is the most
 * common way a dashboard misses its own point. No sparkline either — the line
 * chart directly below plots the same two series properly, and a 40px
 * repetition of it in the tile would be decoration.
 */

import { formatMinutes } from '@/lib/format';

const MINUTES_PER_DAY = 24 * 60;
/** Past two days, hours stop being a duration anybody can picture. */
const DAYS_THRESHOLD = 48 * 60;

/**
 * A resolution time in hours, said the way a technician would: "20m",
 * "3h 20m", "2d 3h".
 *
 * The database reports hours to two decimals, which is a measurement rather
 * than an answer to "how long does this take us"; 3.33 hours is three hours and
 * twenty minutes. Rounding is applied once, in minutes, so an hour that rounds
 * up to a full day is reported as the next day rather than as "2d 24h".
 */
export function formatHours(hours: number): string {
  const minutes = Math.max(0, Math.round((Number.isFinite(hours) ? hours : 0) * 60));
  if (minutes < DAYS_THRESHOLD) return formatMinutes(minutes);
  let days = Math.floor(minutes / MINUTES_PER_DAY);
  let rest = Math.round((minutes % MINUTES_PER_DAY) / 60);
  if (rest === 24) {
    days += 1;
    rest = 0;
  }
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

export function StatTile({
  label,
  value,
  meta,
  accent = false,
}: {
  label: string;
  value: string;
  meta?: string;
  /** Marks the one live figure in a row of figures about a period. */
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'stat-tile stat-tile-accent' : 'stat-tile'}>
      <p className="stat-tile-label">{label}</p>
      <p className="stat-tile-value">{value}</p>
      {meta ? <p className="stat-tile-meta">{meta}</p> : null}
    </div>
  );
}
