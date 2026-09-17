import { notFound } from 'next/navigation';
import { loadActor } from '@/lib/auth/session';
import { canWorkTickets } from '@/lib/auth/roles';
import { loadDevicesDue } from '@/lib/data/today';
import { requestTime } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { DueBackList } from '@/components/devices/DueBackList';
import '@/styles/directory.css';

export const metadata = { title: 'Devices due back — Edison Helpdesk' };

/** Rows on the page. The rule can name thousands; nobody works down more than this in one sitting. */
const PAGE = 1000;

function heading(count: number, shown: number): string {
  if (count === 0) return 'Nothing is due back.';
  const what = count === 1 ? 'One machine is' : `${count} machines are`;
  return shown < count
    ? `${what} due back. The ${shown} oldest are here.`
    : `${what} due back, oldest first.`;
}

/**
 * Every machine due back: a holder who has left, or a repair nobody has
 * touched for a fortnight. Today shows the six oldest and points here.
 */
export default async function DevicesDueBackPage() {
  const actor = await loadActor();
  // Inventory is ticket work. The function would answer anybody else with an
  // empty list, but a page that says "nothing is due back" to somebody who
  // was never going to return anything is a wrong answer, not a quiet one.
  if (actor.kind !== 'active' || !canWorkTickets(actor.account.roles)) notFound();

  const due = await loadDevicesDue(PAGE);
  const now = requestTime();

  return (
    <>
      <PageHeader
        title="Devices due back"
        description={
          <>
            {heading(due.count, due.rows.length)} A machine is due back when the person holding it has
            graduated or left, or when it has sat in repair untouched for fourteen days.
          </>
        }
      />
      {due.rows.length > 0 ? (
        <DueBackList devices={due.rows} now={now} />
      ) : (
        <p className="subtle">Every machine is either with somebody who is here, or on the bench this fortnight.</p>
      )}
    </>
  );
}
