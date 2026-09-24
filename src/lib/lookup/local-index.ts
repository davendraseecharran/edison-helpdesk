/**
 * The directory and the inventory, searched in the browser as keys are pressed.
 *
 * Read once per session (`searchIndexAction`, after the first page has
 * painted), held in module memory and never written to storage: a shared
 * Chromebook keeps nothing after the tab closes. The palette answers from here
 * at once and the server's answer — which also carries tickets, groups,
 * events and forms, and the guardian-phone search this index leaves out —
 * lands on top a moment later.
 *
 * Matching is word-prefix, the way people type names and tags: every word of
 * the query must start some word of the record ("nia ok" finds Nia Okonkwo),
 * or, for a query that looks like an identifier, appear anywhere in one ("0ed9"
 * finds A-c630ed90). Ranks follow app_search's ladder so the two answers merge
 * without reshuffling: an identifier that is the whole query 1.0, one the query
 * starts 0.9, a name whose words the query starts 0.8, any other match 0.5.
 */

import type { SearchHit } from '@/lib/data/search';

/** kind (0 person, 1 device), id, title, subtitle, meta, keys. */
export type IndexRow = [kind: 0 | 1, id: string, title: string, subtitle: string, meta: string, keys: string];

interface Entry {
  row: IndexRow;
  words: string[];
  /** Identifiers with punctuation removed, for substring matches. */
  compact: string;
}

export interface LocalIndex {
  entries: Entry[];
  loadedAt: number;
}

const PER_KIND = 8;

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function wordsOf(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9@.]+/)
    .filter(Boolean);
}

export function buildIndex(rows: readonly IndexRow[], now = Date.now()): LocalIndex {
  return {
    loadedAt: now,
    entries: rows.map((row) => {
      const words = wordsOf(`${row[2]} ${row[5]}`);
      return { row, words, compact: normalize(row[5]).replace(/[^a-z0-9]/g, '') };
    }),
  };
}

function hitOf(entry: Entry): SearchHit {
  const [kind, id, title, subtitle, meta] = entry.row;
  return {
    kind: kind === 0 ? 'person' : 'device',
    id,
    title,
    subtitle: subtitle || null,
    meta: meta || null,
    href: kind === 0 ? `/people/${id}` : `/devices/${id}`,
  };
}

function rank(entry: Entry, tokens: string[], compactQuery: string, idLike: boolean): number {
  const idWords = entry.words.filter((word) => /\d/.test(word));
  if (idLike && idWords.some((word) => word.replace(/[^a-z0-9]/g, '') === compactQuery)) return 1;
  if (idLike && idWords.some((word) => word.replace(/[^a-z0-9]/g, '').startsWith(compactQuery))) {
    return 0.9;
  }
  if (tokens.every((token) => entry.words.some((word) => word.startsWith(token)))) return 0.8;
  if (idLike && compactQuery.length >= 3 && entry.compact.includes(compactQuery)) return 0.5;
  return 0;
}

/** At most eight people and eight machines, best first. */
export function searchLocal(index: LocalIndex | null, query: string): SearchHit[] {
  if (!index) return [];
  const tokens = wordsOf(query);
  if (tokens.length === 0 || tokens.join('').length < 2) return [];
  const compactQuery = tokens.join('').replace(/[^a-z0-9]/g, '');
  const idLike = /\d/.test(compactQuery);

  const best: Record<0 | 1, Array<{ entry: Entry; score: number }>> = { 0: [], 1: [] };
  for (const entry of index.entries) {
    const score = rank(entry, tokens, compactQuery, idLike);
    if (score === 0) continue;
    const bucket = best[entry.row[0]];
    bucket.push({ entry, score });
    if (bucket.length > PER_KIND * 4) {
      bucket.sort((a, b) => b.score - a.score || a.entry.row[2].localeCompare(b.entry.row[2]));
      bucket.length = PER_KIND;
    }
  }
  const top = (bucket: Array<{ entry: Entry; score: number }>) =>
    bucket
      .sort((a, b) => b.score - a.score || a.entry.row[2].localeCompare(b.entry.row[2]))
      .slice(0, PER_KIND)
      .map(({ entry }) => hitOf(entry));
  return [...top(best[0]), ...top(best[1])];
}

/**
 * The palette's answer while the server's is on its way, and after: the
 * server's hits in their order, then any local person or machine the server
 * did not return, so a result never disappears from under the pointer.
 */
export function mergeHits(local: readonly SearchHit[], server: readonly SearchHit[] | null): SearchHit[] {
  if (!server) return [...local];
  const seen = new Set(server.map((hit) => `${hit.kind}:${hit.id}`));
  const room: Record<string, number> = {
    person: PER_KIND - server.filter((hit) => hit.kind === 'person').length,
    device: PER_KIND - server.filter((hit) => hit.kind === 'device').length,
  };
  const keep = local.filter((hit) => {
    if (seen.has(`${hit.kind}:${hit.id}`) || (room[hit.kind] ?? 0) <= 0) return false;
    room[hit.kind] -= 1;
    return true;
  });
  return [...server, ...keep];
}
