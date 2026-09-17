'use client';

/**
 * Profile: the name everybody else sees, and the address this account signs in
 * with.
 *
 * The one section with a Save button. A name is typed rather than chosen, so
 * saving on every keystroke would record a change per letter and rewrite the
 * account history with each one; the reader says when they are done. Everything
 * else on this screen saves itself.
 *
 * The bounds shown here are the ones `app_update_display_name` enforces, so the
 * reader is told while they are still typing instead of after a failed save.
 */

import { useId, useState } from 'react';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { updateDisplayNameAction } from '@/lib/data/preferences-actions';
import {
  displayNameChanged,
  displayNameError,
  DISPLAY_NAME_MAX,
} from '@/lib/domain/preferences';
import { SettingRow, SettingsSection } from './parts';

export function ProfileSection({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const { pendingKey, run } = useRuntime();
  const [name, setName] = useState(displayName);
  const [touched, setTouched] = useState(false);
  const fieldId = useId();

  const problem = displayNameError(name);
  const changed = displayNameChanged(name, displayName);
  const saving = pendingKey === 'display-name';

  async function save() {
    if (problem || !changed) return;
    const result = await run('display-name', async () => {
      const outcome = await updateDisplayNameAction(name);
      return outcome.ok ? { ok: true, message: 'Name saved.' } : outcome;
    });
    if (result.ok) setName(name.trim());
  }

  return (
    <SettingsSection
      id="profile"
      title="Profile"
      description="Your name as it appears on tickets, notes and every entry in a history."
    >
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label="Display name"
          htmlFor={fieldId}
          error={touched ? problem : null}
          className="settings-name-field"
        >
          <input
            id={fieldId}
            type="text"
            value={name}
            maxLength={DISPLAY_NAME_MAX}
            autoComplete="name"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          loading={saving}
          disabled={!changed || problem !== null}
        >
          Save name
        </Button>
      </form>

      <SettingRow label="Email address" hint="The address you sign in with.">
        <span className="setting-value">{email}</span>
      </SettingRow>
    </SettingsSection>
  );
}
