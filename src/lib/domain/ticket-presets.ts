/**
 * Quick tickets: the calls that repeat all day, written down once.
 *
 * A preset is the part of a ticket that is the same every time — the title,
 * the sentence, the category, the priority, sometimes the room — so that
 * filing one of those calls is a tap plus the requester. The requester and the
 * channel are never in it: they are the part that is new.
 *
 * Everything here is pure, so the menu in the top bar, the palette's actions,
 * the settings list and the tests all agree without a database. The database
 * is still what decides: `app_save_ticket_preset` re-derives the actor, checks
 * the same vocabularies and refuses a thirteenth preset
 * (`20260916130200_m5_ticket_presets.sql`).
 */

import {
  isTicketCategory,
  type Priority,
  type TicketCategory,
  PRIORITY_LABELS,
} from './types';

/** One row of the desk's shared list. */
export interface TicketPreset {
  id: string;
  name: string;
  title: string;
  issue: string;
  category: TicketCategory;
  priority: Priority;
  location: string;
  position: number;
}

/** What a preset is worth as an intake form's starting point. */
export type TicketPresetDraft = Omit<TicketPreset, 'id' | 'position'>;

/**
 * Twelve, and the reason is the menu rather than the storage: past a dozen
 * rows the quickest way to file the call is to type it, and the list has
 * become a second queue to maintain.
 */
export const TICKET_PRESET_CAP = 12;

export const PRESET_NAME_MAX = 40;
export const PRESET_TITLE_MAX = 120;
export const PRESET_ISSUE_MAX = 2000;
export const PRESET_LOCATION_MAX = 80;

/** The URL a preset files from. The intake form reads `preset` and prefills. */
export function presetHref(id: string): string {
  return `/tickets/new?preset=${encodeURIComponent(id)}`;
}

/** What the palette and the menu call the row. */
export function presetActionLabel(preset: TicketPreset): string {
  return `New ticket: ${preset.name}`;
}

/**
 * Words that should find this preset in the palette.
 *
 * The name and the title, split into words: somebody typing "projector" is
 * looking for the projector preset whether the desk called the row "Projector"
 * or "Room 212 projector".
 */
export function presetKeywords(preset: TicketPreset): string[] {
  const words = `${preset.name} ${preset.title}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
  return ['preset', 'quick', 'template', ...new Set(words)];
}

/**
 * The desk's order, exactly as the database returns it: position first, then
 * the name without regard to case, then the id so a tie is still stable.
 */
export function orderPresets(presets: readonly TicketPreset[]): TicketPreset[] {
  return [...presets].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Moving one preset one place up or down.
 *
 * Returns only the rows whose `position` actually changes, because each one is
 * a write and a history entry. A list that has never been ordered has every
 * position at 0, so the first move renumbers it — which is the honest outcome:
 * the order it was showing in was the tie-break, and now it is the desk's.
 *
 * An id that is not in the list, or a move off either end, changes nothing.
 */
export function movePreset(
  presets: readonly TicketPreset[],
  id: string,
  direction: 'up' | 'down',
): { id: string; position: number }[] {
  const ordered = orderPresets(presets);
  const from = ordered.findIndex((preset) => preset.id === id);
  if (from === -1) return [];

  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const moved = [...ordered];
  [moved[from], moved[to]] = [moved[to], moved[from]];

  return moved
    .map((preset, index) => ({ id: preset.id, position: index }))
    .filter((next, index) => moved[index].position !== next.position);
}

/**
 * What a draft is refused for, in the reader's words, or null when it is fine.
 *
 * The same rules the database applies, checked here so a typo is reported
 * beside the field rather than after a round trip. It is not the boundary.
 */
export function presetError(draft: Partial<TicketPresetDraft>): string | null {
  const name = (draft.name ?? '').trim();
  const title = (draft.title ?? '').trim();
  const issue = (draft.issue ?? '').trim();
  const location = (draft.location ?? '').trim();

  if (name === '') return 'Give the quick ticket a name.';
  if (name.length > PRESET_NAME_MAX) {
    return `A quick ticket's name is ${PRESET_NAME_MAX} characters at most.`;
  }
  if (title === '') return 'Give the quick ticket a title for the queue.';
  if (title.length > PRESET_TITLE_MAX) {
    return `A quick ticket's title is ${PRESET_TITLE_MAX} characters at most.`;
  }
  if (issue.length > PRESET_ISSUE_MAX) {
    return `A quick ticket's issue is ${PRESET_ISSUE_MAX} characters at most.`;
  }
  if (location.length > PRESET_LOCATION_MAX) {
    return `A quick ticket's location is ${PRESET_LOCATION_MAX} characters at most.`;
  }
  if (!isTicketCategory(draft.category)) return 'Choose a category for this quick ticket.';
  if (!isPriority(draft.priority)) return 'Choose a priority: low, normal, high or urgent.';
  return null;
}

/**
 * `Object.hasOwn`, not `in`, for the same reason `isTicketCategory` gives: every
 * object inherits `constructor` and `toString` from its prototype, and neither
 * is a priority.
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && Object.hasOwn(PRIORITY_LABELS, value);
}

/**
 * One row from the database, narrowed.
 *
 * A category or priority the vocabulary does not contain cannot reach here —
 * the table's own checks refuse it — but a row is still read defensively,
 * because a preset that prefills a form with a value the form cannot show would
 * be a ticket nobody could submit. Anything unrecognised falls back to what an
 * uncategorised, unprioritised call honestly is.
 */
export function presetFromRow(row: Record<string, unknown>): TicketPreset | null {
  const id = typeof row.id === 'string' ? row.id : null;
  const name = typeof row.name === 'string' ? row.name : null;
  const title = typeof row.title === 'string' ? row.title : null;
  if (id === null || name === null || title === null) return null;

  return {
    id,
    name,
    title,
    issue: typeof row.issue === 'string' ? row.issue : '',
    category: isTicketCategory(row.category) ? row.category : 'other',
    priority: isPriority(row.priority) ? row.priority : 'normal',
    location: typeof row.location === 'string' ? row.location : '',
    position: typeof row.position === 'number' ? row.position : 0,
  };
}

/** What the intake form starts from. The requester and channel are not a preset's. */
export function presetDraft(preset: TicketPreset): TicketPresetDraft {
  return {
    name: preset.name,
    title: preset.title,
    issue: preset.issue,
    category: preset.category,
    priority: preset.priority,
    location: preset.location,
  };
}
