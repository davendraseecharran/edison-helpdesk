/** Two spellings every section needs. */

import { formatHours } from '@/lib/domain/resolved-stats';

/** A span of hours, or a dash where there was nothing to measure. */
export function hoursOr(hours: number | null): string {
  return hours === null ? '—' : formatHours(hours);
}

/** "1 ticket", "12 tickets". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
