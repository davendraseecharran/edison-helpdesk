'use server';

/**
 * The administrator's import.
 *
 * Three actions, and between them they never trust the browser with anything
 * that matters. The screen sends the CSV TEXT and the mapping the operator
 * chose; this module parses and normalises it itself, and `app_admin_import`
 * normalises again and decides what is written. A browser that edited its own
 * normalised rows would change nothing: those rows never leave it.
 *
 * The dry run is the same pass as the commit, rolled back inside the database,
 * so the counts an administrator reads before pressing the button are the
 * counts the button produces. Both modes go through the same action shape and
 * the same parse, so there is no second implementation to drift.
 *
 * The actor check at the top of each action is a fast fail for a session that
 * clearly cannot import; the security boundary is inside the RPC, which
 * re-derives the actor from auth.uid() and refuses anyone who is not an
 * administrator.
 *
 * Nothing here logs a row. The files hold children's addresses, parents' phone
 * numbers and staff email; a stack trace with a row in it would put them in a
 * server log that nobody is guarding. Errors are reported by ROW NUMBER, which
 * is what the operator needs to go and fix the sheet anyway.
 */

import { revalidatePath } from 'next/cache';
import { loadActor } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import {
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  buildImportPlan,
  mapImportRun,
  remapRunRows,
  type ImportMapping,
  type ImportRunResult,
  type ImportRunRow,
  type ImportRunView,
} from '@/lib/data/import-plan';
import type { RowError } from '@/lib/import';

export interface ImportPreview {
  ok: boolean;
  error?: string;
  /** The file's header line, for the mapping selects. */
  headers: string[];
  /** Which preset recognised the header line, if any. */
  detectedPresetId: string | null;
  /** Data rows the file carries, blank lines excluded. */
  rowCount: number;
  /** Problems with the file's shape, found before any field was read. */
  parseErrors: RowError[];
  /** Rows that could not be turned into a record at all. */
  normalisedErrors: RowError[];
  /** What `app_admin_import` did, and undid, in `dry_run` mode. */
  dryRun: ImportRunResult | null;
}

export interface ImportCommit {
  ok: boolean;
  error?: string;
  message?: string;
  result: ImportRunResult | null;
}

// `ImportRunView`/`ImportRunRow` and the mapping between them live in
// `import-plan.ts`, not here: this file carries the `'use server'` directive,
// which requires every exported function to be async, and `mapImportRun` is a
// plain synchronous mapper. Re-exported so callers keep importing the types
// from this module.
export type { ImportRunRow, ImportRunView };

const NO_SESSION = 'Your session is not able to import. Sign in again.';

/**
 * What the file has to pass before the database is asked anything.
 *
 * Both checks are about size rather than content, and both are stated as a
 * sentence with the way out in it. The row cap is the RPC's own; repeating it
 * here means an oversized file costs one message rather than a round trip that
 * carries every row of it.
 */
function refuseSize(csvText: string): string | null {
  // `Blob` counts the bytes the text actually takes, which is what the request
  // carries; a file of accented names is longer than its character count.
  if (new Blob([csvText]).size > MAX_CSV_BYTES) {
    return 'This file is larger than 5 MB. Split it into parts and import them one at a time.';
  }
  return null;
}

function refuseRowCount(rowCount: number): string | null {
  if (rowCount > MAX_IMPORT_ROWS) {
    return `This file has ${rowCount.toLocaleString('en-US')} rows. An import is at most ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows at a time. Split the file and import it in parts.`;
  }
  return null;
}

/** The empty preview an early refusal returns, so the screen has one shape. */
function refusedPreview(error: string, partial?: Partial<ImportPreview>): ImportPreview {
  return {
    ok: false,
    error,
    headers: [],
    detectedPresetId: null,
    rowCount: 0,
    parseErrors: [],
    normalisedErrors: [],
    dryRun: null,
    ...partial,
  };
}

async function importRows(
  kind: 'people' | 'devices',
  rows: Record<string, unknown>[],
  sourceRows: readonly number[],
  mode: 'dry_run' | 'commit',
): Promise<{ result: ImportRunResult } | { error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_admin_import', {
    p_kind: kind,
    p_rows: rows,
    p_mode: mode,
  });
  if (error) return { error: error.message };
  if (!data || typeof data !== 'object') {
    return { error: 'The import did not report what it did. Try again.' };
  }
  // The RPC counts positions in the array it was handed; the screen and the
  // problem-rows file have to name rows of the spreadsheet.
  return { result: remapRunRows(data as ImportRunResult, sourceRows) };
}

export interface ImportInput extends ImportMapping {
  csvText: string;
}

/**
 * Reads the file, shows what it holds, and runs the import as a dry run.
 *
 * The dry run happens here rather than on a separate action because the two are
 * one question — "what would this file do?" — and splitting them would mean
 * parsing the same text twice for one answer.
 */
export async function previewImportAction(input: ImportInput): Promise<ImportPreview> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return refusedPreview(NO_SESSION);
  }

  // Checked on the text, before a row of it is read: an oversized file costs
  // one message rather than a parse of every line in it.
  const oversize = refuseSize(input.csvText);
  if (oversize) return refusedPreview(oversize);

  const plan = buildImportPlan(input.csvText, input);
  const tooMany = refuseRowCount(plan.rowCount);
  if (tooMany) {
    return refusedPreview(tooMany, {
      headers: plan.headers,
      detectedPresetId: plan.detectedPresetId,
      rowCount: plan.rowCount,
    });
  }

  const base: ImportPreview = {
    ok: true,
    headers: plan.headers,
    detectedPresetId: plan.detectedPresetId,
    rowCount: plan.rowCount,
    parseErrors: plan.parseErrors,
    normalisedErrors: plan.normalisedErrors,
    dryRun: null,
  };

  if (plan.headers.length === 0) {
    return { ...base, ok: false, error: 'This file is empty. Export the sheet again and upload it.' };
  }

  const outcome = await importRows(input.kind, plan.rows, plan.sourceRows, 'dry_run');
  if ('error' in outcome) return { ...base, ok: false, error: outcome.error };
  return { ...base, dryRun: outcome.result };
}

/**
 * Writes the file.
 *
 * Parsed again from the same text with the same mapping, so what commits is
 * what the dry run reported and not a set of rows the browser held on to in
 * between. The RPC records the run and its own history entry.
 */
export async function commitImportAction(input: ImportInput): Promise<ImportCommit> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { ok: false, error: NO_SESSION, result: null };
  }

  const oversize = refuseSize(input.csvText);
  if (oversize) return { ok: false, error: oversize, result: null };

  const plan = buildImportPlan(input.csvText, input);
  const tooMany = refuseRowCount(plan.rowCount);
  if (tooMany) return { ok: false, error: tooMany, result: null };
  // Refused here and not only on the screen. A row the reader could not line up
  // with the header means a quote is unbalanced above it, so every row after it
  // may have slid sideways too, and this is not a file to write from.
  if (plan.parseErrors.length > 0) {
    return {
      ok: false,
      error:
        'This file has rows the reader could not line up with its columns. Fix the quotation marks in the spreadsheet and upload it again.',
      result: null,
    };
  }
  if (plan.rows.length === 0) {
    return {
      ok: false,
      error: 'There is nothing in this file to import. Check the column mapping and try again.',
      result: null,
    };
  }

  const outcome = await importRows(input.kind, plan.rows, plan.sourceRows, 'commit');
  if ('error' in outcome) return { ok: false, error: outcome.error, result: null };

  // An import rewrites the directory and the inventory, so every list, count
  // and detail page on the server is now out of date, not just this screen's.
  revalidatePath('/', 'layout');

  const done = outcome.result.inserts + outcome.result.updates;
  return {
    ok: true,
    result: outcome.result,
    message: `Imported ${done.toLocaleString('en-US')} ${done === 1 ? 'row' : 'rows'}.`,
  };
}

/**
 * Past imports, newest first.
 *
 * Read rather than mutated, so a failure is an empty list and a message on the
 * screen rather than an error page: the history is context for the import
 * being prepared, not the reason the page exists.
 */
export async function listImportRunsAction(limit = 20): Promise<{
  runs: ImportRunView[];
  error: string | null;
}> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || actor.account.role !== 'admin') {
    return { runs: [], error: NO_SESSION };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_admin_import_runs', { p_limit: limit });
  if (error) return { runs: [], error: error.message };

  const rows = (data ?? []) as ImportRunRow[];

  return {
    runs: rows.map(mapImportRun),
    error: null,
  };
}
