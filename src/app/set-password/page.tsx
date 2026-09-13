import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { AuthFrame } from '@/components/auth/AuthFrame';
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
  // The Google path has no password step at all: an account waiting for or
  // refused an access decision is answered by an administrator, not by a form.
  if (actor.reason === 'pending_approval') {
    redirect('/pending');
  }
  if (actor.reason === 'denied') {
    redirect('/restricted?reason=denied');
  }
  if (actor.reason === 'inactive' || actor.reason === 'session_superseded') {
    redirect('/restricted');
  }

  const isSetup = actor.account.status === 'setup_pending';

  return (
    <AuthFrame labelledBy="setup-heading">
      <div className="auth-head">
        <h1 id="setup-heading" className="auth-title">
          {isSetup ? 'Choose your app password' : 'Choose a new app password'}
        </h1>
        <p className="auth-lead">
          This password is only for the helpdesk. It is separate from your school account, and
          the administrator cannot see it.
        </p>
        <p className="auth-identity">
          Signed in as <span className="auth-identity-value">{actor.account.email}</span>
        </p>
      </div>

      <p className="flash">
        {isSetup
          ? 'Your account cannot open tickets until this is finished.'
          : 'Until you finish, this account cannot open tickets, and every other signed-in session will be signed out when you do.'}
      </p>

      <SetPasswordForm isSetup={isSetup} />

      <div className="auth-foot">
        <p>
          <Link href="/login">Return to sign in</Link>
        </p>
      </div>
    </AuthFrame>
  );
}
