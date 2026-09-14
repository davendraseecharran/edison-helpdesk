/**
 * Previous imports.
 *
 * Every commit writes an `import_runs` row and a history entry, so this list is
 * the answer to "when did the roster last come in, and who brought it". It sits
 * below the four steps rather than on its own tab because the question it
 * answers is usually asked while preparing the next import.
 *
 * Dry runs are absent on purpose: nothing happened, so there is nothing to
 * account for.
 */

import { ActorLabel } from '@/components/ui/ActorLabel';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatDateTime } from '@/lib/format';
import type { ImportRunView } from '@/lib/data/import-actions';

function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function ImportHistory({
  runs,
  loadError,
}: {
  runs: ImportRunView[];
  /** Set when the list could not be read. An empty list is not the same thing. */
  loadError: string | null;
}) {
  const columns: Column<ImportRunView>[] = [
    {
      key: 'at',
      header: 'When',
      width: 200,
      hideOnPhone: true,
      cell: (run) => formatDateTime(run.at),
    },
    {
      key: 'who',
      header: 'Who',
      width: 200,
      hideOnPhone: true,
      cell: (run) => <ActorLabel name={run.actorName} />,
    },
    {
      key: 'kind',
      header: 'What',
      width: 110,
      cell: (run) => (run.kind === 'devices' ? 'Devices' : 'People'),
    },
    {
      key: 'added',
      header: 'Added',
      align: 'right',
      width: 92,
      cell: (run) => count(run.inserted),
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      width: 92,
      cell: (run) => count(run.updated),
    },
    {
      key: 'unchanged',
      header: 'Unchanged',
      align: 'right',
      width: 108,
      cell: (run) => count(run.unchanged),
    },
    {
      key: 'problems',
      header: 'Problems',
      align: 'right',
      width: 148,
      cell: (run) => (
        <>
          {run.errorCount === 0 ? <span className="muted">None</span> : count(run.errorCount)}
          {/* Not an error: the machines imported, nobody was recorded as
              holding them. Worth seeing beside the run that caused it. */}
          {run.unmatched > 0 ? (
            <span className="admin-sub">
              {count(run.unmatched)} {run.unmatched === 1 ? 'holder' : 'holders'} not matched
            </span>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <section className="panel" aria-labelledby="import-history-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="import-history-heading">
          Previous imports
        </h2>
        <span className="panel-aside">
          {runs.length === 0 ? 'None yet' : `${count(runs.length)} shown`}
        </span>
      </div>

      {loadError ? (
        <div className="panel-body">
          <p className="flash flash-error" role="alert">
            {loadError}
          </p>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={runs}
        rowKey={(run) => run.id}
        caption="Imports that were committed, newest first"
        cardTitle={(run) => (run.kind === 'devices' ? 'Devices' : 'People')}
        cardMeta={(run) => `${formatDateTime(run.at)}, by ${run.actorName}`}
        empty={
          <p className="muted">
            {loadError ? 'The import history is unavailable.' : 'No imports yet.'}
          </p>
        }
      />
    </section>
  );
}
