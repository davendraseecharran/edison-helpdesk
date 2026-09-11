import { redirect } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { adminAccountsView } from '@/lib/data/admin-view';
import { PageHeader } from '@/components/Primitives';
import { AdministrationScreen } from '@/components/admin/AdministrationScreen';

export const metadata = { title: 'Administration — Edison Helpdesk' };

export default async function AdministrationPage() {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    redirect('/queue');
  }

  const accounts = await adminAccountsView();

  return (
    <>
      <PageHeader
        title="Administration"
        description="Helpdesk accounts, their setup state, and the single-use links you hand over in person. Technicians never need hosting or database accounts."
      />
      <AdministrationScreen accounts={accounts} currentAccountId={actor.account.id} />
    </>
  );
}
