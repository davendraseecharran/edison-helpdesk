/**
 * Account preferences: the vocabulary, the defaults and the rules for reading
 * and changing them.
 *
 * Pure on purpose. The database owns these settings — `app_my_preferences()`
 * creates the row, `app_update_preferences()` accepts eight keys and refuses a
 * value outside its vocabulary — and this module is the same knowledge in
 * TypeScript, so the settings screen can label a control, fall back sensibly
 * when a row holds something this build does not know about, and refuse an
 * impossible patch before a round trip. It is not a security boundary: every
 * rule here is enforced again inside the RPC.
 */

import type { LogoState } from 'thinking-logos';
import type { ThemePreference } from '@/components/shell/theme-script';
import { parseSavedViews, type SavedView } from './saved-views';

/**
 * The theme vocabulary, taken from the provider rather than retyped, so a
 * choice the provider cannot resolve can never reach the database.
 */
export type ThemeChoice = ThemePreference;

/** How hard the assistant thinks before it answers. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Where a Gmail link puts its addresses: To, CC or BCC.
 *
 * Writing to people is direct, so To is the default. A chapter mailing may be
 * a CC — everybody on it should see who else is — and a mailing to guardians
 * a BCC, because one family's address is not another family's business.
 * Whichever somebody picks is nearly always the one they want next time, so
 * it is a setting rather than a question.
 */
export type GmailMode = 'to' | 'cc' | 'bcc';

export const GMAIL_MODES: readonly GmailMode[] = ['to', 'cc', 'bcc'];

/** What the three choices are called where they are offered. */
export const GMAIL_MODE_LABELS: Record<GmailMode, string> = {
  to: '…directly',
  cc: '…as CC',
  bcc: '…as BCC',
};

export const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light', 'system'];

/**
 * What the mark does while the assistant's welcome is on screen.
 *
 * The seven are the library's seven logo states, typed as such so the stored
 * vocabulary cannot drift from what the canvas can play. Nobody chooses
 * "generating", though: on screen each one is named for what it looks like,
 * and the state names stay in the database and the code.
 */
export type WelcomeState = LogoState;

/** Every welcome effect, in the order the checklist shows them. */
export const WELCOME_STATES: readonly WelcomeState[] = [
  'generating',
  'searching',
  'waiting',
  'solving',
  'thinking',
  'working',
  'listening',
];

/**
 * What each effect is called and, in a line, what it does. The labels are the
 * words the settings screen and the assistant's tool both use, so "the
 * diamond" means the same thing whichever way it is asked for.
 */
export const WELCOME_STATE_LABELS: Record<WelcomeState, { label: string; motion: string }> = {
  generating: { label: 'Diamond', motion: 'A crystal, stitched back into the mark.' },
  searching: { label: 'Globe', motion: 'A globe swept by a meridian.' },
  waiting: { label: 'Rings', motion: 'A bellows of stacked rings.' },
  solving: { label: "Rubik's cube", motion: 'A cube that scrambles and clicks back.' },
  thinking: { label: 'Sphere', motion: 'A sphere that gathers into the mark.' },
  working: { label: 'Spiral', motion: 'A thread wound into a knot.' },
  listening: { label: 'Wave', motion: 'A floating body that pulses.' },
};

/** The two everybody starts with, matching the column default. */
export const DEFAULT_WELCOME_STATES: readonly WelcomeState[] = ['generating', 'listening'];

/** The refusal for an empty list, word for word what the RPC raises. */
export const WELCOME_STATES_EMPTY = 'Keep at least one welcome animation.';

/** The labels, joined the way a refusal names them. */
const WELCOME_LABEL_LIST = WELCOME_STATES.map((state) => WELCOME_STATE_LABELS[state].label).join(', ');

export const WELCOME_STATES_UNKNOWN = `Choose welcome effects from ${WELCOME_LABEL_LIST}.`;

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
  /** Where this account's Gmail links put their addresses: To, CC or BCC. */
  gmailMode: GmailMode;
  /** What the welcome's mark may do. One of these is picked each time it opens. */
  aiWelcomeStates: WelcomeState[];
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
  gmailMode: 'to',
  aiWelcomeStates: [...DEFAULT_WELCOME_STATES],
};

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice);
}

export function isWelcomeState(value: unknown): value is WelcomeState {
  return WELCOME_STATES.includes(value as WelcomeState);
}

/**
 * A stored list of welcome effects, as the row holds it.
 *
 * Known states only, each once, in the order given; anything else is dropped
 * rather than refused, because this is the READ side and a row written by a
 * newer build must still render a checklist with something ticked. A list
 * that comes to nothing is the default, for the same reason.
 */
export function parseWelcomeStates(value: unknown): WelcomeState[] {
  if (!Array.isArray(value)) return [...DEFAULT_WELCOME_STATES];
  const states: WelcomeState[] = [];
  for (const entry of value) {
    if (isWelcomeState(entry) && !states.includes(entry)) states.push(entry);
  }
  return states.length === 0 ? [...DEFAULT_WELCOME_STATES] : states;
}

/**
 * The effect the welcome shows this time: one of the list, at random.
 *
 * A list of one is always that one. `random` is `Math.random` in the panel
 * and an injected source in the tests, so the choice can be asserted.
 */
export function pickWelcomeState(
  states: readonly WelcomeState[],
  random: () => number = Math.random,
  /**
   * The one shown last time, left out of the draw when there is a choice.
   * Two effects ticked and a fair coin repeats half the time, and a repeat
   * reads as "it is not random" rather than as chance; with more than one to
   * choose from, the next is always a different one. One ticked is always
   * that one, whatever this says.
   */
  avoid: WelcomeState | null = null,
): WelcomeState {
  const chosen = states.length > 0 ? states : DEFAULT_WELCOME_STATES;
  const pool = chosen.length > 1 && avoid !== null ? chosen.filter((state) => state !== avoid) : chosen;
  const index = Math.floor(random() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, index))];
}

/**
 * The label a person used, back to the state it names.
 *
 * Case does not matter and the stored word is accepted too, so "diamond",
 * "Diamond" and "generating" all reach the same column value. Null for
 * anything else; the caller decides what to say.
 */
export function welcomeStateFromLabel(word: string): WelcomeState | null {
  const folded = word.trim().toLowerCase();
  if (folded === '') return null;
  if (isWelcomeState(folded)) return folded;
  for (const state of WELCOME_STATES) {
    if (WELCOME_STATE_LABELS[state].label.toLowerCase() === folded) return state;
  }
  return null;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function isGmailMode(value: unknown): value is GmailMode {
  return GMAIL_MODES.includes(value as GmailMode);
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
    gmailMode: isGmailMode(source.gmail_mode) ? source.gmail_mode : DEFAULT_PREFERENCES.gmailMode,
    aiWelcomeStates: parseWelcomeStates(source.ai_welcome_states),
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
  gmailMode?: GmailMode;
  aiWelcomeStates?: WelcomeState[];
}

export type PatchResult =
  | { ok: true; patch: Record<string, string | boolean | string[]> }
  | { ok: false; error: string };

/**
 * Turns a patch into the JSON the RPC takes, in its column names.
 *
 * Only the eight keys the database whitelists are carried across, so a form
 * that posts its whole state back cannot smuggle a ninth; a key that is
 * absent keeps the value it had. The messages match the ones the RPC raises, so
 * the reader sees the same sentence whichever side refuses.
 */
export function preferencePatch(patch: PreferencePatch): PatchResult {
  const out: Record<string, string | boolean | string[]> = {};

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

  if (patch.gmailMode !== undefined) {
    if (!isGmailMode(patch.gmailMode)) {
      return { ok: false, error: 'Choose to, cc or bcc for a Gmail link.' };
    }
    out.gmail_mode = patch.gmailMode;
  }

  if (patch.aiWelcomeStates !== undefined) {
    if (!Array.isArray(patch.aiWelcomeStates)) {
      return { ok: false, error: 'Send the welcome effects as a list.' };
    }
    // Folded and made a set here as well as in the RPC, so what the screen
    // shows after a save is what was stored: a box ticked twice is one box.
    const states: WelcomeState[] = [];
    for (const entry of patch.aiWelcomeStates) {
      const word = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
      if (!isWelcomeState(word)) return { ok: false, error: WELCOME_STATES_UNKNOWN };
      if (!states.includes(word)) states.push(word);
    }
    if (states.length === 0) return { ok: false, error: WELCOME_STATES_EMPTY };
    out.ai_welcome_states = states;
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
