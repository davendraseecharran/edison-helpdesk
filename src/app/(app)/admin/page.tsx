import { notFound } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadAdminAccounts, loadInvites } from '@/lib/data/admin-view';
import { PageHeader } from '@/components/Primitives';
import { AdministrationScreen } from '@/components/admin/AdministrationScreen';

export const metadata = { title: 'Administration — Edison Helpdesk' };

export default async function AdministrationPage() {
  const actor = await loadActor();
  // Not a redirect, and the same answer the audit and backups routes give: a
  // technician has no business knowing the administration section exists, and
  // sending them to the queue instead would confirm that it does.
  if (actor.kind !== 'active' || actor.account.role !== 'admin') notFound();

  // Both reads run in the administrator's own session, so row-level security
  // and the invite RPC's own admin check decide what comes back.
  const [accounts, invites] = await Promise.all([loadAdminAccounts(), loadInvites()]);

  return (
    <>
      <PageHeader
        title="Administration"
        description="Who may use the helpdesk and as what. People sign in with Google; an invite sets the role an address gets, and anyone signing in without one waits here for a decision."
      />
      <AdministrationScreen
        accounts={accounts}
        invites={invites.invites}
        invitesError={invites.error}
        currentAccountId={actor.account.id}
      />
    </>
  );
}
