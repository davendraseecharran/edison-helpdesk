/**
 * The lookup's pure rules: what a hit is, where it links, how hits group,
 * how a typed ticket number is read, and how recent selections are kept.
 *
 * Nothing here touches the network or the browser, so the command palette's
 * behaviour is testable without either. `searchAction` in `search-actions.ts`
 * is the one network call and maps `app_search` rows through `hitFromRow`.
 */

export type SearchKind = 'ticket' | 'person' | 'device';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** Ticket: "EDT-1042 <title>". Person: display name. Device: the identifier read off the machine. */
  title: string;
  /** Ticket: requester. Person: "Student — 7-401". Device: model and type. */
  subtitle: string | null;
  /** Ticket: the raw status value. Person: OSIS or staff ID. Device: status and holder. */
  meta: string | null;
  href: string;
}

export interface GroupedHits {
  tickets: SearchHit[];
  people: SearchHit[];
  devices: SearchHit[];
}

/** One selected record, as remembered per browser. */
export interface RecentItem {
  kind: SearchKind;
  id: string;
  title: string;
  href: string;
  /** Epoch milliseconds of the selection. */
  at: number;
}

/** `app_search` returns nothing under two characters, so the client never asks. */
export const SEARCH_MIN_LENGTH = 2;

/** Milliseconds of quiet typing before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 150;

export const RECENT_STORAGE_KEY = 'edison.lookup.recent';

export const RECENT_LIMIT = 5;

const KINDS: ReadonlySet<string> = new Set<SearchKind>(['ticket', 'person', 'device']);

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && KINDS.has(value);
}

const ROUTES: Record<SearchKind, string> = {
  ticket: '/tickets',
  person: '/people',
  device: '/devices',
};

/** The page a hit opens. */
export function hrefFor(hit: Pick<SearchHit, 'kind' | 'id'>): string {
  return `${ROUTES[hit.kind]}/${encodeURIComponent(hit.id)}`;
}

/** Split mixed hits into the three palette groups, keeping the server's rank order within each. */
export function groupHits(hits: SearchHit[]): GroupedHits {
  const grouped: GroupedHits = { tickets: [], people: [], devices: [] };
  for (const hit of hits) {
    if (hit.kind === 'ticket') grouped.tickets.push(hit);
    else if (hit.kind === 'person') grouped.people.push(hit);
    else grouped.devices.push(hit);
  }
  return grouped;
}

/**
 * One `app_search` row as a hit, or null for a row the client does not
 * understand. Rows arrive from the database, but the mapping still checks its
 * input so a schema change fails visibly here rather than as a broken link.
 */
export function hitFromRow(row: unknown): SearchHit | null {
  if (!row || typeof row !== 'object') return null;
  const { kind, id, title, subtitle, meta } = row as Record<string, unknown>;
  if (!isSearchKind(kind) || typeof id !== 'string' || id === '' || typeof title !== 'string') {
    return null;
  }
  return {
    kind,
    id,
    title,
    subtitle: typeof subtitle === 'string' && subtitle !== '' ? subtitle : null,
    meta: typeof meta === 'string' && meta !== '' ? meta : null,
    href: hrefFor({ kind, id }),
  };
}

/**
 * The ticket number a query names, normalised, or null.
 *
 * "1042", "edt-1042", "EDT 1042" and "edt1042" all mean EDT-1042. With the
 * prefix written out any number counts; bare digits stop at six, because a
 * nine-digit OSIS is a student, not a ticket, and offering to claim it would
 * be noise.
 */
export function ticketNumberFromQuery(query: string): string | null {
  const trimmed = query.trim();
  const prefixed = /^edt[\s-]?(\d+)$/i.exec(trimmed);
  if (prefixed) return `EDT-${prefixed[1]}`;
  const bare = /^(\d{1,6})$/.exec(trimmed);
  if (bare) return `EDT-${bare[1]}`;
  return null;
}

/** "EDT-1042 Projector shows no signal" as its number and the rest, for separate styling. */
export function splitTicketTitle(title: string): { number: string | null; rest: string } {
  const match = /^(EDT-\d+)\s+([\s\S]*)$/.exec(title);
  if (!match) return { number: null, rest: title };
  return { number: match[1], rest: match[2] };
}

/**
 * Whether an action matches what was typed: every whitespace-separated token
 * of the query starts some word of the label or its keywords. Prefixes rather
 * than fuzzy matching, so "os" (the start of an OSIS) does not surface
 * "Go to resolved" beside the student it was meant to find.
 */
export function matchesQuery(label: string, keywords: readonly string[], query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const words = [label, ...keywords]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.every((token) => words.some((word) => word.startsWith(token)));
}

/**
 * Recent selections from storage, tolerating anything: no value, text that is
 * not JSON, JSON that is not a list, and entries missing or mistyping a field
 * all yield what could be read, never an exception. Duplicates collapse and
 * the list is capped, so a tampered value cannot grow the palette.
 */
export function parseRecent(raw: unknown): RecentItem[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: RecentItem[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { kind, id, title, at } = entry as Record<string, unknown>;
    if (!isSearchKind(kind) || typeof id !== 'string' || id === '' || typeof title !== 'string') {
      continue;
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind,
      id,
      title,
      // The link is derived, never trusted from storage.
      href: hrefFor({ kind, id }),
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    });
    if (items.length >= RECENT_LIMIT) break;
  }
  return items;
}

/** The list with `hit` at the top, any earlier copy removed, capped at `RECENT_LIMIT`. */
export function rememberRecent(list: RecentItem[], hit: SearchHit, at: number): RecentItem[] {
  const item: RecentItem = { kind: hit.kind, id: hit.id, title: hit.title, href: hit.href, at };
  const rest = list.filter((entry) => !(entry.kind === hit.kind && entry.id === hit.id));
  return [item, ...rest].slice(0, RECENT_LIMIT);
}
