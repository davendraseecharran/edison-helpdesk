import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { loadActor } from '@/lib/auth/session';
import { loadUnreadCount } from '@/lib/data/notifications';
import { loadPreferences } from '@/lib/data/preferences';
import { loadCounts, loadDirectory, loadRequesters } from '@/lib/data/tickets';
import { schoolToday } from '@/lib/format';
import { AppRuntimeProvider } from '@/components/AppRuntime';
import { AppShell } from '@/components/shell/AppShell';
import { ServerTheme } from '@/components/shell/ThemeProvider';

/**
 * Authenticated pages are rendered per request and never cached.
 *
 * This applies to every route in the group. One user's queue can therefore
 * never be served to another, and a signed-out or deactivated session cannot be
 * handed a page that was built while it was still authorized.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Gate for every authenticated page.
 *
 * This is a real check, not an optimistic one: it verifies the session against
 * the auth server and asks the database for the account's live role and status
 * on every request. Direct navigation to any route inside this group therefore
 * cannot bypass it. The database enforces the same rules again on every query,
 * so a mistake here would still not expose ticket data.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const actor = await loadActor();

  if (actor.kind === 'anonymous') redirect('/login');
  if (actor.kind === 'unlinked') redirect('/restricted');
  if (actor.kind === 'restricted') {
    if (actor.reason === 'credential_action_pending') redirect('/set-password');
    // The two Google-path states get their own screens: waiting for a decision
    // is not a failure, and a refusal must say so plainly rather than reading
    // as a deactivated account.
    if (actor.reason === 'pending_approval') redirect('/pending');
    redirect(actor.reason === 'denied' ? '/restricted?reason=denied' : '/restricted');
  }

  const [counts, directory, requesters, preferences, unreadNotifications] = await Promise.all([
    loadCounts(),
    loadDirectory(),
    loadRequesters(),
    loadPreferences(),
    loadUnreadCount(),
  ]);

  return (
    <AppRuntimeProvider
      actor={actor.account}
      directory={directory}
      requesters={requesters}
      today={schoolToday()}
    >
      {/* The account's stored theme, handed up to the provider in the root
          layout, which is above this one and knows nothing about accounts. */}
      <ServerTheme theme={preferences.theme} />
      <AppShell
        counts={counts}
        unreadNotifications={unreadNotifications}
        notifyInApp={preferences.notifyInApp}
      >
        {children}
      </AppShell>
    </AppRuntimeProvider>
  );
}
