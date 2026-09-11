import Link from 'next/link';
import { loadActor } from '@/lib/auth/session';
import { SignOutButton } from '@/components/auth/SignOutButton';

// Session-dependent: never cached or prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Account not active — Edison Helpdesk' };

/**
 * Where a signed-in but unauthorized identity lands.
 *
 * These accounts hold a valid auth session and no helpdesk access at all: the
 * database refuses every ticket read and write for them. This screen exists so
 * that state is explained rather than looking like a broken application.
 */
export default async function RestrictedPage() {
  const actor = await loadActor();

  if (actor.kind === 'active') {
    return (
      <div className="auth-page">
        <div className="auth-main">
          <div className="auth-wrap auth-wrap-single">
            <section className="auth-card">
              <h1>Your account is active</h1>
              <p className="muted" style={{ marginTop: 8 }}>
                Nothing is restricted right now.
              </p>
              <div style={{ marginTop: 16 }}>
                <Link href="/queue" className="btn btn-primary">
                  Go to the Open Queue
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  const explanation =
    actor.kind === 'anonymous'
      ? {
          title: 'Account states',
          body: 'Sign in to see your own account. Accounts are created by the helpdesk administrator; there is no public sign-up.',
        }
      : actor.kind === 'unlinked'
        ? {
            title: 'No helpdesk account',
            body: 'You are signed in, but this identity has no helpdesk account. Ask the administrator to create one for you.',
          }
        : actor.reason === 'setup_pending'
          ? {
              title: 'Setup not finished',
              body: 'Your account exists but has no password yet. Ask the administrator for a setup link — they will hand it to you directly.',
            }
          : actor.reason === 'credential_action_pending'
            ? {
                title: 'Finish setting your password',
                body: 'A setup or recovery link is outstanding for this account. Open it and choose a password to restore access.',
              }
            : actor.reason === 'session_superseded'
              ? {
                  title: 'This session has ended',
                  body: 'Your password was changed or your account was deactivated after this session started. Sign in again.',
                }
              : {
                  title: 'Account deactivated',
                  body: 'This account has been deactivated. Your past work is preserved and still attributed to you. Ask the administrator if this is unexpected.',
                };

  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-wrap auth-wrap-single">
          <section className="auth-card" aria-labelledby="restricted-heading">
            <div className="brand" style={{ marginBottom: 14 }}>
              <span className="brand-mark" aria-hidden="true">
                ED
              </span>
              <span>Edison Helpdesk</span>
            </div>
            <h1 id="restricted-heading">{explanation.title}</h1>
            <p className="muted" style={{ marginTop: 10 }}>
              {explanation.body}
            </p>

            {actor.kind === 'restricted' ? (
              <p className="small subtle" style={{ marginTop: 12 }}>
                Signed in as {actor.account.email}
              </p>
            ) : null}

            <div className="btn-row" style={{ marginTop: 18 }}>
              {actor.kind === 'restricted' && actor.reason === 'credential_action_pending' ? (
                <Link href="/set-password" className="btn btn-primary">
                  Choose a password
                </Link>
              ) : null}
              {actor.kind === 'anonymous' ? (
                <Link href="/login" className="btn btn-primary">
                  Sign in
                </Link>
              ) : (
                <SignOutButton />
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
