import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loadActor } from '@/lib/auth/session';
import { LoginForm } from '@/components/auth/LoginForm';

// Session-dependent: never cached or prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in — Edison Helpdesk' };

/**
 * The only public surface of the application.
 *
 * There is no demo user switcher here any more: identity comes from a real
 * password sign-in against Supabase Auth, and nothing in this page can grant
 * access without one.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ linkError?: string; signedOut?: string; setup?: string }>;
}) {
  const params = await searchParams;
  const actor = await loadActor();

  if (actor.kind === 'active') redirect('/queue');
  if (actor.kind === 'restricted') {
    redirect(actor.reason === 'credential_action_pending' ? '/set-password' : '/restricted');
  }

  const linkError =
    params.linkError === 'expired'
      ? 'That link has already been used or has expired. Ask the administrator for a new one.'
      : params.linkError === 'invalid'
        ? 'That link is not valid. Ask the administrator for a new one.'
        : null;

  const notice =
    params.setup === 'done'
      ? 'Your password is set. Sign in with it to start work.'
      : params.setup === 'recovered'
        ? 'Your password has been changed and other sessions were signed out. Sign in again.'
        : params.signedOut === '1'
          ? 'You have been signed out.'
          : null;

  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-wrap auth-wrap-single">
          <section className="auth-card" aria-labelledby="signin-heading">
            <div className="auth-head">
              <div className="brand" style={{ marginBottom: 14 }}>
                <span className="brand-mark" aria-hidden="true">
                  ED
                </span>
                <span>Edison Helpdesk</span>
              </div>
              <h1 id="signin-heading">Sign in</h1>
              <p>
                Use your school email address and the separate app password you chose for the
                helpdesk. This is not your Google password.
              </p>
            </div>

            {linkError ? (
              <p className="flash flash-error" role="alert">
                {linkError}
              </p>
            ) : null}
            {notice ? (
              <p className="flash flash-success" role="status">
                {notice}
              </p>
            ) : null}

            <LoginForm />

            <div className="auth-meta stack-sm">
              <p>
                <strong>Forgot your password?</strong> Contact the helpdesk administrator in
                person. They confirm your identity and issue a single-use recovery link directly —
                the system sends no email.
              </p>
              <p>
                Accounts are created by the administrator. There is no public sign-up.
              </p>
              <p className="small subtle">
                Need the administrator? <Link href="/restricted">What the different account states mean</Link>
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
