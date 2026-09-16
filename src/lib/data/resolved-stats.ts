import 'server-only';

/**
 * The analytics screen's one read.
 *
 * `app_resolved_stats` is SECURITY DEFINER and refuses anybody who is not an
 * administrator, so this module does no filtering of its own: the page's own
 * gate decides what a person sees instead of a refusal, and the database
 * decides what they can read. Both have to agree, and only one of them is
 * enforceable.
 *
 * Every row is checked rather than cast. These numbers are the ones a person
 * might be measured by, so a column that arrives in an unexpected shape has to
 * fail here, visibly, rather than reach the table as a zero that reads like a
 * quiet term.
 *
 * A failure is an empty period, not an error screen — with `ok` false, so the
 * page can say the difference. "Nothing resolved" and "we could not count" are
 * two different sentences and only one of them is about the desk.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { isRecord } from '@/lib/guards';
import {
  EMPTY_PRIORITY_COUNTS,
  periodBounds,
  PRIORITY_ORDER,
  type CategoryCounts,
  type PriorityCounts,
  type ResolvedStats,
  type ResolverStats,
  type StatsPeriod,
} from '@/lib/domain/resolved-stats';
import { isTicketCategory } from '@/lib/domain/types';

export interface ResolvedStatsView extends ResolvedStats {
  /** False when the period could not be read at all, which is not the same as empty. */
  ok: boolean;
}

/** A count: a whole number that is never negative, whatever arrived. */
function countOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * A span in hours, or null.
 *
 * Null is a real answer here — a resolver with nothing in the period has no
 * median — so an unreadable value becomes null too rather than a zero, which
 * would render as "0m" and claim every ticket closed instantly.
 */
function hoursOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function prioritiesOf(value: unknown): PriorityCounts {
  if (!isRecord(value)) return { ...EMPTY_PRIORITY_COUNTS };
  const counts: PriorityCounts = { ...EMPTY_PRIORITY_COUNTS };
  for (const priority of PRIORITY_ORDER) counts[priority] = countOf(value[priority]);
  return counts;
}

/** Only the categories the vocabulary knows. An absent key is zero, not a bug. */
function categoriesOf(value: unknown): CategoryCounts {
  if (!isRecord(value)) return {};
  const counts: CategoryCounts = {};
  for (const [key, count] of Object.entries(value)) {
    if (isTicketCategory(key)) counts[key] = countOf(count);
  }
  return counts;
}

function rowFrom(row: unknown): ResolverStats | null {
  if (!isRecord(row)) return null;
  // The totals row carries no id, which is what marks it. Anything else with
  // no id is a row about nobody, and there is nothing to show for it.
  const id = typeof row.resolver_id === 'string' ? row.resolver_id : null;
  const name = typeof row.resolver_name === 'string' ? row.resolver_name : null;
  if (id !== null && name === null) return null;
  return {
    resolverId: id,
    resolverName: name,
    resolvedCount: countOf(row.resolved_count),
    byPriority: prioritiesOf(row.by_priority),
    byCategory: categoriesOf(row.by_category),
    medianHours: hoursOf(row.median_hours),
    meanHours: hoursOf(row.mean_hours),
    reopenedCount: countOf(row.reopened_count),
  };
}

/**
 * One period's statistics, memoised for the render pass.
 *
 * The bounds are computed here rather than in the database so that the period
 * is the school's calendar rather than the server's: the same four buttons
 * have to mean the same four spans whichever machine renders them.
 */
export const loadResolvedStats = cache(
  async (period: StatsPeriod): Promise<ResolvedStatsView> => {
    const bounds = periodBounds(period);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('app_resolved_stats', {
      p_since: bounds.since,
      p_until: bounds.until,
    });

    if (error || !Array.isArray(data)) {
      return { ok: false, period, resolvers: [], totals: null };
    }

    const resolvers: ResolverStats[] = [];
    let totals: ResolverStats | null = null;
    for (const row of data) {
      const mapped = rowFrom(row);
      if (!mapped) continue;
      if (mapped.resolverId === null) totals = mapped;
      else resolvers.push(mapped);
    }

    return { ok: true, period, resolvers, totals };
  },
);
