'use client';

/**
 * Notifications: what the helpdesk tells you about while you are using it.
 *
 * In-app only. There is no email switch here because the helpdesk sends no
 * notification email; the only addresses it writes to are invites and password
 * links, which are not something to opt out of.
 */

import { PreferenceSwitch, SettingsSection } from './parts';

export function NotificationsSection({ notifyInApp }: { notifyInApp: boolean }) {
  return (
    <SettingsSection
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
    </SettingsSection>
  );
}
