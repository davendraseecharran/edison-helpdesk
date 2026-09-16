import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadSignInMethods } from '@/lib/auth/sign-in-methods';
import {
  loadAiConnection,
  loadPreferences,
  loadSharedAssistantNotes,
} from '@/lib/data/preferences';
import { PageHeader } from '@/components/Primitives';
import { AiSection } from '@/components/settings/AiSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { SignInMethodsSection } from '@/components/settings/SignInMethodsSection';
import '@/styles/settings.css';

export const metadata = { title: 'Settings — Edison Helpdesk' };

/**
 * Everything an account decides about itself, in one column.
 *
 * Nothing administrative is here: role, status and access belong to
 * `/admin` and to an administrator. Every read runs in the caller's own
 * session, and the settings a caller cannot read are their own — there is no
 * account parameter on this page to change.
 *
 * One setting on it is not personal: the school's shared notes for the
 * assistant, which every active account reads and every active account may
 * edit. It is here rather than under `/admin` precisely because it is not an
 * administrator's to own.
 *
 * The two parameters this page reads are the only things it is ever told by a
 * URL, and both are outcomes of adding a Google identity — the one action here
 * that leaves the application and comes back. Neither names a destination, so
 * neither can steer anything; they choose between three sentences.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; linkError?: string }>;
}) {
  const params = await searchParams;
  const actor = await loadActor();
  // The group layout has already redirected anyone who is not active. This is
  // the narrowing that lets the account be used, not a second gate.
  if (actor.kind !== 'active') redirect('/login');

  const [preferences, connection, sharedNotes, methods] = await Promise.all([
    loadPreferences(),
    loadAiConnection(),
    loadSharedAssistantNotes(),
    loadSignInMethods(),
  ]);

  const linkError =
    params.linkError === 'off'
      ? 'Linking is switched off for this site. An administrator turns it on in Supabase.'
      : params.linkError
        ? 'Google did not finish linking. Nothing changed. Try again.'
        : null;
  const linked = params.linked === '1' && methods.googleEmail !== null;

  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        description="Your name, how you sign in, how the helpdesk looks, and how the assistant behaves. These are yours alone, apart from the shared notes, which the whole team writes."
      />
      {linkError ? (
        <p className="flash flash-error" role="alert">
          {linkError}
        </p>
      ) : null}
      {linked ? (
        <p className="flash flash-success" role="status">
          Google is linked to this account. Either way in now works.
        </p>
      ) : null}
      <div className="settings-sections">
        <ProfileSection displayName={actor.account.displayName} email={actor.account.email} />
        <SignInMethodsSection
          googleEmail={methods.googleEmail}
          hasPassword={methods.hasPassword}
        />
        <AppearanceSection />
        <AiSection
          connection={connection}
          reasoning={preferences.aiReasoning}
          confirmChanges={preferences.aiConfirmChanges}
          speakReplies={preferences.aiSpeakReplies}
          notes={preferences.assistantNotes}
          sharedNotes={sharedNotes}
        />
        <NotificationsSection notifyInApp={preferences.notifyInApp} />
      </div>
    </div>
  );
}
