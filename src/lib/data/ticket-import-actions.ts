'use server';

/**
 * The sheet import's one write: a batch of rows the dialog has already read.
 *
 * It calls `app_import_resolved_tickets` as the signed-in person, so the
 * database decides who may import (an administrator or a NetRider, the same as
 * the assistant's import), whose name may go on the work, and which rows are a
 * history. Nothing here trusts a row: the dialog's own checks are a preview,
 * and every one of them is made again inside the function.
 *
 * The rows arrive already cut to the database's batch size; the dialog sends
 * a longer sheet as consecutive calls, so a refusal in one batch never takes
 * the rows of another with it.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { IMPORT_BATCH, type ImportPayload } from '@/lib/domain/ticket-import';

export interface ImportBatchRow {
  /** 1-based position in the batch that was sent. */
  index: number;
  outcome: 'made' | 'skipped' | 'refused';
  ticketId: string | null;
  ticketNumber: string | null;
  message: string | null;
}

export interface ImportBatchResult {
  ok: boolean;
  error?: string;
  rows: ImportBatchRow[];
}

interface BatchRowShape {
  row_index: number;
  outcome: string;
  ticket_id: string | null;
  ticket_number: string | null;
  message: string | null;
}

export async function importResolvedSheetAction(rows: ImportPayload[]): Promise<ImportBatchResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'There are no rows to import.', rows: [] };
  }
  if (rows.length > IMPORT_BATCH) {
    return { ok: false, error: `Import at most ${IMPORT_BATCH} rows at a time.`, rows: [] };
  }

  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.', rows: [] };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_import_resolved_tickets', { p_rows: rows });
  if (error) {
    return { ok: false, error: error.message, rows: [] };
  }

  revalidatePath('/', 'layout');
  const answers = (Array.isArray(data) ? data : []) as BatchRowShape[];
  return {
    ok: true,
    rows: answers.map((row) => ({
      index: Number(row.row_index),
      outcome: row.outcome === 'made' ? 'made' : row.outcome === 'skipped' ? 'skipped' : 'refused',
      ticketId: row.ticket_id,
      ticketNumber: row.ticket_number,
      message: row.message,
    })),
  };
}
