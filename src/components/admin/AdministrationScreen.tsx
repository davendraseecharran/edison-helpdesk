/**
 * Administration.
 *
 * One tab today. It exists as a tab set rather than a bare heading because the
 * page is going to grow (devices, imports, settings), and because a section
 * this consequential should always say which part of it you are looking at.
 * The work itself lives in AccessScreen and the panels it composes.
 */

import { Tabs } from '@/components/ui/Tabs';
import { AccessScreen } from './AccessScreen';
import type { AdminAccountView, InviteView } from '@/lib/data/admin-view';

export function AdministrationScreen({
  accounts,
  invites,
  currentAccountId,
}: {
  accounts: AdminAccountView[];
  invites: InviteView[];
  currentAccountId: string;
}) {
  return (
    <>
      <Tabs
        items={[{ href: '/admin', label: 'People & access', count: accounts.length }]}
        label="Administration sections"
      />
      <AccessScreen
        accounts={accounts}
        invites={invites}
        currentAccountId={currentAccountId}
      />
    </>
  );
}
