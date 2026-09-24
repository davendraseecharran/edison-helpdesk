import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadPreferences } from '@/lib/data/preferences';
import { ServerTheme } from '@/components/shell/ThemeProvider';
import '@/styles/forms.css';

/**
 * The kiosk: a signed-in device at a door, with none of the application
 * around it.
 *
 * Outside `(app)` so there is no rail, no top bar and no palette for a
 * passer-by to open, and the same real gate the application has: a live
 * session and an active account, checked against the database on every
 * request. The account that signed the device in is the one every check-in
 * and every response is attributed to.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export const metadata = {
  title: 'Kiosk — Edison Helpdesk',
  robots: { index: false, follow: false },
};

export default async function KioskLayout({ children }: { children: ReactNode }) {
  const actor = await loadActor();
  if (actor.kind === 'anonymous') redirect('/login');
  if (actor.kind === 'unlinked') redirect('/restricted');
  if (actor.kind === 'restricted') {
    if (actor.reason === 'credential_action_pending') redirect('/set-password');
    if (actor.reason === 'pending_approval') redirect('/pending');
    redirect(actor.reason === 'denied' ? '/restricted?reason=denied' : '/restricted');
  }

  const preferences = await loadPreferences();
  return (
    <>
      <ServerTheme theme={preferences.theme} />
      {children}
    </>
  );
}
