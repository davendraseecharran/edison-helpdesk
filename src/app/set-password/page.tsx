import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loadActor } from '@/lib/auth/session';
import { SetPasswordForm } from '@/components/auth/SetPasswordForm';

// Session-dependent: never cached or prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Choose your app password — Edison Helpdesk' };

/**
 * Reached only by exchanging a setup or recovery link at /auth/confirm.
 *
 * The session that gets here is restricted: the account is either still
 * setup_pending or has credential_action_pending set, and in both cases the
 * database refuses every helpdesk read and write until the password is actually
 * set through the trusted flow.
 */
export default async function SetPasswordPage() {
  const actor = await loadActor();

  if (actor.kind === 'anonymous') {
    redirect('/login?linkError=invalid');
  }
  if (actor.kind === 'unlinked') {
    redirect('/restricted');
  }
  // An ordinary active session has no business here.
  if (actor.kind === 'active') {
    redirect('/queue');
  }
  if (actor.reason === 'inactive' || actor.reason === 'session_superseded') {
    redirect('/restricted');
  }

  const isSetup = actor.account.status === 'setup_pending';

  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-wrap auth-wrap-single">
          <section className="auth-card" aria-labelledby="setup-heading">
            <div className="auth-head">
              <div className="brand" style={{ marginBottom: 14 }}>
                <span className="brand-mark" aria-hidden="true">
                  ED
                </span>
                <span>Edison Helpdesk</span>
              </div>
              <h1 id="setup-heading">
                {isSetup ? 'Choose your app password' : 'Choose a new app password'}
              </h1>
              <p>
                This password is only for the helpdesk. It is separate from your school account,
                and the administrator cannot see it.
              </p>
              <p className="small subtle" style={{ marginTop: 8 }}>
                Signed in as {actor.account.email}
              </p>
            </div>

            <p className="notice" style={{ marginBottom: 16 }}>
              {isSetup
                ? 'Your account cannot open tickets until this is finished.'
                : 'Until you finish, this account cannot open tickets, and every other signed-in session will be signed out when you do.'}
            </p>

            <SetPasswordForm isSetup={isSetup} />

            <div className="auth-meta">
              <Link href="/login">Return to sign in</Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
