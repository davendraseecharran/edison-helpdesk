'use client';

/**
 * Backups.
 *
 * The school owns its records and should be able to take a copy without asking
 * anyone. Each table is one button: the server action returns the table as CSV
 * text, and the browser turns that text into a file.
 *
 * The download is built here rather than fetched from a URL on purpose. A link
 * that returned the directory would be a GET anyone could replay from a history
 * list or a shared screen; a Server Action is POST-only, carries the session,
 * and is refused outright for anybody who is not an administrator.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { exportTableCsvAction, type BackupTableView } from '@/lib/data/backup-actions';

export function BackupsScreen({ tables }: { tables: BackupTableView[] }) {
  const { notify } = useRuntime();
  const [busyTable, setBusyTable] = useState<string | null>(null);

  async function onDownload(table: BackupTableView) {
    setBusyTable(table.table);
    try {
      const outcome = await exportTableCsvAction(table.table);
      if (!outcome.ok || outcome.csv === undefined || !outcome.filename) {
        notify('error', outcome.error ?? 'That table could not be exported. Try again.');
        return;
      }
      saveCsv(outcome.filename, outcome.csv);
      // A capped export is reported as an error even though the file saved.
      // A success message leaves after five seconds and a failure stays until
      // it is dismissed, and "this backup is incomplete" is the one sentence
      // here that must not disappear before it has been read.
      notify(outcome.capped ? 'error' : 'success', outcome.message ?? 'Backup downloaded.');
    } catch {
      notify('error', 'That table could not be exported. Check your connection and try again.');
    } finally {
      setBusyTable(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="backups-heading">
      <div className="panel-head">
        <h2 className="panel-title" id="backups-heading">
          Tables
        </h2>
        <span className="panel-aside">
          {tables.length} {tables.length === 1 ? 'table' : 'tables'}
        </span>
      </div>

      <ul className="backup-list">
        {tables.map((table) => (
          <li key={table.table} className="backup-row">
            <div className="backup-text">
              <span className="backup-name">{table.label}</span>
              <span className="backup-note">{table.note}</span>
              <span className="backup-table mono">{table.table}</span>
            </div>
            <div className="backup-end">
              <span className="backup-rows">
                {table.rowCount === null
                  ? 'Count unavailable'
                  : `${table.rowCount.toLocaleString('en-US')} ${table.rowCount === 1 ? 'row' : 'rows'}`}
              </span>
              <Button
                size="sm"
                icon={Download}
                disabled={busyTable !== null && busyTable !== table.table}
                loading={busyTable === table.table}
                onClick={() => void onDownload(table)}
              >
                Download CSV
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Hands the text to the browser as a file.
 *
 * The object URL is revoked on the next frame rather than immediately: the
 * click has to be dispatched and the download started before the blob can go,
 * and a revoke in the same tick cancels the save in some browsers.
 */
function saveCsv(filename: string, csv: string) {
  // The byte order mark is for Excel, which otherwise reads a UTF-8 export as
  // the local code page and turns every accented name into mojibake.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
