import { loadActor } from '@/lib/auth/session';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { ButtonLink } from '@/components/ui/Button';

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
      <AuthFrame labelledBy="restricted-heading">
        <div className="auth-head">
          <h1 id="restricted-heading" className="auth-title">
            Your account is active
          </h1>
          <p className="auth-lead">Nothing is restricted right now.</p>
        </div>
        <div className="auth-actions">
          <ButtonLink href="/queue" variant="primary">
            Go to the queue
          </ButtonLink>
        </div>
      </AuthFrame>
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
    <AuthFrame labelledBy="restricted-heading">
      <div className="auth-head">
        <h1 id="restricted-heading" className="auth-title">
          {explanation.title}
        </h1>
        <p className="auth-lead">{explanation.body}</p>
        {actor.kind === 'restricted' ? (
          <p className="auth-identity">
            Signed in as <span className="auth-identity-value">{actor.account.email}</span>
          </p>
        ) : null}
      </div>

      <div className="auth-actions">
        {actor.kind === 'restricted' && actor.reason === 'credential_action_pending' ? (
          <ButtonLink href="/set-password" variant="primary">
            Choose a password
          </ButtonLink>
        ) : null}
        {actor.kind === 'anonymous' ? (
          <ButtonLink href="/login" variant="primary">
            Sign in
          </ButtonLink>
        ) : (
          <SignOutButton />
        )}
      </div>
    </AuthFrame>
  );
}
