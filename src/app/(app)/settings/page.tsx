import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadAiConnection, loadPreferences } from '@/lib/data/preferences';
import { PageHeader } from '@/components/Primitives';
import { AiSection } from '@/components/settings/AiSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { ProfileSection } from '@/components/settings/ProfileSection';
import '@/styles/settings.css';

export const metadata = { title: 'Settings — Edison Helpdesk' };

/**
 * Everything an account decides about itself, in one column.
 *
 * Nothing administrative is here: role, status and access belong to
 * `/admin` and to an administrator. Every read runs in the caller's own
 * session, and the settings a caller cannot read are their own — there is no
 * account parameter on this page to change.
 */
export default async function SettingsPage() {
  const actor = await loadActor();
  // The group layout has already redirected anyone who is not active. This is
  // the narrowing that lets the account be used, not a second gate.
  if (actor.kind !== 'active') redirect('/login');

  const [preferences, connection] = await Promise.all([loadPreferences(), loadAiConnection()]);

  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        description="Your name, how the helpdesk looks, and how the assistant behaves. These are yours alone; not even an administrator sees them."
      />
      <div className="settings-sections">
        <ProfileSection displayName={actor.account.displayName} email={actor.account.email} />
        <AppearanceSection />
        <AiSection
          connection={connection}
          reasoning={preferences.aiReasoning}
          confirmChanges={preferences.aiConfirmChanges}
          speakReplies={preferences.aiSpeakReplies}
        />
        <NotificationsSection notifyInApp={preferences.notifyInApp} />
      </div>
    </div>
  );
}
