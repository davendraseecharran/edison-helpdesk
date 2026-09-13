import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  displayNameChanged,
  displayNameError,
  isReasoningEffort,
  isThemeChoice,
  nextThemeAfterSave,
  preferencePatch,
  preferencesFromRow,
  REASONING_EFFORTS,
  REASONING_LABELS,
  THEME_CHOICES,
} from '../src/lib/domain/preferences';

describe('defaults', () => {
  // Addendum 4: the application ships dark and does not stop to confirm every
  // change the assistant proposes. These match the column defaults in
  // 20260912100900_m5_ai_preferences.sql, and a drift here is a drift there.
  it('match the column defaults in the database', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      theme: 'dark',
      aiReasoning: 'high',
      aiConfirmChanges: false,
      aiSpeakReplies: false,
      notifyInApp: true,
    });
  });

  it('offers dark first and labels every reasoning level', () => {
    expect(THEME_CHOICES[0]).toBe('dark');
    expect([...THEME_CHOICES].sort()).toEqual(['dark', 'light', 'system']);
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh']);
    for (const effort of REASONING_EFFORTS) {
      expect(REASONING_LABELS[effort]).toBeTruthy();
    }
    expect(REASONING_LABELS.xhigh).toBe('Extra high');
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
  });
});

describe('preferencesFromRow', () => {
  it('reads a row in the database’s column names', () => {
    expect(
      preferencesFromRow({
        account_id: 'ignored',
        theme: 'light',
        ai_reasoning: 'low',
        ai_confirm_changes: true,
        ai_speak_replies: true,
        notify_in_app: false,
        updated_at: '2026-09-13T00:00:00Z',
      }),
    ).toEqual({
      theme: 'light',
      aiReasoning: 'low',
      aiConfirmChanges: true,
      aiSpeakReplies: true,
      notifyInApp: false,
    });
  });

  it('falls back to the default for a value this build does not know', () => {
    const row = preferencesFromRow({ theme: 'sepia', ai_reasoning: 'extreme' });
    expect(row.theme).toBe('dark');
    expect(row.aiReasoning).toBe('high');
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

  it('carries every one of the five settings', () => {
    const result = preferencePatch({
      theme: 'light',
      aiReasoning: 'medium',
      aiConfirmChanges: false,
      aiSpeakReplies: true,
      notifyInApp: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.patch).sort()).toEqual([
      'ai_confirm_changes',
      'ai_reasoning',
      'ai_speak_replies',
      'notify_in_app',
      'theme',
    ]);
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
      error: 'Choose a reasoning level: low, medium, high or xhigh.',
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

describe('nextThemeAfterSave', () => {
  it('keeps the new theme when the save landed', () => {
    expect(nextThemeAfterSave('dark', 'light', true)).toBe('light');
    expect(nextThemeAfterSave('light', 'system', true)).toBe('system');
  });

  it('puts the old theme back when the save was refused', () => {
    // The reader would otherwise carry on in a theme their account does not
    // have, and watch the next reload undo it.
    expect(nextThemeAfterSave('dark', 'light', false)).toBe('dark');
    expect(nextThemeAfterSave('system', 'dark', false)).toBe('system');
  });

  it('is a no-op when the choice did not change', () => {
    expect(nextThemeAfterSave('dark', 'dark', true)).toBe('dark');
    expect(nextThemeAfterSave('dark', 'dark', false)).toBe('dark');
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
