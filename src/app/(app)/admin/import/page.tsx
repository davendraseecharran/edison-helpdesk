import { notFound } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { listImportRunsAction } from '@/lib/data/import-actions';
import { PageHeader } from '@/components/Primitives';
import { AdminTabs } from '@/components/admin/AdministrationScreen';
import { ImportHistory } from '@/components/admin/ImportHistory';
import { ImportScreen } from '@/components/admin/ImportScreen';
import '@/styles/admin-import.css';

export const metadata = { title: 'Import — Edison Helpdesk' };

export default async function ImportPage() {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') notFound();

  const history = await listImportRunsAction();

  return (
    <>
      <PageHeader
        title="Import"
        description="Bring the student directory, the staff directory and the master inventory in from a CSV export. Every import is checked against the database first, and nothing is written until you say so."
      />
      <AdminTabs />
      <div className="stack">
        <ImportScreen />
        <ImportHistory runs={history.runs} loadError={history.error} />
      </div>
    </>
  );
}
