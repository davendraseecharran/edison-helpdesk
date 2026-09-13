'use client';

/**
 * The pieces every settings section is built from.
 *
 * One shape for the whole screen: a section is a heading, a line saying what
 * the settings below it do, and a card of rows. A row is a label, an optional
 * hint and one control on the right, which becomes a stack on a phone.
 *
 * Nothing here has a Save button. A control saves when it is changed, reports
 * through the runtime like every other action in the application, and shows the
 * value it has again if the save did not land — so what is on screen is always
 * either what is stored or what is on its way there, never a form the reader
 * has to remember to submit.
 */

import { useCallback, useId, useState, type ReactNode } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { updatePreferencesAction } from '@/lib/data/preferences-actions';
import type { PreferencePatch } from '@/lib/domain/preferences';

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">{title}</h2>
        <p className="settings-section-note">{description}</p>
      </div>
      <div className="settings-card">{children}</div>
    </section>
  );
}

/** One setting: what it is on the left, the control that changes it on the right. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {hint ? <span className="setting-row-hint">{hint}</span> : null}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

/**
 * Saves one patch of settings and says whether it landed.
 *
 * The patch goes through the runtime's `run()`, so two controls cannot save at
 * once, the success message is the toast, and a refusal from the database is
 * shown in the reader's own words rather than swallowed.
 */
export function useSavePreference(): {
  /** True while any action is running, including one started elsewhere. */
  busy: boolean;
  save: (key: string, patch: PreferencePatch, message: string) => Promise<boolean>;
} {
  const { pendingKey, run } = useRuntime();

  const save = useCallback(
    async (key: string, patch: PreferencePatch, message: string): Promise<boolean> => {
      const result = await run(key, async () => {
        const outcome = await updatePreferencesAction(patch);
        return outcome.ok ? { ok: true, message } : outcome;
      });
      return result.ok;
    },
    [run],
  );

  return { busy: pendingKey !== null, save };
}

/**
 * A switch bound to one boolean setting.
 *
 * It moves the moment it is pressed and only settles once the save has landed:
 * a refusal puts it back to the value the server gave, so the switch never
 * keeps showing a setting the database refused. While a save is running the
 * switch stays focused and ignores presses rather than being disabled
 * underneath the reader's finger.
 *
 * After the first render the switch is the one that knows: a save that lands
 * gives it the same value back, and nothing else in the application changes
 * these settings underneath it.
 */
export function PreferenceSwitch({
  label,
  hint,
  checked,
  field,
  message = 'Setting saved.',
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  field: 'aiConfirmChanges' | 'aiSpeakReplies' | 'notifyInApp';
  message?: string;
}) {
  const { busy, save } = useSavePreference();
  const [on, setOn] = useState(checked);
  const labelId = useId();
  const hintId = useId();

  async function toggle() {
    if (busy) return;
    const next = !on;
    setOn(next);
    const saved = await save(field, { [field]: next }, message);
    if (!saved) setOn(checked);
  }

  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label" id={labelId}>
          {label}
        </span>
        {hint ? (
          <span className="setting-row-hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </div>
      <div className="setting-row-control">
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hint ? hintId : undefined}
          aria-disabled={busy || undefined}
          onClick={() => void toggle()}
        >
          <span className="switch-thumb" />
        </button>
      </div>
    </div>
  );
}
