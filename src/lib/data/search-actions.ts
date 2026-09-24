'use server';

/**
 * The lookup's one network call.
 *
 * `app_search` is SECURITY INVOKER, so the rows it returns are exactly the
 * rows the caller's own policies allow: a technician who types a colleague's
 * ticket number gets nothing, and learns nothing from the absence. This action
 * adds no filtering of its own and passes nothing but the trimmed text.
 *
 * Forms are asked for beside it, through `app_search_forms`, which checks the
 * caller's own sight of each form (`app_form_can_see`) the way the forms list
 * does. The two run together, and a failure of the second costs only its own
 * hits: a palette that lost its tickets because a form search failed would be
 * the wrong trade.
 *
 * It never throws to the browser. A palette that crashed on a flaky request
 * would take the whole shell down with it, so every failure is an empty list,
 * logged server-side without the query text: what an operator types can be a
 * child's name or OSIS and does not belong in a log line.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { openDuplicates, isStillOpen, type DuplicateHit } from '@/lib/intake/duplicates';
import { formHitFromRow, hitFromRow, SEARCH_MIN_LENGTH, type SearchHit } from './search';

/** Hits per kind. The palette shows a few of each, not a page. */
const SEARCH_LIMIT = 8;

export async function searchAction(query: string): Promise<SearchHit[]> {
  const term = typeof query === 'string' ? query.trim() : '';
  if (term.length < SEARCH_MIN_LENGTH) return [];

  try {
    const actor = await loadActor();
    if (actor.kind !== 'active') return [];

    const supabase = await createClient();
    const [records, forms] = await Promise.all([
      supabase.rpc('app_search', { p_query: term, p_limit: SEARCH_LIMIT }),
      searchForms(supabase, term),
    ]);
    if (records.error) {
      console.error(`app_search failed (${records.error.code ?? 'no code'})`);
      return [];
    }

    const hits: SearchHit[] = [];
    for (const row of Array.isArray(records.data) ? records.data : []) {
      const hit = hitFromRow(row);
      if (hit) hits.push(hit);
    }
    return [...hits, ...forms];
  } catch (cause) {
    console.error(`searchAction failed (${cause instanceof Error ? cause.name : 'unknown'})`);
    return [];
  }
}

/** Forms whose title contains the text, or none when the search fails. Never logs the text. */
async function searchForms(
  supabase: Awaited<ReturnType<typeof createClient>>,
  term: string,
): Promise<SearchHit[]> {
  try {
    const { data, error } = await supabase.rpc('app_search_forms', {
      p_query: term,
      p_limit: SEARCH_LIMIT,
    });
    if (error) {
      console.error(`app_search_forms failed (${error.code ?? 'no code'})`);
      return [];
    }
    const hits: SearchHit[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const hit = formHitFromRow(row);
      if (hit) hits.push(hit);
    }
    return hits;
  } catch (cause) {
    console.error(`app_search_forms threw (${cause instanceof Error ? cause.name : 'unknown'})`);
    return [];
  }
}

/**
 * The tickets the intake form should warn about: still open, and opened this
 * week.
 *
 * The lookup is the right search — it is the one the whole application uses and
 * it runs under the caller's own policies — but `app_search` renders one line
 * per hit and does not carry a date, because nothing else needs one. Rather
 * than widen a function every screen depends on for the sake of one warning,
 * the dates for the few surviving candidates are read back from `tickets`,
 * which is governed by the same policies the search just applied: a row whose
 * date comes back is a row the caller could already see.
 *
 * Like `searchAction`, this never throws to the browser and never logs the
 * query text.
 */
export async function duplicateTicketsAction(query: string): Promise<DuplicateHit[]> {
  const hits = await searchAction(query);
  const candidates = hits.filter((hit) => hit.kind === 'ticket' && isStillOpen(hit.meta));
  if (candidates.length === 0) return [];

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('tickets')
      .select('id, created_at')
      .in(
        'id',
        candidates.map((hit) => hit.id),
      );
    if (error) {
      console.error(`duplicate ticket dates failed (${error.code ?? 'no code'})`);
      return [];
    }

    const opened = new Map<string, string>();
    for (const row of Array.isArray(data) ? data : []) {
      const { id, created_at: createdAt } = row as Record<string, unknown>;
      if (typeof id === 'string' && typeof createdAt === 'string') opened.set(id, createdAt);
    }

    const dated: DuplicateHit[] = candidates.map((hit) => ({
      ...hit,
      createdAt: opened.get(hit.id) ?? null,
    }));
    return openDuplicates(dated, Date.now());
  } catch (cause) {
    console.error(
      `duplicateTicketsAction failed (${cause instanceof Error ? cause.name : 'unknown'})`,
    );
    return [];
  }
}
