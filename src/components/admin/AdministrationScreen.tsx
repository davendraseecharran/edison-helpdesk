/**
 * Administration.
 *
 * One tab today. It exists as a tab set rather than a bare heading because the
 * page is going to grow (devices, settings), and because a section
 * this consequential should always say which part of it you are looking at.
 * The work itself lives in AccessScreen and the panels it composes.
 */

import { Tabs } from '@/components/ui/Tabs';
import { AccessScreen } from './AccessScreen';
import type { AdminAccountView, InviteView } from '@/lib/data/admin-view';

/**
 * The tab row every administration screen shares.
 *
 * It lives here, with the first tab, rather than in each route, so the set is
 * defined once and a new section cannot appear on one page and not another.
 * The count is optional because only the people tab has one to show, and only
 * the page that already loaded the accounts knows it.
 */
export function AdminTabs({ accountCount }: { accountCount?: number }) {
  return (
    <Tabs
      items={[
        { href: '/admin', label: 'People & access', count: accountCount },
        { href: '/admin/audit', label: 'Audit log' },
        { href: '/admin/backups', label: 'Backups' },
      ]}
      label="Administration sections"
    />
  );
}

export function AdministrationScreen({
  accounts,
  invites,
  invitesError,
  currentAccountId,
}: {
  accounts: AdminAccountView[];
  invites: InviteView[];
  invitesError: string | null;
  currentAccountId: string;
}) {
  return (
    <>
      <AdminTabs accountCount={accounts.length} />
      <AccessScreen
        accounts={accounts}
        invites={invites}
        invitesError={invitesError}
        currentAccountId={currentAccountId}
      />
    </>
  );
}
