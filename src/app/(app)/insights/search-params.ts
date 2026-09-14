/**
 * The insights range, carried in the URL so a view of the last ninety days is
 * shareable and survives a refresh, and so the database — not the browser —
 * decides what the window means.
 */

export const INSIGHTS_RANGES = [7, 30, 90] as const;

export type InsightsRange = (typeof INSIGHTS_RANGES)[number];

/** A month is what a helpdesk is usually asked about. */
export const DEFAULT_RANGE: InsightsRange = 30;

export type SearchParamValue = string | string[] | undefined;

export interface InsightsSearchParams {
  days?: SearchParamValue;
}

function first(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A range the control actually offers, or the default.
 *
 * A hand-typed `?days=365` is dropped rather than passed on: the database would
 * clamp it and answer, and the segmented control would then show a selection
 * that does not match the chart above it.
 *
 * Compared as STRINGS against the three spellings the control writes.
 * `Number()` also accepted `"7.0"`, `"07"`, `" 7 "` and `"7e0"`, so several
 * different URLs rendered the same page — and the next press of the control
 * rewrote the address under the reader, because it always writes the canonical
 * one. One spelling per range; everything else falls to the default, which the
 * control then makes canonical by dropping the parameter.
 */
const OFFERED = INSIGHTS_RANGES.map((days) => String(days));

export function toInsightsRange(value: SearchParamValue): InsightsRange {
  const days = first(value);
  return days !== undefined && OFFERED.includes(days)
    ? (Number(days) as InsightsRange)
    : DEFAULT_RANGE;
}
