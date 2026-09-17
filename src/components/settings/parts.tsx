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
import { Switch } from '@/components/ui/shadcn/switch';
import { updatePreferencesAction } from '@/lib/data/preferences-actions';
import type { PreferencePatch } from '@/lib/domain/preferences';

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  /** Names the section so a link can land on it, as `/settings#quick-tickets` does. */
  id?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" id={id}>
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
  /** The key of the save in flight, so a control can tell its own from another's. */
  savingKey: string | null;
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

  return { savingKey: pendingKey, save };
}

/**
 * A switch bound to one boolean setting.
 *
 * It moves the moment it is pressed and only settles once the save has landed:
 * a refusal puts it back to the value the server gave, so the switch never
 * keeps showing a setting the database refused. While its own save is in
 * flight it dims and ignores presses, but keeps focus rather than being
 * disabled underneath the reader's finger — and only that switch dims, not
 * every switch on the screen.
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
  const { savingKey, save } = useSavePreference();
  const [on, setOn] = useState(checked);
  const labelId = useId();
  const hintId = useId();
  const saving = savingKey === field;

  async function toggle() {
    if (saving) return;
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
        {/*
          * While this switch's own save is in flight it keeps focus and
          * ignores presses; a save started by another control leaves it alone.
          *
          * `aria-disabled` rather than `disabled`, because a focused element
          * that becomes `disabled` is not focused any more — the browser hands
          * focus back to `<body>`, so every keyboard toggle threw the caret
          * out of the settings list for as long as the save took and left it
          * at the top of the page afterwards. The press it still takes is
          * refused in `toggle`, which is where the rule belongs: the switch is
          * not unavailable, it is busy with the last press.
          */}
        <Switch
          checked={on}
          aria-labelledby={labelId}
          aria-describedby={hint ? hintId : undefined}
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          onCheckedChange={() => void toggle()}
        />
      </div>
    </div>
  );
}
