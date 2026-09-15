'use server';

/**
 * Table backups.
 *
 * The owner asked to be able to take the school's own copy of the data without
 * anybody's help. These two actions are that: a list of the tables with how
 * many rows each holds, and one table exported as CSV text the browser turns
 * into a file.
 *
 * Three rules hold the whole thing together, and all three live in
 * `backup-tables.ts` now, because the assistant's `export_backup` tool has to
 * obey exactly the same ones and a `'use server'` module can export nothing but
 * async functions to share them with.
 *
 * First, every read goes through the caller's own session client, so row-level
 * security decides what comes back exactly as it does everywhere else. Nothing
 * here uses the service role. An administrator sees every row because the
 * policies say an administrator may; the check below is a fast fail for a
 * session that clearly cannot, not the security boundary.
 *
 * Second, the table name is matched against a fixed list and the matched
 * CONSTANT is used, never the caller's string.
 *
 * Third, the reads are paged, and an export that hits the ceiling says so in
 * the file name and on screen.
 */

import { loadActor } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import {
  BACKUP_TABLES,
  BACKUP_TABLE_NAMES,
  countBackupRows,
  isBackupTable,
  readBackupTable,
  type BackupTableName,
  type TableSpec,
} from '@/lib/data/backup-tables';
import {
  cappedExportMessage,
  csvFileName,
  csvHeaders,
  CSV_ROW_CAP,
  encodeCsv,
} from '@/lib/csv';
import { schoolToday } from '@/lib/format';

export interface BackupTableView {
  table: BackupTableName;
  label: string;
  note: string;
  /** Null when the count could not be read; the screen says so rather than "0". */
  rowCount: number | null;
}

export interface BackupCsvResult {
  ok: boolean;
  error?: string;
  /** The file name the browser should save it as. */
  filename?: string;
  csv?: string;
  rowCount?: number;
  /** True when the table holds more rows than one download carries. */
  capped?: boolean;
  /** What to tell the owner afterwards, capped or not. */
  message?: string;
}

/**
 * The tables and their sizes.
 *
 * One head request per table — `count(*)` with no rows returned — so opening the
 * screen costs fourteen counts rather than fourteen table reads.
 */
export async function loadBackupTablesAction(): Promise<BackupTableView[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') return [];

  const supabase = await createClient();

  return Promise.all(
    BACKUP_TABLE_NAMES.map(async (table) => {
      const spec: TableSpec = BACKUP_TABLES[table];
      return {
        table,
        label: spec.label,
        note: spec.note,
        rowCount: await countBackupRows(supabase, table, spec),
      };
    }),
  );
}

/**
 * One table as RFC 4180 CSV text.
 *
 * The text is returned rather than streamed as a response: a Server Action is
 * POST-only and carries the session, whereas a download URL would be a GET that
 * hands the school's directory to anything that can replay the link. The client
 * turns the text into a Blob and saves it.
 */
export async function exportTableCsvAction(table: string): Promise<BackupCsvResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session cannot download backups. Sign in again.' };
  }
  if (actor.account.role !== 'admin') {
    return { ok: false, error: 'Only an administrator can download a backup.' };
  }
  if (!isBackupTable(table)) {
    return { ok: false, error: 'That is not a table this screen can export.' };
  }

  // The matched constant, not the caller's string.
  const name: BackupTableName = table;
  const spec: TableSpec = BACKUP_TABLES[name];
  const supabase = await createClient();

  const read = await readBackupTable(supabase, name, CSV_ROW_CAP);
  if ('error' in read) return { ok: false, error: read.error };

  return {
    ok: true,
    filename: csvFileName(name, schoolToday(), read.capped),
    csv: encodeCsv(csvHeaders(read.rows), read.rows),
    rowCount: read.rows.length,
    capped: read.capped,
    message: read.capped
      ? cappedExportMessage(spec.label, read.total)
      : `${spec.label}: ${read.rows.length.toLocaleString('en-US')} ${read.rows.length === 1 ? 'row' : 'rows'} downloaded.`,
  };
}
