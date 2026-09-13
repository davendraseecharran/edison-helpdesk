import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { loadActor } from '@/lib/auth/session';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { LoginForm } from '@/components/auth/LoginForm';
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
  }>;
}) {
  const params = await searchParams;
  const actor = await loadActor();

  if (actor.kind === 'active') redirect('/queue');
  if (actor.kind === 'restricted') {
    redirect(actor.reason === 'credential_action_pending' ? '/set-password' : '/restricted');
  }

  const error =
    params.linkError === 'expired'
      ? 'That link has already been used or has expired. Ask the administrator for a new one.'
      : params.linkError === 'invalid'
        ? 'That link is not valid. Ask the administrator for a new one.'
        : params.oauthError
          ? 'Google sign-in did not complete. Try again, or sign in with a password.'
          : null;

  const notice =
    params.setup === 'done'
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

      {/*
        Task 6b: <GoogleButton /> renders inside this slot as the primary
        action, and the disclosure below loses `open`. The slot takes no space
        while it is empty.
      */}
      <div className="auth-primary" />

      <details className="auth-disclosure" open>
        <summary>
          <Icon icon={ChevronRight} size={16} />
          Sign in with a password
        </summary>
        <div className="auth-disclosure-body">
          <p className="auth-hint">
            Use your school email address and the separate app password you chose for the
            helpdesk. This is not your Google password.
          </p>
          <LoginForm />
        </div>
      </details>

      <div className="auth-foot">
        <p>
          <strong>Forgot your password?</strong> Contact the helpdesk administrator in person.
          They confirm your identity and issue a single-use recovery link directly — the system
          sends no email.
        </p>
        <p>Accounts are created by the administrator. There is no public sign-up.</p>
        <p>
          Need the administrator?{' '}
          <Link href="/restricted">What the different account states mean</Link>
        </p>
      </div>
    </AuthFrame>
  );
}
