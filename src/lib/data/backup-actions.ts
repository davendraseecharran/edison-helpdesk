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
 * CONSTANT is used, never the caller's string. The list is the fourteen tables
 * that hold the desk's own records; the credential, notification, preference
 * and attachment tables are deliberately absent, because a backup of them would
 * be a copy of secrets rather than a copy of records.
 *
 * Two of the fourteen are read through an RPC rather than the table. The
 * district's `inventory_devices` and `inventory_events` carry row-level
 * security with NO policies and every privilege revoked from `authenticated`:
 * the whole inventory is reached by bounded SECURITY DEFINER function, and a
 * backup is one more bounded read. `app_backup_rows` and `app_backup_count`
 * (20260914130100) are that read, and they state the same administrator-only
 * gate in their own bodies. No policy the owner wrote is loosened here.
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
import {
  cappedExportMessage,
  csvFileName,
  csvHeaders,
  CSV_ROW_CAP,
  encodeCsv,
} from '@/lib/csv';
import { schoolToday } from '@/lib/format';

/** One PostgREST page. The server's own cap is the real limit; this matches it. */
const READ_PAGE = 1000;

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
  /**
   * True for the two tables with row-level security and no policies, which a
   * session client cannot read at all. Those go through `app_backup_rows` and
   * `app_backup_count`, which order the same way this list says.
   */
  definer?: boolean;
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
  requesters: {
    label: 'People',
    note: 'The directory: students and staff, with contact details.',
    order: ['created_at', 'id'],
  },
  inventory_devices: {
    label: 'Devices',
    note: 'The inventory: tags, serials, models, status and who holds each one.',
    order: ['imported_at', 'id'],
    definer: true,
  },
  inventory_events: {
    label: 'Inventory history',
    note: 'A before and after snapshot of every change to a person or a machine.',
    order: ['at', 'id'],
    definer: true,
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
    note: 'The sentence a person reads for every change to a person or a machine.',
    order: ['at', 'id'],
  },
  account_invites: {
    label: 'Invites',
    note: 'Addresses invited, the role offered, and what became of each.',
    order: ['created_at', 'id'],
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

/** Not exported: a `'use server'` module may only export async functions. */
function isBackupTable(name: string): name is BackupTableName {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}

type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * How many rows one table holds, or null when it could not be read.
 *
 * "Could not be read" and "empty" are different answers, and only one of them
 * means the backup is complete, so a failure is never reported as zero.
 */
async function countRows(
  supabase: SessionClient,
  name: BackupTableName,
  spec: TableSpec,
): Promise<number | null> {
  if (spec.definer) {
    const { data, error } = await supabase.rpc('app_backup_count', { p_table: name });
    return error ? null : Number(data ?? 0);
  }
  const { count, error } = await supabase.from(name).select('*', { count: 'exact', head: true });
  return error ? null : (count ?? 0);
}

/** One page of one table, newest first, or the message that says why not. */
async function readPage(
  supabase: SessionClient,
  name: BackupTableName,
  spec: TableSpec,
  offset: number,
  size: number,
): Promise<{ rows?: Record<string, unknown>[]; error?: string }> {
  if (spec.definer) {
    const { data, error } = await supabase.rpc('app_backup_rows', {
      p_table: name,
      p_limit: size,
      p_offset: offset,
    });
    if (error) return { error: error.message };
    return { rows: (data ?? []) as Record<string, unknown>[] };
  }

  let query = supabase.from(name).select('*');
  for (const column of spec.order) {
    query = query.order(column, { ascending: false });
  }
  const { data, error } = await query.range(offset, offset + size - 1);
  if (error) return { error: error.message };
  return { rows: (data ?? []) as Record<string, unknown>[] };
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
  const names = Object.keys(TABLES) as BackupTableName[];

  return Promise.all(
    names.map(async (table) => {
      const spec: TableSpec = TABLES[table];
      return {
        table,
        label: spec.label,
        note: spec.note,
        rowCount: await countRows(supabase, table, spec),
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
  const spec: TableSpec = TABLES[name];
  const supabase = await createClient();

  const rows: Record<string, unknown>[] = [];
  // Set when a page came back short, which proves the table ended inside the
  // cap and saves asking the database for a count it has already implied.
  let reachedEnd = false;
  for (let offset = 0; offset < CSV_ROW_CAP && !reachedEnd; offset += READ_PAGE) {
    const size = Math.min(READ_PAGE, CSV_ROW_CAP - offset);
    const page = await readPage(supabase, name, spec, offset, size);
    if (page.error !== undefined) {
      return { ok: false, error: `${spec.label} could not be read: ${page.error}` };
    }
    rows.push(...(page.rows ?? []));
    reachedEnd = (page.rows ?? []).length < size;
  }

  // Only a run that filled the cap needs a total: every other one already read
  // the whole table, so a second count would answer a question just settled.
  let total = rows.length;
  if (!reachedEnd) {
    total = (await countRows(supabase, name, spec)) ?? rows.length;
  }
  const capped = !reachedEnd && total > rows.length;

  return {
    ok: true,
    filename: csvFileName(name, schoolToday(), capped),
    csv: encodeCsv(csvHeaders(rows), rows),
    rowCount: rows.length,
    capped,
    message: capped
      ? cappedExportMessage(spec.label, total)
      : `${spec.label}: ${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'} downloaded.`,
  };
}
