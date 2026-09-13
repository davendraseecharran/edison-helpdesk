'use server';

/**
 * Table backups.
 *
 * The owner asked to be able to take the school's own copy of the data without
 * anybody's help. These two actions are that: a list of the tables with how
 * many rows each holds, and one table exported as CSV text the browser turns
 * into a file.
 *
 * Three rules hold the whole thing together.
 *
 * First, every read goes through the caller's own session client, so row-level
 * security decides what comes back exactly as it does everywhere else. Nothing
 * here uses the service role. An administrator sees every row because the
 * policies say an administrator may; the check below is a fast fail for a
 * session that clearly cannot, not the security boundary.
 *
 * Second, the table name is matched against a fixed list and the matched
 * CONSTANT is used, never the caller's string. The list is the fifteen tables
 * that hold the desk's own records; the credential, notification, preference
 * and attachment tables are deliberately absent, because a backup of them would
 * be a copy of secrets rather than a copy of records.
 *
 * Third, the reads are paged. PostgREST caps a single response (`max_rows`, a
 * thousand locally and on the hosted project), so a `select *` that looks like
 * it returns a table actually returns the first page of it. A backup that
 * silently stopped at a thousand rows would be worse than no backup at all, so
 * every table is walked a page at a time up to a stated ceiling, and an export
 * that hits the ceiling says so in the file name and on screen.
 */

import { loadActor } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { csvHeaders, encodeCsv } from '@/lib/csv';
import { SCHOOL_TIME_ZONE } from '@/lib/format';

/** One PostgREST page. The server's own cap is the real limit; this matches it. */
const READ_PAGE = 1000;

/** The most rows one download carries. Beyond it the file says it is partial. */
const ROW_CAP = 50_000;

interface TableSpec {
  /** Sentence-case name for the screen. */
  label: string;
  /** One line saying what is in it, so the list does not read as jargon. */
  note: string;
  /**
   * Newest first, with a tiebreaker, so paging is deterministic and a capped
   * export keeps the most recent rows rather than an arbitrary thousand.
   */
  order: readonly string[];
}

const TABLES = {
  tickets: {
    label: 'Tickets',
    note: 'Every request, its requester, owner, status and solution.',
    order: ['created_at', 'id'],
  },
  notes: {
    label: 'Notes',
    note: 'Working notes written on tickets.',
    order: ['created_at', 'id'],
  },
  work_logs: {
    label: 'Work logs',
    note: 'Time recorded against tickets.',
    order: ['created_at', 'id'],
  },
  activity_events: {
    label: 'Ticket history',
    note: 'Every change to every ticket, with who made it.',
    order: ['at', 'id'],
  },
  ticket_collaborators: {
    label: 'Ticket collaborators',
    note: 'Who was added to a ticket beside its owner.',
    order: ['added_at', 'ticket_id', 'account_id'],
  },
  device_observations: {
    label: 'Devices recorded on tickets',
    note: 'Machines described at the desk, whether or not they are in inventory.',
    order: ['recorded_at', 'id'],
  },
  people: {
    label: 'People',
    note: 'The directory: students and staff, with contact details.',
    order: ['created_at', 'id'],
  },
  devices: {
    label: 'Devices',
    note: 'The inventory: tags, serials, models and status.',
    order: ['created_at', 'id'],
  },
  device_assignments: {
    label: 'Device assignments',
    note: 'Who has which machine, and who had it before.',
    order: ['assigned_at', 'id'],
  },
  ticket_devices: {
    label: 'Devices linked to tickets',
    note: 'Inventory machines named on a ticket.',
    order: ['linked_at', 'ticket_id', 'device_id'],
  },
  app_accounts: {
    label: 'Accounts',
    note: 'Helpdesk sign-ins, their role and their state. No passwords.',
    order: ['created_at', 'id'],
  },
  account_events: {
    label: 'Account history',
    note: 'Approvals, role changes, deactivations and credential actions.',
    order: ['at', 'id'],
  },
  record_events: {
    label: 'People and device history',
    note: 'Every change to people, devices, invites and imports.',
    order: ['at', 'id'],
  },
  account_invites: {
    label: 'Invites',
    note: 'Addresses invited, the role offered, and what became of each.',
    order: ['created_at', 'id'],
  },
  import_runs: {
    label: 'Imports',
    note: 'Every spreadsheet import and what it changed.',
    order: ['at', 'id'],
  },
} as const satisfies Record<string, TableSpec>;

export type BackupTableName = keyof typeof TABLES;

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

const FILE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Not exported: a `'use server'` module may only export async functions. */
function isBackupTable(name: string): name is BackupTableName {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}

/**
 * The tables and their sizes.
 *
 * One head request per table — `count(*)` with no rows returned — so opening the
 * screen costs fifteen counts rather than fifteen table reads. A count that
 * fails comes back as null rather than zero: "could not be read" and "empty"
 * are different answers, and only one of them means the backup is complete.
 */
export async function loadBackupTablesAction(): Promise<BackupTableView[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') return [];

  const supabase = await createClient();
  const names = Object.keys(TABLES) as BackupTableName[];

  return Promise.all(
    names.map(async (table) => {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });
      return {
        table,
        label: TABLES[table].label,
        note: TABLES[table].note,
        rowCount: error ? null : (count ?? 0),
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
  const spec = TABLES[name];
  const supabase = await createClient();

  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < ROW_CAP; offset += READ_PAGE) {
    const size = Math.min(READ_PAGE, ROW_CAP - offset);
    let query = supabase.from(name).select('*');
    for (const column of spec.order) {
      query = query.order(column, { ascending: false });
    }
    const { data, error } = await query.range(offset, offset + size - 1);
    if (error) {
      return { ok: false, error: `${spec.label} could not be read: ${error.message}` };
    }
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < size) break;
  }

  const { count } = await supabase.from(name).select('*', { count: 'exact', head: true });
  const total = count ?? rows.length;
  const capped = rows.length >= ROW_CAP && total > rows.length;

  const day = FILE_DATE.format(new Date());
  const filename = capped
    ? `edison-${name}-${day}-newest-${ROW_CAP}.csv`
    : `edison-${name}-${day}.csv`;

  return {
    ok: true,
    filename,
    csv: encodeCsv(csvHeaders(rows), rows),
    rowCount: rows.length,
    capped,
    message: capped
      ? `${spec.label} holds ${total.toLocaleString('en-US')} rows. This file has the ${ROW_CAP.toLocaleString('en-US')} most recent; the rest needs a database export.`
      : `${spec.label}: ${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'} downloaded.`,
  };
}
