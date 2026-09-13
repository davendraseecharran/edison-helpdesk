import { notFound } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { loadBackupTablesAction } from '@/lib/data/backup-actions';
import { PageHeader } from '@/components/Primitives';
import { AdminTabs } from '@/components/admin/AdministrationScreen';
import { BackupsScreen } from '@/components/admin/BackupsScreen';

export const metadata = { title: 'Backups — Edison Helpdesk' };

export default async function BackupsPage() {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') notFound();

  const tables = await loadBackupTablesAction();

  return (
    <>
      <PageHeader
        title="Backups"
        description="Download a CSV of any table. Keep copies somewhere private; these files contain names and contact details."
      />
      <AdminTabs />
      <BackupsScreen tables={tables} />
    </>
  );
}
