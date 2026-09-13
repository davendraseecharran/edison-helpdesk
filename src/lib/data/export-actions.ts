'use server';

/**
 * The inventory export.
 *
 * The browser turns the returned text into a download; nothing is written to
 * disk on the server and no export URL exists to be shared. The read goes
 * through the signed-in user's own client, so RLS decides the rows exactly as
 * it does on screen: an account that is not active gets an empty file, and a
 * filtered export contains exactly what the list showed.
 *
 * Whole TABLES are not exported here. `backup-actions.ts` owns that, for every
 * table rather than two, and this module would otherwise be a second answer to
 * the same question with a different cap and a different order.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { cappedExportMessage, csvFileName, CSV_ROW_CAP, toCsv } from '@/lib/csv';
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
  /** True when the filter matches more rows than one download carries. */
  capped?: boolean;
  /** What to tell the operator afterwards. Set only when the export was cut. */
  message?: string;
}

/**
 * The current inventory filter as a spreadsheet, in the order the list shows it.
 *
 * `app_list_devices` orders by `updated_at` descending, so the pages arrive
 * newest first and a filter larger than the shared cap keeps the machines
 * touched most recently rather than an arbitrary slice. The RPC also carries
 * the filter's full `total_count` on every row, so the caller can be told what
 * was left out without a second query.
 */
export async function exportDevicesCsvAction(filters: DeviceFilters): Promise<CsvExportResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to export. Sign in again.' };
  }

  const supabase = await createClient();
  const rows: DeviceSummaryRow[] = [];
  let total = 0;
  let reachedEnd = false;

  for (let offset = 0; offset < CSV_ROW_CAP && !reachedEnd; offset += DEVICES_RPC_LIMIT) {
    const size = Math.min(DEVICES_RPC_LIMIT, CSV_ROW_CAP - offset);
    const { data, error } = await supabase.rpc(
      'app_list_devices',
      deviceListArgs(filters, size, offset),
    );
    if (error) return { ok: false, error: `The export stopped: ${error.message}` };
    const page = (data ?? []) as DeviceSummaryRow[];
    if (offset === 0) total = Number(page[0]?.total_count ?? 0);
    rows.push(...page);
    reachedEnd = page.length < size;
  }

  const capped = !reachedEnd && total > rows.length;
  return {
    ok: true,
    csv: toCsv(DEVICE_CSV_COLUMNS, rows.map(deviceCsvRow)),
    filename: csvFileName('devices', schoolToday(), capped),
    count: rows.length,
    capped,
    message: capped ? cappedExportMessage('This filter', total) : undefined,
  };
}
