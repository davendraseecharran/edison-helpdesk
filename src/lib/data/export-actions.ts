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
import { DEVICES_PAGE_SIZE, type DeviceFilters } from '@/lib/data/devices';
import { mapInventoryDevice, mapInventoryPage } from '@/lib/data/mapping';
import type { DeviceSummary } from '@/lib/domain/types';
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
 * `app_list_inventory` pages at fifty and carries the filter's full `total` in
 * every envelope, so the caller can be told what was left out without a second
 * query. The pages are walked until the cap or the end, whichever comes first.
 */
export async function exportDevicesCsvAction(filters: DeviceFilters): Promise<CsvExportResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to export. Sign in again.' };
  }

  const supabase = await createClient();
  const rows: DeviceSummary[] = [];
  let total = 0;
  let reachedEnd = false;

  for (let page = 1; rows.length < CSV_ROW_CAP && !reachedEnd; page += 1) {
    const { data, error } = await supabase.rpc('app_list_inventory', {
      p_query: filters.query?.trim() ?? '',
      p_page: page,
      p_requester: filters.requesterId ?? null,
    });
    if (error) return { ok: false, error: `The export stopped: ${error.message}` };
    const mapped = mapInventoryPage(data as never, mapInventoryDevice);
    if (page === 1) total = mapped.total;
    rows.push(...mapped.rows.slice(0, CSV_ROW_CAP - rows.length));
    reachedEnd = mapped.rows.length < (mapped.pageSize || DEVICES_PAGE_SIZE);
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
