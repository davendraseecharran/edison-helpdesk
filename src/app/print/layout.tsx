import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadPreferences } from '@/lib/data/preferences';
import { ServerTheme } from '@/components/shell/ThemeProvider';

/**
 * Pages that are made to be printed: a sheet and the two or three buttons
 * above it, with none of the application around them, so what the printer
 * gets is the sheet and nothing else.
 *
 * The same real gate the kiosk has — a live session and an active account,
 * checked against the database on every request — because what is printed
 * here is made from a signed-in account's reads.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export const metadata = {
  title: 'Print — Edison Helpdesk',
  robots: { index: false, follow: false },
};

export default async function PrintLayout({ children }: { children: ReactNode }) {
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
