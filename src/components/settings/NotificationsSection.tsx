'use client';

/**
 * Notifications: what the helpdesk tells you about while you are using it.
 *
 * In-app notices, and one email: the Monday week in review, sent only where
 * the deployment has mail set up. Invites and password links are not
 * something to opt out of, so they have no switch.
 */

import { useId, useState } from 'react';
import Link from 'next/link';
import { setWeeklySummaryEmailAction } from '@/lib/data/summary-actions';
import { useRuntime } from '@/components/AppRuntime';
import { Switch } from '@/components/ui/shadcn/switch';
import { PreferenceSwitch, SettingsSection } from './parts';

function WeeklyEmailSwitch({ checked, mail }: { checked: boolean; mail: boolean }) {
  const { notify } = useRuntime();
  const [on, setOn] = useState(checked);
  const [saving, setSaving] = useState(false);
  const labelId = useId();
  const hintId = useId();

  async function toggle() {
    if (saving) return;
    const next = !on;
    setOn(next);
    setSaving(true);
    const result = await setWeeklySummaryEmailAction(next);
    setSaving(false);
    if (!result.ok) setOn(!next);
    notify(result.ok ? 'success' : 'error', result.ok ? (result.message ?? 'Saved.') : (result.error ?? 'Not saved.'));
  }

  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label" id={labelId}>
          Email me my week on Mondays
        </span>
        <span className="setting-row-hint" id={hintId}>
          {mail ? (
            <>
              What you resolved, the events you ran and the forms answered. The same week is always at{' '}
              <Link href="/summary">Your week</Link>.
            </>
          ) : (
            <>
              This deployment has no email set up, so the week arrives as a notice instead, and is always at{' '}
              <Link href="/summary">Your week</Link>.
            </>
          )}
        </span>
      </div>
      <div className="setting-row-control">
        <Switch
          checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          onCheckedChange={() => void toggle()}
        />
      </div>
    </div>
  );
}

export function NotificationsSection({
  notifyInApp,
  weeklyEmail = true,
  mail = false,
}: {
  notifyInApp: boolean;
  weeklyEmail?: boolean;
  mail?: boolean;
}) {
  return (
    <SettingsSection
      id="notifications"
      title="Notifications"
      description="What the helpdesk tells you about while you are signed in."
    >
      <PreferenceSwitch
        field="notifyInApp"
        checked={notifyInApp}
        label="Show notifications in the app"
        hint="A ticket assigned to you, a ticket you returned being claimed, an access request waiting for an answer."
        message="Notification setting saved."
      />
      <WeeklyEmailSwitch checked={weeklyEmail} mail={mail} />
    </SettingsSection>
  );
}
