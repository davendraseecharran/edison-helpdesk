'use client';

/**
 * What an import would do, and what it did.
 *
 * Three pieces, shared by the dry run and by the panel that appears after a
 * commit, because an administrator reading "what will happen" and "what
 * happened" should be reading the same thing in the same order.
 *
 * The summary strip is four separate chips rather than one sentence: a count
 * somebody is checking against a spreadsheet should be a thing you can point
 * at, and the problem chip is the only one that carries a colour, because it is
 * the only one that asks for anything.
 */

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import {
  holderLabel,
  type ImportSummary,
  type RowProblem,
  type UnmatchedHolder,
} from '@/lib/data/import-plan';

export function ImportChips({ summary }: { summary: ImportSummary }) {
  return (
    <ul className="import-chips">
      {summary.chips.map((chip) => (
        <li
          key={chip.key}
          className={chip.tone === 'problem' ? 'import-chip import-chip-problem' : 'import-chip'}
        >
          {chip.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The rows that will not land, by the number they have in the spreadsheet.
 *
 * `detail` is the database's own words and stays quiet: it is there for whoever
 * is debugging the import rather than for whoever is fixing the sheet.
 */
export function ImportProblems({
  problems,
  onDownload,
}: {
  problems: RowProblem[];
  onDownload?: () => void;
}) {
  const columns: Column<RowProblem>[] = [
    {
      key: 'row',
      header: 'Row',
      width: 84,
      mono: true,
      hideOnPhone: true,
      cell: (problem) => (problem.row > 0 ? problem.row : 'File'),
    },
    {
      key: 'message',
      header: 'Problem',
      cell: (problem) => (
        <>
          <span className="import-problem-message">{problem.message}</span>
          {problem.detail ? <span className="import-problem-detail">{problem.detail}</span> : null}
        </>
      ),
    },
  ];

  return (
    <div className="stack-sm">
      <div className="import-subhead">
        <h3 className="import-subtitle">Rows with problems</h3>
        {onDownload ? (
          <Button size="sm" icon={Download} onClick={onDownload}>
            Download problem rows
          </Button>
        ) : null}
      </div>
      <p className="panel-note">
        These rows are skipped. Everything else in the file still imports. Fix them in the
        spreadsheet and import the file again.
      </p>
      <DataTable
        columns={columns}
        rows={problems}
        rowKey={(problem) => `${problem.row}:${problem.message}`}
        caption="Rows that could not be imported, by their row number in the file"
        cardTitle={(problem) => (problem.row > 0 ? `Row ${problem.row}` : 'This file')}
        empty={<p className="muted">No problems.</p>}
      />
    </div>
  );
}

/**
 * Machines whose holder is not in the directory.
 *
 * Not an error: the device imports, it simply stays unassigned until the person
 * exists. Importing the student and staff files first is what fixes it, which
 * is why the note says so rather than leaving it to be worked out.
 */
export function ImportUnmatched({ holders }: { holders: UnmatchedHolder[] }) {
  const columns: Column<UnmatchedHolder>[] = [
    {
      key: 'row',
      header: 'Row',
      width: 84,
      mono: true,
      hideOnPhone: true,
      cell: (entry) => entry.row,
    },
    {
      key: 'holder',
      header: 'Held by',
      cell: (entry) => holderLabel(entry.holder),
    },
  ];

  return (
    <div className="stack-sm">
      <h3 className="import-subtitle">Holders not in the directory</h3>
      <p className="panel-note">
        These machines import, but nobody is recorded as holding them. Import the student and staff
        files first, then import this one again to record the loans.
      </p>
      <DataTable
        columns={columns}
        rows={holders}
        rowKey={(entry) => `${entry.row}`}
        caption="Devices whose holder could not be matched to a person"
        cardTitle={(entry) => `Row ${entry.row}`}
        empty={<p className="muted">Every holder was matched.</p>}
      />
    </div>
  );
}
