import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { loadActor } from '@/lib/auth/session';
import { isScanPath } from '@/lib/scan/relay';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { LoginForm } from '@/components/auth/LoginForm';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { Icon } from '@/components/ui/Icon';

// Session-dependent: never cached or prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in — Edison Helpdesk' };

/**
 * The only public surface of the application.
 *
 * Identity comes from a real sign-in against Supabase Auth, and nothing in
 * this page can grant access without one. The primary action slot is reserved
 * for Google sign-in; the password form sits in a disclosure beneath it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    linkError?: string;
    signedOut?: string;
    setup?: string;
    oauthError?: string;
    invite?: string;
    next?: string;
  }>;
}) {
  const params = await searchParams;
  const actor = await loadActor();

  /**
   * The one page this login will return somebody to.
   *
   * A phone that photographed a QR code was on its way to `/scan/<uuid>` when
   * it was asked to sign in, and it has to arrive there or the technician
   * walks back to the desktop and starts again. `isScanPath` is the whole
   * allow-list: one shape, on this origin, and anything else — another route,
   * another host, a full URL — is dropped without comment rather than
   * corrected. Both sign-in paths check it again for themselves.
   */
  const next = isScanPath(params.next) ? params.next : undefined;

  if (actor.kind === 'active') redirect(next ?? '/queue');
  if (actor.kind === 'restricted') {
    // Same routing as the app group, so arriving here signed-in never hides the
    // one thing the person needs to read.
    if (actor.reason === 'credential_action_pending') redirect('/set-password');
    if (actor.reason === 'pending_approval') redirect('/pending');
    redirect(actor.reason === 'denied' ? '/restricted?reason=denied' : '/restricted');
  }

  const error =
    params.linkError === 'expired'
      ? 'That link has already been used or has expired. Ask the administrator for a new one.'
      : params.linkError === 'invalid'
        ? 'That link is not valid. Ask the administrator for a new one.'
        : params.oauthError === 'unverified'
          ? 'Google did not confirm that email address. Use a Google account with a verified email.'
          : params.oauthError === 'full'
            ? 'Access requests are full right now. Ask an administrator to review the waiting list.'
            : params.oauthError
              ? 'Google sign-in did not complete. Try again, or sign in with a password.'
              : null;

  const notice = next
    ? // A phone that was opening a pairing and was stopped here. Saying so is
      // the difference between "why am I being asked to sign in" and "of
      // course, this is the helpdesk".
      'Sign in to send scans to your desktop.'
    : params.setup === 'done'
      ? 'Your password is set. Sign in with it to start work.'
      : params.setup === 'recovered'
        ? 'Your password has been changed and other sessions were signed out. Sign in again.'
        : params.invite === 'accepted'
          ? 'Your invite was accepted. Sign in to start.'
          : params.signedOut === '1'
            ? 'You have been signed out.'
            : null;

  return (
    <AuthFrame labelledBy="signin-heading">
      <div className="auth-head">
        <h1 id="signin-heading" className="auth-title">
          Sign in
        </h1>
      </div>

      {error ? (
        <p className="flash flash-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="flash flash-success" role="status">
          {notice}
        </p>
      ) : null}

      <div className="auth-primary">
        <GoogleButton next={next} />
        <p className="auth-hint">
          Use the Google account your administrator invited. No invite yet? Sign in anyway and an
          administrator will review your request.
        </p>
      </div>

      <details className="auth-disclosure">
        <summary>
          <Icon icon={ChevronRight} size={16} />
          Sign in with a password
        </summary>
        <div className="auth-disclosure-body">
          <p className="auth-hint">
            Use your school email address and the separate app password you chose for the
            helpdesk. This is not your Google password.
          </p>
          <LoginForm next={next} />
        </div>
      </details>

      <div className="auth-foot">
        <p>
          <strong>No invite?</strong> Signing in with Google still works: it creates a request an
          administrator answers, and you can reach nothing until they do.
        </p>
        <p>
          <strong>Password trouble?</strong> Passwords are only for people who cannot use a Google
          account. Ask the helpdesk administrator in person; they confirm who you are and hand you
          a single-use recovery link directly.
        </p>
        <p>
          Need the administrator?{' '}
          <Link href="/restricted">What the different account states mean</Link>
        </p>
      </div>
    </AuthFrame>
  );
}
