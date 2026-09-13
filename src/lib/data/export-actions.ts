'use server';

/**
 * CSV exports, as server actions returning text.
 *
 * The browser turns the text into a download; nothing is written to disk on
 * the server and no export URL exists to be shared. Both exports read through
 * the signed-in user's own client, so RLS decides the rows exactly as it does
 * on screen: an account that is not active gets an empty file, and a filtered
 * export contains exactly what the list showed.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { csvHeaders, encodeCsv, toCsv } from '@/lib/csv';
import { DEVICE_CSV_COLUMNS, deviceCsvRow } from '@/lib/data/device-csv';
import { deviceListArgs, DEVICES_RPC_LIMIT, type DeviceFilters } from '@/lib/data/devices';
import type { DeviceSummaryRow } from '@/lib/data/mapping';
import { schoolToday } from '@/lib/format';

export interface CsvExportResult {
  ok: boolean;
  error?: string;
  /** The file's text, RFC 4180 with CRLF line endings. */
  csv?: string;
  filename?: string;
  /** Data rows, not counting the header. */
  count?: number;
}

/** Enough for the whole 7,500-machine inventory with room to grow. */
const MAX_EXPORT_ROWS = 20_000;

/** The current inventory filter as a spreadsheet, in the order the list shows it. */
export async function exportDevicesCsvAction(filters: DeviceFilters): Promise<CsvExportResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to export. Sign in again.' };
  }

  const supabase = await createClient();
  const rows: DeviceSummaryRow[] = [];
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += DEVICES_RPC_LIMIT) {
    const { data, error } = await supabase.rpc(
      'app_list_devices',
      deviceListArgs(filters, DEVICES_RPC_LIMIT, offset),
    );
    if (error) return { ok: false, error: `The export stopped: ${error.message}` };
    const page = (data ?? []) as DeviceSummaryRow[];
    rows.push(...page);
    if (page.length < DEVICES_RPC_LIMIT) break;
  }

  const csv = toCsv(DEVICE_CSV_COLUMNS, rows.map(deviceCsvRow));
  return { ok: true, csv, filename: `devices-${schoolToday()}.csv`, count: rows.length };
}

/** The tables an administrator may pull whole. Anything else is refused. */
const EXPORTABLE_TABLES = ['people', 'devices'] as const;
export type ExportableTable = (typeof EXPORTABLE_TABLES)[number];

/**
 * A whole table for an administrator, every column as stored.
 *
 * Read with the administrator's own client, so the table's row policy still
 * applies; the role check here only keeps a technician from pulling the whole
 * roster, addresses included, in one file.
 */
export async function exportTableCsvAction(table: string): Promise<CsvExportResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to export. Sign in again.' };
  }
  if (actor.account.role !== 'admin') {
    return { ok: false, error: 'Only an administrator can export a whole table.' };
  }
  if (!(EXPORTABLE_TABLES as readonly string[]).includes(table)) {
    return { ok: false, error: 'That table cannot be exported.' };
  }

  const supabase = await createClient();
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let from = 0; from < MAX_EXPORT_ROWS; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { ok: false, error: `The export stopped: ${error.message}` };
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const csv = encodeCsv(csvHeaders(rows), rows);
  return { ok: true, csv, filename: `${table}-${schoolToday()}.csv`, count: rows.length };
}
