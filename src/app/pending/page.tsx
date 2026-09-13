import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { SignOutButton } from '@/components/auth/SignOutButton';

// Session-dependent: never cached or prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Waiting for approval — Edison Helpdesk' };

/**
 * Where a signed-in identity with no invite waits.
 *
 * Google proved which address this person owns. That is all it proved, so the
 * account exists with no access at all until an administrator answers. This
 * screen is deliberately separate from /restricted: waiting for a decision is
 * a normal step, not a failure, and telling somebody their account is "not
 * active" when nobody has looked at it yet produces support requests rather
 * than answering them.
 *
 * It lives outside the (app) group, so it renders without the shell — there is
 * no queue, no counts and no directory to show someone who can read none of it.
 */
export default async function PendingPage() {
  const actor = await loadActor();

  if (actor.kind === 'anonymous') redirect('/login');
  if (actor.kind === 'active') redirect('/queue');
  // Any other restricted state has its own screen and its own explanation.
  if (actor.kind === 'unlinked' || actor.reason !== 'pending_approval') redirect('/restricted');

  return (
    <AuthFrame labelledBy="pending-heading">
      <div className="auth-head">
        <h1 id="pending-heading" className="auth-title">
          Your request is waiting for an administrator
        </h1>
        <p className="auth-lead">
          You signed in successfully, and the helpdesk administrator now decides whether this
          account gets access and what it may do. Until then you can reach nothing here, and
          nothing you do is lost — sign in again later and this page becomes the queue.
        </p>
        <p className="auth-identity">
          Signed in as <span className="auth-identity-value">{actor.account.email}</span>
        </p>
      </div>

      <div className="auth-actions">
        <SignOutButton />
      </div>

      <div className="auth-foot">
        <p>
          <strong>In a hurry?</strong> Ask the helpdesk administrator to approve you. Your request
          is already waiting for them in Administration.
        </p>
        <p>
          Signed in with the wrong Google account? Sign out and start again with the address your
          administrator invited.
        </p>
        <p>
          <Link href="/restricted">What the different account states mean</Link>
        </p>
      </div>
    </AuthFrame>
  );
}
