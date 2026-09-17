import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_NOTES_MAX,
  DEFAULT_PREFERENCES,
  DEFAULT_WELCOME_STATES,
  displayNameChanged,
  displayNameError,
  GMAIL_MODE_LABELS,
  GMAIL_MODES,
  isGmailMode,
  isReasoningEffort,
  isThemeChoice,
  isWelcomeState,
  nextThemeAfterSave,
  parseWelcomeStates,
  pickWelcomeState,
  preferencePatch,
  preferencesFromRow,
  REASONING_CHOICES,
  REASONING_EFFORTS,
  REASONING_LABELS,
  THEME_CHOICES,
  WELCOME_STATE_LABELS,
  WELCOME_STATES,
  WELCOME_STATES_EMPTY,
  WELCOME_STATES_UNKNOWN,
  welcomeStateFromLabel,
  type WelcomeState,
} from '../src/lib/domain/preferences';

describe('defaults', () => {
  // Addendum 4: the application ships dark and does not stop to confirm every
  // change the assistant proposes. These match the column defaults in
  // 20260914100900_m5_ai_preferences.sql, and a drift here is a drift there.
  it('match the column defaults in the database', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      theme: 'dark',
      aiReasoning: 'high',
      assistantNotes: '',
      aiConfirmChanges: false,
      aiSpeakReplies: false,
      notifyInApp: true,
      gmailMode: 'to',
      aiWelcomeStates: ['generating', 'listening'],
      savedViews: [],
    });
  });

  it('offers dark first and labels every reasoning level', () => {
    expect(THEME_CHOICES[0]).toBe('dark');
    expect([...THEME_CHOICES].sort()).toEqual(['dark', 'light', 'system']);
    // The vocabulary keeps the two levels the interface no longer offers, so a
    // row written before they were dropped still renders with something chosen.
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const effort of REASONING_EFFORTS) {
      expect(REASONING_LABELS[effort]).toBeTruthy();
    }
    expect(REASONING_LABELS.xhigh).toBe('Extra high');
    expect(REASONING_LABELS.max).toBe('Max');
    // Three offered, and High first: it is the default.
    expect(REASONING_CHOICES).toEqual(['high', 'xhigh', 'max']);
    expect(DEFAULT_PREFERENCES.aiReasoning).toBe('high');
  });

  it('offers To first, because writing to people is direct', () => {
    expect(GMAIL_MODES).toEqual(['to', 'cc', 'bcc']);
    expect(GMAIL_MODE_LABELS.to).toBe('…directly');
    expect(DEFAULT_PREFERENCES.gmailMode).toBe('to');
    // Sentence case, an ellipsis rather than three full stops, and the two
    // words a mail client uses.
    expect(GMAIL_MODE_LABELS.cc).toBe('…as CC');
    expect(GMAIL_MODE_LABELS.bcc).toBe('…as BCC');
  });

  it('starts the welcome on the diamond and the wave, and names all seven', () => {
    // The column default in 20260916160200_m5_welcome_marks.sql, in that order.
    expect(DEFAULT_WELCOME_STATES).toEqual(['generating', 'listening']);
    expect(DEFAULT_PREFERENCES.aiWelcomeStates).toEqual(['generating', 'listening']);
    // A copy, not the shared constant: the settings screen holds it in state.
    expect(DEFAULT_PREFERENCES.aiWelcomeStates).not.toBe(DEFAULT_WELCOME_STATES);

    // The library's seven, each once.
    expect([...WELCOME_STATES].sort()).toEqual([
      'generating',
      'listening',
      'searching',
      'solving',
      'thinking',
      'waiting',
      'working',
    ]);
    // Named for what they look like; the state word appears in no label.
    expect(WELCOME_STATE_LABELS.generating.label).toBe('Diamond');
    expect(WELCOME_STATE_LABELS.listening.label).toBe('Wave');
    expect(WELCOME_STATE_LABELS.solving.label).toBe("Rubik's cube");
    expect(WELCOME_STATE_LABELS.searching.label).toBe('Globe');
    expect(WELCOME_STATE_LABELS.working.label).toBe('Spiral');
    expect(WELCOME_STATE_LABELS.thinking.label).toBe('Sphere');
    expect(WELCOME_STATE_LABELS.waiting.label).toBe('Rings');
    for (const state of WELCOME_STATES) {
      const { label, motion } = WELCOME_STATE_LABELS[state];
      expect(label.toLowerCase()).not.toContain(state);
      expect(motion.toLowerCase()).not.toContain(state);
      expect(motion.endsWith('.')).toBe(true);
    }
  });
});

describe('vocabulary guards', () => {
  it('accept only what the database accepts', () => {
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('system')).toBe(true);
    expect(isThemeChoice('sepia')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
    expect(isReasoningEffort('xhigh')).toBe(true);
    expect(isReasoningEffort('extreme')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
    expect(isGmailMode('cc')).toBe(true);
    expect(isGmailMode('bcc')).toBe(true);
    expect(isGmailMode('BCC')).toBe(false);
    expect(isGmailMode('to')).toBe(true);
    expect(isGmailMode(null)).toBe(false);
    expect(isWelcomeState('generating')).toBe(true);
    expect(isWelcomeState('Diamond')).toBe(false);
    expect(isWelcomeState('breathing')).toBe(false);
    expect(isWelcomeState(undefined)).toBe(false);
  });
});

describe('preferencesFromRow', () => {
  it('reads a row in the database’s column names', () => {
    expect(
      preferencesFromRow({
        account_id: 'ignored',
        theme: 'light',
        ai_reasoning: 'low',
        assistant_notes: 'I work Tuesdays and Thursdays.',
        ai_confirm_changes: true,
        ai_speak_replies: true,
        notify_in_app: false,
        gmail_mode: 'bcc',
        ai_welcome_states: ['waiting'],
        updated_at: '2026-09-13T00:00:00Z',
      }),
    ).toEqual({
      theme: 'light',
      aiReasoning: 'low',
      assistantNotes: 'I work Tuesdays and Thursdays.',
      aiConfirmChanges: true,
      aiSpeakReplies: true,
      notifyInApp: false,
      gmailMode: 'bcc',
      aiWelcomeStates: ['waiting'],
      savedViews: [],
    });
  });

  it('falls back to the default for a value this build does not know', () => {
    const row = preferencesFromRow({
      theme: 'sepia',
      ai_reasoning: 'extreme',
      gmail_mode: 'reply',
      ai_welcome_states: 'generating',
    });
    expect(row.theme).toBe('dark');
    expect(row.aiReasoning).toBe('high');
    expect(row.gmailMode).toBe('to');
    expect(row.aiWelcomeStates).toEqual(['generating', 'listening']);
  });

  it('keeps the welcome effects it knows and drops the rest', () => {
    // A newer build's word is skipped rather than failing the row, and a box
    // ticked twice by some other writer is one box.
    const row = preferencesFromRow({
      ai_welcome_states: ['solving', 'exploding', 'solving', 'thinking', 7],
    });
    expect(row.aiWelcomeStates).toEqual(['solving', 'thinking']);
    // Nothing known at all is the default, not an empty checklist.
    expect(preferencesFromRow({ ai_welcome_states: ['exploding'] }).aiWelcomeStates).toEqual([
      'generating',
      'listening',
    ]);
  });

  it('treats a missing or unusable row as the defaults', () => {
    expect(preferencesFromRow(null)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFromRow(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFromRow('nonsense')).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFromRow({})).toEqual(DEFAULT_PREFERENCES);
  });

  it('refuses a string where a switch belongs', () => {
    // "false" and 0 are the two ways a form silently turns a setting on.
    const row = preferencesFromRow({ ai_confirm_changes: 'false', notify_in_app: 0 });
    expect(row.aiConfirmChanges).toBe(false);
    expect(row.notifyInApp).toBe(true);
  });
});

describe('preferencePatch', () => {
  it('renames each key to its column and leaves the rest alone', () => {
    const result = preferencePatch({ theme: 'system', aiConfirmChanges: true });
    expect(result).toEqual({ ok: true, patch: { theme: 'system', ai_confirm_changes: true } });
  });

  it('carries every one of the eight settings', () => {
    const result = preferencePatch({
      theme: 'light',
      aiReasoning: 'medium',
      assistantNotes: 'I work Tuesdays and Thursdays.',
      aiConfirmChanges: false,
      aiSpeakReplies: true,
      notifyInApp: false,
      gmailMode: 'bcc',
      aiWelcomeStates: ['thinking'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.patch).sort()).toEqual([
      'ai_confirm_changes',
      'ai_reasoning',
      'ai_speak_replies',
      'ai_welcome_states',
      'assistant_notes',
      'gmail_mode',
      'notify_in_app',
      'theme',
    ]);
    expect(result.patch.ai_welcome_states).toEqual(['thinking']);
  });

  it('folds the welcome list and makes it a set, in the order given', () => {
    expect(preferencePatch({ aiWelcomeStates: ['Listening', ' generating', 'listening'] as never })).toEqual({
      ok: true,
      patch: { ai_welcome_states: ['listening', 'generating'] },
    });
  });

  it('refuses an empty welcome list in the sentence the checklist uses', () => {
    expect(preferencePatch({ aiWelcomeStates: [] })).toEqual({
      ok: false,
      error: 'Keep at least one welcome animation.',
    });
    expect(WELCOME_STATES_EMPTY).toBe('Keep at least one welcome animation.');
  });

  it('refuses a welcome effect it cannot play, naming the seven by their labels', () => {
    const result = preferencePatch({ aiWelcomeStates: ['generating', 'exploding'] as never });
    expect(result).toEqual({ ok: false, error: WELCOME_STATES_UNKNOWN });
    expect(WELCOME_STATES_UNKNOWN).toBe(
      "Choose welcome effects from Diamond, Globe, Rings, Rubik's cube, Sphere, Spiral, Wave.",
    );
    // The labels are what a person reads; the stored words stay out of it.
    expect(WELCOME_STATES_UNKNOWN).not.toContain('generating');
    // A non-string entry is the wrong shape, not a person's choice.
    expect(preferencePatch({ aiWelcomeStates: [3] as never }).ok).toBe(false);
  });

  it('refuses a welcome list that is not a list', () => {
    expect(preferencePatch({ aiWelcomeStates: 'generating' as never })).toEqual({
      ok: false,
      error: 'Send the welcome effects as a list.',
    });
  });

  it('trims a note and cuts it at the length the database keeps', () => {
    const padded = preferencePatch({ assistantNotes: '  Tuesdays and Thursdays.  ' });
    expect(padded).toEqual({ ok: true, patch: { assistant_notes: 'Tuesdays and Thursdays.' } });

    const long = preferencePatch({ assistantNotes: 'x'.repeat(900) });
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    expect(long.patch.assistant_notes).toHaveLength(ASSISTANT_NOTES_MAX);
  });

  it('carries an emptied note, because clearing one is a change', () => {
    expect(preferencePatch({ assistantNotes: '   ' })).toEqual({
      ok: true,
      patch: { assistant_notes: '' },
    });
  });

  it('ignores a key it does not own rather than refusing the save', () => {
    const result = preferencePatch({
      theme: 'dark',
      account_id: 'cafe',
      updated_at: 'now',
    } as never);
    expect(result).toEqual({ ok: true, patch: { theme: 'dark' } });
  });

  it('keeps a setting that was not sent', () => {
    const result = preferencePatch({ notifyInApp: false, theme: undefined });
    expect(result).toEqual({ ok: true, patch: { notify_in_app: false } });
  });

  it('refuses a value outside its vocabulary, saying what to choose', () => {
    expect(preferencePatch({ theme: 'sepia' as never })).toEqual({
      ok: false,
      error: 'Choose a theme: system, light or dark.',
    });
    expect(preferencePatch({ aiReasoning: 'extreme' as never })).toEqual({
      ok: false,
      error: 'Choose High, Extra high or Max.',
    });
    // The same sentence app_update_preferences raises, in the database's own
    // two words rather than the menu's "…as CC".
    expect(preferencePatch({ gmailMode: 'reply' as never })).toEqual({
      ok: false,
      error: 'Choose to, cc or bcc for a Gmail link.',
    });
  });

  it('refuses anything that is not a boolean for a switch', () => {
    expect(preferencePatch({ aiSpeakReplies: 'true' as never })).toEqual({
      ok: false,
      error: 'Send true or false for ai speak replies.',
    });
  });

  it('refuses an empty patch instead of writing nothing', () => {
    expect(preferencePatch({})).toEqual({ ok: false, error: 'There was nothing to save.' });
    expect(preferencePatch({ theme: undefined })).toEqual({
      ok: false,
      error: 'There was nothing to save.',
    });
  });
});

describe('parseWelcomeStates', () => {
  it('is the default for anything that is not a list of known states', () => {
    expect(parseWelcomeStates(undefined)).toEqual(['generating', 'listening']);
    expect(parseWelcomeStates('generating')).toEqual(['generating', 'listening']);
    expect(parseWelcomeStates([])).toEqual(['generating', 'listening']);
    expect(parseWelcomeStates([null, 'nothing'])).toEqual(['generating', 'listening']);
  });

  it('keeps order and drops repeats', () => {
    expect(parseWelcomeStates(['waiting', 'thinking', 'waiting'])).toEqual(['waiting', 'thinking']);
  });

  it('hands back a fresh array every time', () => {
    const first = parseWelcomeStates(undefined);
    const second = parseWelcomeStates(undefined);
    expect(first).not.toBe(second);
    expect(first).not.toBe(DEFAULT_WELCOME_STATES);
  });
});

describe('pickWelcomeState', () => {
  const list: WelcomeState[] = ['generating', 'listening', 'waiting'];

  it('takes the random source across the whole list', () => {
    expect(pickWelcomeState(list, () => 0)).toBe('generating');
    expect(pickWelcomeState(list, () => 0.34)).toBe('listening');
    expect(pickWelcomeState(list, () => 0.999)).toBe('waiting');
  });

  it('never runs off either end of the list', () => {
    // Math.random never returns 1, but an injected source might.
    expect(pickWelcomeState(list, () => 1)).toBe('waiting');
    expect(pickWelcomeState(list, () => -0.5)).toBe('generating');
  });

  it('is always the one when there is only one', () => {
    for (const roll of [0, 0.5, 0.999]) {
      expect(pickWelcomeState(['solving'], () => roll)).toBe('solving');
    }
  });

  it('picks from the default when handed nothing, rather than nothing', () => {
    expect(pickWelcomeState([], () => 0)).toBe('generating');
    expect(pickWelcomeState([], () => 0.9)).toBe('listening');
  });

  it('uses Math.random when no source is given', () => {
    expect(list).toContain(pickWelcomeState(list));
  });
});

describe('welcomeStateFromLabel', () => {
  it('reads the label a person uses, in any case, and the stored word too', () => {
    expect(welcomeStateFromLabel('Diamond')).toBe('generating');
    expect(welcomeStateFromLabel('diamond')).toBe('generating');
    expect(welcomeStateFromLabel("rubik's cube")).toBe('solving');
    expect(welcomeStateFromLabel('  wave ')).toBe('listening');
    expect(welcomeStateFromLabel('generating')).toBe('generating');
  });

  it('is null for anything else', () => {
    expect(welcomeStateFromLabel('')).toBeNull();
    expect(welcomeStateFromLabel('breathing')).toBeNull();
    expect(welcomeStateFromLabel('cube')).toBeNull();
  });
});

describe('nextThemeAfterSave', () => {
  it('keeps the new theme when the save landed', () => {
    expect(nextThemeAfterSave('dark', 'light', true, 'light')).toBe('light');
    expect(nextThemeAfterSave('light', 'system', true, 'system')).toBe('system');
  });

  it('puts the old theme back when the save was refused', () => {
    // The reader would otherwise carry on in a theme their account does not
    // have, and watch the next reload undo it.
    expect(nextThemeAfterSave('dark', 'light', false, 'light')).toBe('dark');
    expect(nextThemeAfterSave('system', 'dark', false, 'dark')).toBe('system');
  });

  it('does not revert when a newer choice is in place', () => {
    // Dark to light is still failing when the palette picks system. The stale
    // failure must settle nothing: system is what the reader asked for last.
    expect(nextThemeAfterSave('dark', 'light', false, 'system')).toBe('system');
    expect(nextThemeAfterSave('dark', 'light', false, 'dark')).toBe('dark');
  });

  it('does not re-apply a choice a newer one replaced, even when it saved', () => {
    expect(nextThemeAfterSave('dark', 'light', true, 'system')).toBe('system');
  });

  it('is a no-op when the choice did not change', () => {
    expect(nextThemeAfterSave('dark', 'dark', true, 'dark')).toBe('dark');
    expect(nextThemeAfterSave('dark', 'dark', false, 'dark')).toBe('dark');
  });
});

describe('displayNameError', () => {
  it('accepts a name inside the bounds the RPC enforces', () => {
    expect(displayNameError('Jo')).toBeNull();
    expect(displayNameError('Ms Ruiz-Okonkwo')).toBeNull();
    expect(displayNameError('x'.repeat(80))).toBeNull();
  });

  it('measures the trimmed name, not what was typed around it', () => {
    expect(displayNameError('  Jo  ')).toBeNull();
    expect(displayNameError('   ')).not.toBeNull();
    expect(displayNameError(` ${'x'.repeat(80)} `)).toBeNull();
  });

  it('says what the bounds are', () => {
    expect(displayNameError('J')).toBe('A display name has to be between 2 and 80 characters.');
    expect(displayNameError('x'.repeat(81))).toBe(
      'A display name has to be between 2 and 80 characters.',
    );
    expect(displayNameError('')).toBe('A display name has to be between 2 and 80 characters.');
  });
});

describe('displayNameChanged', () => {
  it('is false for the same name, however it was typed', () => {
    expect(displayNameChanged('Ada Byron', 'Ada Byron')).toBe(false);
    expect(displayNameChanged('  Ada Byron ', 'Ada Byron')).toBe(false);
  });

  it('is true for a real change', () => {
    expect(displayNameChanged('Ada Lovelace', 'Ada Byron')).toBe(true);
  });
});
