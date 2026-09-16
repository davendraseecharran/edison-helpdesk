/**
 * Account preferences: the vocabulary, the defaults and the rules for reading
 * and changing them.
 *
 * Pure on purpose. The database owns these settings — `app_my_preferences()`
 * creates the row, `app_update_preferences()` accepts six keys and refuses a
 * value outside its vocabulary — and this module is the same knowledge in
 * TypeScript, so the settings screen can label a control, fall back sensibly
 * when a row holds something this build does not know about, and refuse an
 * impossible patch before a round trip. It is not a security boundary: every
 * rule here is enforced again inside the RPC.
 */

import type { ThemePreference } from '@/components/shell/theme-script';
import { parseSavedViews, type SavedView } from './saved-views';

/**
 * The theme vocabulary, taken from the provider rather than retyped, so a
 * choice the provider cannot resolve can never reach the database.
 */
export type ThemeChoice = ThemePreference;

/** How hard the assistant thinks before it answers. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light', 'system'];
/**
 * Everything the database accepts.
 *
 * `low` and `medium` are still here because rows written before the levels were
 * narrowed hold them, and a value this build could not read would leave a
 * settings screen with nothing selected. They are no longer offered.
 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * What the interface offers: three levels, and High is the default.
 *
 * Below High the assistant stops being worth asking — it is doing multi-step
 * work against a real database, and a cheap answer to "who has this device"
 * that is wrong costs more than the seconds it saved.
 */
export const REASONING_CHOICES: readonly ReasoningEffort[] = ['high', 'xhigh', 'max'];

/** What the reasoning levels are called in the interface. */
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * The length both note boxes take, and both writers in the database cut at.
 *
 * A note is pasted into every conversation this account ever has, so its cost
 * is paid on every turn rather than once. Past a short paragraph it stops being
 * context and becomes documentation, which belongs on a page somebody chose to
 * open.
 */
export const ASSISTANT_NOTES_MAX = 600;

export interface Preferences {
  theme: ThemeChoice;
  /** Filter sets this account named. Newest first. */
  savedViews: SavedView[];
  aiReasoning: ReasoningEffort;
  /** What this account wants its own assistant to know. Nobody else sees it. */
  assistantNotes: string;
  /** Whether the assistant stops to ask before it applies a change. */
  aiConfirmChanges: boolean;
  aiSpeakReplies: boolean;
  notifyInApp: boolean;
}

/**
 * What a reader gets before choosing anything, matching the column defaults in
 * `account_preferences`: the application ships dark, thinks hard, and does not
 * interrupt to confirm every change.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  savedViews: [],
  aiReasoning: 'high',
  assistantNotes: '',
  aiConfirmChanges: false,
  aiSpeakReplies: false,
  notifyInApp: true,
};

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/**
 * One `account_preferences` row as the application sees it.
 *
 * A value this build does not recognise falls back to the default rather than
 * rendering an empty control: a newer vocabulary written by a newer deployment
 * must not leave a reader looking at a settings screen with nothing selected.
 */
export function preferencesFromRow(row: unknown): Preferences {
  if (!row || typeof row !== 'object') return DEFAULT_PREFERENCES;
  const source = row as Record<string, unknown>;
  return {
    theme: isThemeChoice(source.theme) ? source.theme : DEFAULT_PREFERENCES.theme,
    savedViews: parseSavedViews(source.saved_views),
    aiReasoning: isReasoningEffort(source.ai_reasoning)
      ? source.ai_reasoning
      : DEFAULT_PREFERENCES.aiReasoning,
    assistantNotes:
      typeof source.assistant_notes === 'string'
        ? source.assistant_notes
        : DEFAULT_PREFERENCES.assistantNotes,
    aiConfirmChanges:
      typeof source.ai_confirm_changes === 'boolean'
        ? source.ai_confirm_changes
        : DEFAULT_PREFERENCES.aiConfirmChanges,
    aiSpeakReplies:
      typeof source.ai_speak_replies === 'boolean'
        ? source.ai_speak_replies
        : DEFAULT_PREFERENCES.aiSpeakReplies,
    notifyInApp:
      typeof source.notify_in_app === 'boolean'
        ? source.notify_in_app
        : DEFAULT_PREFERENCES.notifyInApp,
  };
}

/** The settings one save may change. Everything is optional; nothing else is read. */
export interface PreferencePatch {
  theme?: ThemeChoice;
  aiReasoning?: ReasoningEffort;
  assistantNotes?: string;
  aiConfirmChanges?: boolean;
  aiSpeakReplies?: boolean;
  notifyInApp?: boolean;
}

export type PatchResult =
  | { ok: true; patch: Record<string, string | boolean> }
  | { ok: false; error: string };

/**
 * Turns a patch into the JSON the RPC takes, in its column names.
 *
 * Only the six keys the database whitelists are carried across, so a form that
 * posts its whole state back cannot smuggle a seventh; a key that is absent keeps
 * the value it had. The messages match the ones the RPC raises, so the reader
 * sees the same sentence whichever side refuses.
 */
export function preferencePatch(patch: PreferencePatch): PatchResult {
  const out: Record<string, string | boolean> = {};

  if (patch.theme !== undefined) {
    if (!isThemeChoice(patch.theme)) {
      return { ok: false, error: 'Choose a theme: system, light or dark.' };
    }
    out.theme = patch.theme;
  }

  if (patch.aiReasoning !== undefined) {
    if (!isReasoningEffort(patch.aiReasoning)) {
      // The words the interface offers, in the interface's own spelling. `low`
      // and `medium` are still accepted values — older accounts carry them —
      // but no screen offers either, so naming them in the message sends the
      // reader looking for a control that is not there.
      return { ok: false, error: 'Choose High, Extra high or Max.' };
    }
    out.ai_reasoning = patch.aiReasoning;
  }

  if (patch.assistantNotes !== undefined) {
    if (typeof patch.assistantNotes !== 'string') {
      return { ok: false, error: 'Send your notes for the assistant as text.' };
    }
    // Trimmed and cut here as well as in the RPC, so what the screen shows
    // after a save is what was stored rather than what was typed.
    out.assistant_notes = patch.assistantNotes.trim().slice(0, ASSISTANT_NOTES_MAX);
  }

  const flags: [keyof PreferencePatch, string][] = [
    ['aiConfirmChanges', 'ai_confirm_changes'],
    ['aiSpeakReplies', 'ai_speak_replies'],
    ['notifyInApp', 'notify_in_app'],
  ];
  for (const [key, column] of flags) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return { ok: false, error: `Send true or false for ${column.replace(/_/g, ' ')}.` };
    }
    out[column] = value;
  }

  if (Object.keys(out).length === 0) {
    return { ok: false, error: 'There was nothing to save.' };
  }
  return { ok: true, patch: out };
}

/**
 * The theme that should be showing once a save has come back.
 *
 * A theme is applied before it is saved, because waiting on a round trip to
 * repaint would be worse than the rare undo. If the database refuses it, the
 * one the account actually has is what belongs on screen: leaving the new one
 * would have the reader working in a theme their next reload takes away.
 *
 * `current` is what is showing at the moment the save came back, and it is
 * what makes this safe to call late. Nothing about a theme choice is queued —
 * the command palette changes it without waiting on anything — so a slow save
 * can land after a newer choice has replaced it. A save only settles the
 * choice it was made for: if something newer is in place, that one stands,
 * whether this save succeeded or failed.
 */
export function nextThemeAfterSave(
  previous: ThemeChoice,
  next: ThemeChoice,
  saved: boolean,
  current: ThemeChoice,
): ThemeChoice {
  if (current !== next) return current;
  return saved ? next : previous;
}

/** The length `app_update_display_name` accepts, after trimming. */
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 80;

/**
 * Why a display name cannot be saved, or null when it can.
 *
 * The same bounds the RPC enforces, checked here so the reader is told while
 * they are still typing rather than after a failed save.
 */
export function displayNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
    return `A display name has to be between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters.`;
  }
  return null;
}

/** Whether saving this name would change anything. Re-saving is not a change. */
export function displayNameChanged(name: string, current: string): boolean {
  return name.trim() !== current.trim();
}
