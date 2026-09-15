/**
 * What a backup is OF, and how one table is read a page at a time.
 *
 * Extracted from `backup-actions.ts` for one reason: a `'use server'` module may
 * only export async functions, so the table catalogue, the name check and the
 * paging could not be shared with anything. The assistant's `export_backup`
 * tool needs exactly those three, and a second copy of the fourteen-table list
 * is a second list to forget to update.
 *
 * Nothing here is authorization. Every read goes through the client it is
 * handed — the caller's own session, never the service role — so row-level
 * security decides what comes back exactly as it does everywhere else. The two
 * definer tables are the exception that proves it: `inventory_devices` and
 * `inventory_events` carry row-level security with NO policies and every
 * privilege revoked from `authenticated`, so the whole inventory is reached by
 * bounded SECURITY DEFINER function, and `app_backup_rows`/`app_backup_count`
 * state the administrator-only gate in their own bodies.
 *
 * The name is matched against this list and the matched CONSTANT is used, never
 * the caller's string. The list is the fourteen tables that hold the desk's own
 * records; the credential, notification, preference and attachment tables are
 * deliberately absent, because a backup of them would be a copy of secrets
 * rather than a copy of records.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One PostgREST page. The server's own cap is the real limit; this matches it. */
export const READ_PAGE = 1000;

export interface TableSpec {
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

export const BACKUP_TABLES = {
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

export type BackupTableName = keyof typeof BACKUP_TABLES;

export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTableName[];

export function isBackupTable(name: string): name is BackupTableName {
  return Object.prototype.hasOwnProperty.call(BACKUP_TABLES, name);
}

/**
 * How many rows one table holds, or null when it could not be read.
 *
 * "Could not be read" and "empty" are different answers, and only one of them
 * means the backup is complete, so a failure is never reported as zero.
 */
export async function countBackupRows(
  supabase: SupabaseClient,
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
export async function readBackupPage(
  supabase: SupabaseClient,
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

export interface BackupRead {
  rows: Record<string, unknown>[];
  /** The whole table's size. Larger than `rows.length` when the cap was hit. */
  total: number;
  /** True when the table holds more rows than one export carries. */
  capped: boolean;
}

/**
 * One whole table, walked a page at a time up to a stated ceiling.
 *
 * PostgREST caps a single response, so a `select *` that looks like it returns
 * a table actually returns the first page of it. A backup that silently stopped
 * at a thousand rows would be worse than no backup at all.
 */
export async function readBackupTable(
  supabase: SupabaseClient,
  name: BackupTableName,
  cap: number,
): Promise<BackupRead | { error: string }> {
  const spec: TableSpec = BACKUP_TABLES[name];
  const rows: Record<string, unknown>[] = [];
  // Set when a page came back short, which proves the table ended inside the
  // cap and saves asking the database for a count it has already implied.
  let reachedEnd = false;
  for (let offset = 0; offset < cap && !reachedEnd; offset += READ_PAGE) {
    const size = Math.min(READ_PAGE, cap - offset);
    const page = await readBackupPage(supabase, name, spec, offset, size);
    if (page.error !== undefined) return { error: `${spec.label} could not be read: ${page.error}` };
    rows.push(...(page.rows ?? []));
    reachedEnd = (page.rows ?? []).length < size;
  }

  // Only a run that filled the cap needs a total: every other one already read
  // the whole table, so a second count would answer a question just settled.
  let total = rows.length;
  if (!reachedEnd) total = (await countBackupRows(supabase, name, spec)) ?? rows.length;
  return { rows, total, capped: !reachedEnd && total > rows.length };
}
