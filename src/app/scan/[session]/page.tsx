/**
 * The page a photographed QR code opens.
 *
 * It lives outside the `(app)` group because it is not the application: no
 * top bar, no rail, no queue counts, nothing but a camera. It is not outside
 * the authentication, though, and the order below is the whole security
 * argument of this feature:
 *
 *   1. Who is this? `loadActor()` verifies the session against the auth
 *      server and asks the database for the account's live status. An
 *      anonymous visitor is sent to sign in and brought back here, because
 *      the QR code is on a screen in a corridor and somebody who is not
 *      signed in is exactly who might photograph it.
 *   2. Only then, what is this session? `app_scan_session` is SECURITY
 *      INVOKER, so it returns nothing at all for a pairing belonging to
 *      another account — the same nothing it returns for an id that never
 *      existed. Nothing on this page is rendered before that answer, so the
 *      label the desktop chose cannot leak to whoever holds the photograph.
 *
 * The id in the URL is therefore not a credential and is not treated as one.
 * It is a pointer, and it only means anything to the phone of the person who
 * opened the dialog.
 */

import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadPreferences } from '@/lib/data/preferences';
import { scanSessionAction } from '@/lib/data/scan-actions';
import { isSessionId, scanPath } from '@/lib/scan/relay';
import { PhoneScanner } from '@/components/scan/PhoneScanner';
import { ServerTheme } from '@/components/shell/ThemeProvider';
import '@/styles/scan.css';

// A pairing is live for half an hour and personal to one account: never
// cached, never prerendered, never shared.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export const metadata = {
  title: 'Scan — Edison Helpdesk',
  robots: { index: false, follow: false },
};

export default async function ScanPage({
  params,
}: {
  params: Promise<{ session: string }>;
}) {
  const { session } = await params;
  const actor = await loadActor();

  if (actor.kind === 'anonymous') {
    // `next` is carried only for this page's own shape. A segment that is not
    // a session id is dropped rather than echoed into the login URL.
    redirect(
      isSessionId(session)
        ? `/login?next=${encodeURIComponent(scanPath(session))}`
        : '/login',
    );
  }
  if (actor.kind === 'unlinked') redirect('/restricted');
  if (actor.kind === 'restricted') {
    if (actor.reason === 'credential_action_pending') redirect('/set-password');
    if (actor.reason === 'pending_approval') redirect('/pending');
    redirect(actor.reason === 'denied' ? '/restricted?reason=denied' : '/restricted');
  }

  const preferences = await loadPreferences();
  const view = isSessionId(session) ? await scanSessionAction(session) : null;

  return (
    <>
      <ServerTheme theme={preferences.theme} />
      {view ? (
        <PhoneScanner
          session={view.id}
          label={view.label}
          active={view.active}
          stopped={view.endedAt !== null}
        />
      ) : (
        <div className="scan-phone scan-phone-gone">
          <h1 className="scan-phone-title">That pairing is not available</h1>
          <p className="scan-phone-sub">
            It may have been stopped, or it may belong to a different account. Start a new one
            from the desktop and scan the new code.
          </p>
        </div>
      )}
    </>
  );
}
