import { AuthFrame } from '@/components/auth/AuthFrame';
import { ButtonLink } from '@/components/ui/Button';

export const metadata = { title: 'Page not found — Edison Helpdesk' };

/**
 * The 404 outside the application: a bad URL reached without a session.
 *
 * `(app)/not-found.tsx` covers everything behind the sign-in gate and renders
 * inside the shell. This one is what is left, and without it Next serves its
 * own 404 — a bare white page with a system font, which in the dark theme is a
 * flash of white and in any theme is a different product's page.
 *
 * Same frame as sign-in, pending and restricted, so the four public screens
 * cannot drift apart, and the way out is the front door rather than Today: a
 * person who reached this without a session cannot use a page behind it.
 */
export default function NotFound() {
  return (
    <AuthFrame labelledBy="not-found-heading">
      <div className="auth-head">
        <h1 id="not-found-heading" className="auth-title">
          This page does not exist
        </h1>
        <p className="auth-lead">
          The address may be mistyped, or the page may have moved.
        </p>
      </div>
      <div className="auth-actions">
        <ButtonLink href="/login" variant="primary">
          Go to sign in
        </ButtonLink>
      </div>
    </AuthFrame>
  );
}
