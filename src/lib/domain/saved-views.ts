/**
 * A filter set somebody named.
 *
 * "Room 214". "Chromebook batteries". "Everything Marcus owns." A NetRider
 * builds the same three or four filter combinations every week, and rebuilding
 * one is six controls and a search box. A saved view is that combination with a
 * name on it, and one press puts it back.
 *
 * Pure: the shape, the rules for adding and removing, and the comparison that
 * decides whether a view is the one currently on screen. Storage is elsewhere —
 * `account_preferences.saved_views` through `app_set_saved_views`, with this
 * browser's own copy as the fallback — and both read these rules.
 *
 * Nothing here is authorization. A view is a URL; the database decides what
 * that URL can see, exactly as it does when the filters are typed by hand.
 */

export interface SavedView {
  /** Stable across renames, so a rename is not a delete and an add. */
  id: string;
  name: string;
  /** The list the view belongs to: `/queue`, `/all-tickets`, `/devices`. */
  path: string;
  /** The query string without its leading `?`. May be empty: "everything, unfiltered". */
  query: string;
}

/** What the database's CHECK allows, mirrored so a save is refused before the round trip. */
export const SAVED_VIEW_LIMIT = 24;
export const SAVED_VIEW_NAME_MAX = 60;

/** Where a saved view goes. */
export function viewHref(view: SavedView): string {
  return view.query === '' ? view.path : `${view.path}?${view.query}`;
}

/**
 * The canonical spelling of a query string, so two views built in a different
 * order are recognised as the same view.
 *
 * Sorted by key, empty values dropped, and `page` removed — a saved view is a
 * filter, not a page number, and saving "Room 214, page 3" would be saving
 * somebody's scroll position.
 */
export function normaliseQuery(query: string): string {
  const params = new URLSearchParams(query);
  params.delete('page');
  const entries = [...params.entries()]
    .filter(([, value]) => value.trim() !== '')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/** Whether this view is the one currently on screen. */
export function viewIsCurrent(view: SavedView, path: string, query: string): boolean {
  return view.path === path && view.query === normaliseQuery(query);
}

/** One stored entry, checked rather than cast. Anything unreadable is dropped. */
export function viewFromRow(row: unknown): SavedView | null {
  if (!row || typeof row !== 'object') return null;
  const { id, name, path, query } = row as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  // An in-app path only. A stored value is not a trusted value even when the
  // database wrote it, and this is the one field that becomes a link.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  return {
    id,
    name: trimmed.slice(0, SAVED_VIEW_NAME_MAX),
    path,
    query: normaliseQuery(typeof query === 'string' ? query : ''),
  };
}

/**
 * A stored list, tolerating anything: no value, text that is not JSON, JSON
 * that is not a list, entries missing a field. Duplicates by id collapse and
 * the list is capped, so a tampered value cannot grow the filter bar.
 */
export function parseSavedViews(raw: unknown): SavedView[] {
  const source =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(source)) return [];

  const views: SavedView[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    const view = viewFromRow(entry);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    views.push(view);
    if (views.length >= SAVED_VIEW_LIMIT) break;
  }
  return views;
}

/**
 * The list with `view` in it, newest first.
 *
 * Saving the same filters again under a new name REPLACES the old entry rather
 * than adding a second chip that does the same thing — the chips are a shelf,
 * not a log.
 */
export function addSavedView(list: readonly SavedView[], view: SavedView): SavedView[] {
  const rest = list.filter(
    (entry) => entry.id !== view.id && !(entry.path === view.path && entry.query === view.query),
  );
  return [view, ...rest].slice(0, SAVED_VIEW_LIMIT);
}

export function removeSavedView(list: readonly SavedView[], id: string): SavedView[] {
  return list.filter((entry) => entry.id !== id);
}

/** Why this view cannot be saved, or null. The same bounds the RPC enforces. */
export function savedViewError(name: string, list: readonly SavedView[]): string | null {
  if (name.trim() === '') return 'Give the view a name so you can find it again.';
  if (name.trim().length > SAVED_VIEW_NAME_MAX) {
    return `A name can be up to ${SAVED_VIEW_NAME_MAX} characters.`;
  }
  if (list.length >= SAVED_VIEW_LIMIT) {
    return `You can keep up to ${SAVED_VIEW_LIMIT} saved views. Remove one and save again.`;
  }
  return null;
}

/** The views that belong to this list. */
export function viewsFor(list: readonly SavedView[], path: string): SavedView[] {
  return list.filter((view) => view.path === path);
}
