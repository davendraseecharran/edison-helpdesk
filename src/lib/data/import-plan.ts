/**
 * Turning an uploaded CSV into the rows `app_admin_import` accepts, and turning
 * what it answers back into something an administrator can read.
 *
 * Everything here is pure. That is the point: the import screen runs it in the
 * browser to show a row count and a detected preset the moment a file is
 * dropped, the server action runs it again on the text it was sent so nothing
 * the browser normalised is ever trusted, and `tests/import-actions.test.ts`
 * runs it with no database at all. No module-level state, no `server-only`, no
 * fetch.
 *
 * The one rule worth stating twice: the browser's copy of a plan is a preview,
 * never an instruction. `previewImportAction` and `commitImportAction` are both
 * given the CSV TEXT and re-derive the rows themselves, so a client that edited
 * its own normalised rows would change nothing about what is written.
 */

import {
  DEVICE_FIELDS,
  PEOPLE_FIELDS,
  PRESETS,
  detectPreset,
  isBlankRow,
  normaliseHeader,
  parseCsv,
  toDeviceRows,
  toPersonRows,
} from '../import/index.ts';
import type { ColumnPreset, ImportKind, ParsedCsv, RowError } from '../import/index.ts';
import { csvRow } from '../csv.ts';

/** What `app_admin_import` refuses beyond, stated here so the file says why. */
export const MAX_IMPORT_ROWS = 5000;

/**
 * The largest CSV the screen will send. 5 MB is far more than the school's
 * biggest tab (7,500 devices is under 2 MB) and small enough that a Server
 * Action carries it without the request being refused for its size.
 */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Row numbers, 1-based with the header excluded, as every message uses them. */
export interface RowProblem {
  row: number;
  message: string;
  /** The database's own words, for whoever is debugging rather than fixing. */
  detail?: string;
}

export interface UnmatchedHolder {
  row: number;
  holder: {
    kind?: string | null;
    osis?: string | null;
    staff_id?: string | null;
    name?: string | null;
  };
}

/** The shape `app_admin_import` returns, in both modes. */
export interface ImportRunResult {
  run_id: string | null;
  kind: ImportKind;
  mode: 'dry_run' | 'commit';
  total: number;
  inserts: number;
  updates: number;
  unchanged: number;
  errors: RowProblem[];
  unmatched_holders: UnmatchedHolder[];
  assignments_created: number;
}

/**
 * Everything the operator chose: what the file holds, which preset shape it
 * follows, and any column they re-pointed by hand.
 */
export interface ImportMapping {
  kind: ImportKind;
  /** A `PRESETS` id, or 'custom' when the mapping is the operator's own. */
  presetId: string;
  /** Target field → source header. An absent or empty entry is not imported. */
  customMap?: Record<string, string>;
  /**
   * People only: every row in one file is a student or a member of staff. The
   * AppSheet tabs are split that way and the sheet carries no column saying so,
   * which is why this is a choice rather than a mapping.
   */
  personKind?: 'student' | 'staff';
}

export interface ImportPlan {
  /** The file's header line, verbatim, for the mapping selects. */
  headers: string[];
  /** Which preset recognised the header line, if any. */
  detectedPresetId: string | null;
  /** Data rows the file actually carries, blank lines excluded. */
  rowCount: number;
  /** Structural problems with the file itself, before any field is read. */
  parseErrors: RowError[];
  /** Rows that cannot be turned into a record: no name, no id, a bad OSIS. */
  normalisedErrors: RowError[];
  /** The rows to send. Already normalised; the RPC normalises again anyway. */
  rows: Record<string, unknown>[];
  /**
   * The file row each sent row came from, 1-based with the header excluded.
   *
   * `app_admin_import` reports a problem by the position of the row in the
   * array it was handed, and that array is the file with its blank lines, its
   * malformed lines and its unsavable lines taken out. Without this, "row 5"
   * on the screen would be a different row 5 from the one in the spreadsheet.
   */
  sourceRows: number[];
  /** The mapping actually used, so the screen can show what it did. */
  preset: ColumnPreset;
  /** The parsed file, kept so the problem-rows download can quote it back. */
  csv: ParsedCsv;
}

/** Every target field a mapping table for this kind offers. */
export function fieldsFor(kind: ImportKind): readonly string[] {
  // `kind` is the operator's choice for a people file, not a column, so it is
  // never a row in the mapping table.
  return kind === 'people' ? PEOPLE_FIELDS.filter((field) => field !== 'kind') : DEVICE_FIELDS;
}

const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  display_name: 'Name',
  email: 'Email',
  osis: 'OSIS',
  staff_id: 'Staff id',
  school_dbn: 'School DBN',
  department: 'Department',
  role_title: 'Role',
  official_class: 'Official class',
  class_of: 'Class of',
  parent_name: 'Parent name',
  parent_phone: 'Parent phone',
  home_phone: 'Home phone',
  address: 'Address',
  notes: 'Notes',
  device_id: 'Device id',
  serial_number: 'Serial number',
  asset_tag: 'Asset tag',
  type: 'Type',
  manufacturer: 'Manufacturer',
  model: 'Model',
  os: 'Operating system',
  status: 'Status',
  location: 'Location',
  holder_kind: 'Held by (student or staff)',
  holder_osis: 'Holder OSIS',
  holder_staff_id: 'Holder staff id',
  holder_student_name: 'Holder name (student)',
  holder_staff_name: 'Holder name (staff)',
};

/** The name a target field goes by on screen. */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** The name a preset goes by on screen, including the operator's own mapping. */
export function presetLabel(presetId: string | null): string {
  if (presetId === null || presetId === 'custom') return 'Custom mapping';
  return PRESETS.find((preset) => preset.id === presetId)?.label ?? 'Custom mapping';
}

/**
 * The mapping to normalise with.
 *
 * The preset supplies the starting point and the operator's own map, when there
 * is one, replaces it wholly rather than being merged into it: a column the
 * operator cleared must stay cleared, and a merge would quietly put the
 * preset's guess back.
 */
export function resolvePreset(mapping: ImportMapping): ColumnPreset {
  const base = PRESETS.find(
    (preset) => preset.id === mapping.presetId && preset.kind === mapping.kind,
  );
  const allowed = new Set(fieldsFor(mapping.kind));

  let map: Record<string, string>;
  if (mapping.customMap) {
    map = {};
    for (const [field, header] of Object.entries(mapping.customMap)) {
      // An unknown target field is dropped rather than refused: the RPC ignores
      // keys it does not keep, and a stale field name must not lose the file.
      if (!allowed.has(field)) continue;
      if (typeof header !== 'string' || header.trim() === '') continue;
      map[field] = header;
    }
  } else {
    map = { ...(base?.map ?? {}) };
  }

  const personKind = mapping.personKind ?? base?.fixed?.kind ?? 'student';
  return {
    id: base && !mapping.customMap ? base.id : 'custom',
    label: presetLabel(base && !mapping.customMap ? base.id : 'custom'),
    kind: mapping.kind,
    fixed: mapping.kind === 'people' ? { kind: personKind } : undefined,
    map,
  };
}

/**
 * Problems with the file rather than with a row's contents.
 *
 * A record with MORE cells than the header line has is the one that matters:
 * it means a quote is unbalanced somewhere above, so every field after it has
 * slid sideways, and importing it would write one column's values into
 * another. Everything else — a short row, a blank line — the reader already
 * handles.
 */
export function findParseErrors(csv: ParsedCsv): RowError[] {
  const errors: RowError[] = [];
  if (csv.headers.length === 0) {
    return [{ row: 0, message: 'This file is empty. Export the sheet again and upload it.' }];
  }
  csv.rows.forEach((row, index) => {
    if (row.length > csv.headers.length) {
      errors.push({
        row: index + 1,
        message: `This row has ${row.length} values but the file has ${csv.headers.length} columns. Check the quotation marks around it in the spreadsheet.`,
      });
    }
  });
  return errors;
}

/** Data rows the file carries. A blank line in the middle is not one of them. */
export function countDataRows(csv: ParsedCsv): number {
  return csv.rows.filter((row) => !isBlankRow(row)).length;
}

/**
 * Which file row each normalised row came from.
 *
 * The normalisers walk the file in order and emit a row for every line that is
 * neither blank nor rejected, so walking the file the same way and applying the
 * same two exclusions reproduces their output positions exactly. `skip` adds a
 * third exclusion for the rows this module drops on top of theirs.
 */
function sourceRowNumbers(
  csv: ParsedCsv,
  rejected: readonly RowError[],
  skip: ReadonlySet<number>,
): number[] {
  const failed = new Set(rejected.map((error) => error.row));
  const rows: number[] = [];
  csv.rows.forEach((row, index) => {
    const at = index + 1;
    if (isBlankRow(row)) return;
    if (failed.has(at) || skip.has(at)) return;
    rows.push(at);
  });
  return rows;
}

/**
 * Reads the text and produces the rows to send, plus everything the screen
 * shows about the file before any of it is sent.
 *
 * A row the reader could not line up with the header is left OUT of what is
 * sent. Its fields have slid sideways, so importing it would write one
 * column's values into another; it is reported as a problem instead, and the
 * rest of the file still lands.
 */
export function buildImportPlan(csvText: string, mapping: ImportMapping): ImportPlan {
  const csv = parseCsv(csvText);
  const preset = resolvePreset(mapping);
  const detected = detectPreset(csv.headers);

  const parseErrors = findParseErrors(csv);
  const malformed = new Set(parseErrors.map((error) => error.row));

  const normalised =
    mapping.kind === 'people' ? toPersonRows(csv, preset) : toDeviceRows(csv, preset);
  const normalisedRows = normalised.rows as unknown as Record<string, unknown>[];
  const everyRow = sourceRowNumbers(csv, normalised.errors, new Set<number>());

  const rows: Record<string, unknown>[] = [];
  const sourceRows: number[] = [];
  normalisedRows.forEach((row, index) => {
    // `everyRow` is the normalisers' own output positions; a length mismatch
    // would mean this module and they disagree about the file, so the row is
    // kept without a source number rather than given somebody else's.
    const at = everyRow[index];
    if (at !== undefined && malformed.has(at)) return;
    rows.push(row);
    sourceRows.push(at ?? index + 1);
  });

  return {
    headers: csv.headers,
    detectedPresetId: detected?.id ?? null,
    rowCount: countDataRows(csv),
    parseErrors,
    normalisedErrors: normalised.errors,
    rows,
    sourceRows,
    preset,
    csv,
  };
}

/**
 * The same run result, with every row number turned back into the row of the
 * file the operator is looking at.
 *
 * `app_admin_import` counts positions in the array it was handed. That array
 * has the file's blank, malformed and unsavable lines taken out of it, so its
 * position 5 is not the spreadsheet's row 5 — and the number on screen has to
 * be the one somebody can go and fix.
 */
export function remapRunRows(run: ImportRunResult, sourceRows: readonly number[]): ImportRunResult {
  const fileRow = (sent: number): number => sourceRows[sent - 1] ?? sent;
  return {
    ...run,
    errors: run.errors.map((error) => ({ ...error, row: fileRow(error.row) })),
    unmatched_holders: run.unmatched_holders.map((entry) => ({
      ...entry,
      row: fileRow(entry.row),
    })),
  };
}

/**
 * The preset a file's header line looks like, and the sentence that says so.
 * Null when nothing recognised it, which is when the mapping step opens itself.
 */
export function describeDetection(headers: string[]): { id: string; sentence: string } | null {
  const preset = detectPreset(headers);
  if (!preset) return null;
  return {
    id: preset.id,
    sentence: `Looks like the ${preset.label} export.`,
  };
}

/**
 * A prefilled mapping for a preset: every target field the file can actually
 * supply, pointed at the header the file actually has.
 *
 * Matching is on the folded header, so `Student ID:` in the preset finds
 * `student id` in the file, and the value stored is the file's OWN spelling —
 * which is what the select shows and what `cellReader` folds again later.
 */
export function prefillMapping(headers: string[], preset: ColumnPreset | null): Record<string, string> {
  const byFolded = new Map<string, string>();
  for (const header of headers) {
    const key = normaliseHeader(header);
    if (key !== '' && !byFolded.has(key)) byFolded.set(key, header);
  }

  const map: Record<string, string> = {};
  for (const field of fieldsFor(preset?.kind ?? 'people')) {
    const wanted = preset?.map[field];
    if (wanted === undefined) continue;
    const found = byFolded.get(normaliseHeader(wanted));
    if (found !== undefined) map[field] = found;
  }
  return map;
}

export interface ImportChip {
  key: string;
  label: string;
  /** `problem` is the only one that carries a tone; the rest are quiet. */
  tone: 'plain' | 'problem';
}

export interface ImportSummary {
  /** Data rows in the file. The four chips add up to this. */
  total: number;
  inserts: number;
  updates: number;
  unchanged: number;
  /** Every row that could not be written, at whatever stage it failed. */
  problems: number;
  unmatched: number;
  assignments: number;
  /** Rows a commit would actually write. This is the number on the button. */
  changing: number;
  chips: ImportChip[];
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The summary strip.
 *
 * `problems` counts every row that did not make it, including the ones that
 * failed before the database saw them, so the four chips add up to the number
 * of rows in the file rather than to the number the RPC was sent.
 */
export function summariseImport(
  run: ImportRunResult,
  rowCount: number,
  problems: number,
): ImportSummary {
  return {
    total: rowCount,
    inserts: run.inserts,
    updates: run.updates,
    unchanged: run.unchanged,
    problems,
    unmatched: run.unmatched_holders.length,
    assignments: run.assignments_created,
    changing: run.inserts + run.updates,
    chips: [
      { key: 'new', label: `${count(run.inserts)} new`, tone: 'plain' },
      { key: 'changed', label: `${count(run.updates)} changed`, tone: 'plain' },
      { key: 'unchanged', label: `${count(run.unchanged)} unchanged`, tone: 'plain' },
      {
        key: 'problems',
        label: `${count(problems)} ${problems === 1 ? 'problem' : 'problems'}`,
        tone: problems > 0 ? 'problem' : 'plain',
      },
    ],
  };
}

/**
 * Every problem in one list, one entry per row, ordered by the row the operator
 * would go and fix.
 *
 * One entry per row is what makes the summary strip add up: the four chips
 * count ROWS, and a line that is both malformed and missing a name is one row
 * that did not land, not two. Its two sentences are joined rather than one of
 * them being dropped, because both are things to fix.
 */
export function mergeProblems(
  parseErrors: readonly RowError[],
  normalisedErrors: readonly RowError[],
  runErrors: readonly RowProblem[],
): RowProblem[] {
  const all: RowProblem[] = [
    ...parseErrors.map((error) => ({ row: error.row, message: error.message })),
    ...normalisedErrors.map((error) => ({ row: error.row, message: error.message })),
    ...runErrors.map((error) => ({
      row: error.row,
      message: error.message,
      detail: error.detail,
    })),
  ];

  const byRow = new Map<number, RowProblem>();
  for (const problem of all) {
    const found = byRow.get(problem.row);
    if (!found) {
      byRow.set(problem.row, { ...problem });
      continue;
    }
    if (!found.message.includes(problem.message)) {
      found.message = `${found.message} ${problem.message}`;
    }
    if (found.detail === undefined && problem.detail !== undefined) {
      found.detail = problem.detail;
    }
  }

  return [...byRow.values()].sort((left, right) => left.row - right.row);
}

/**
 * What to tell somebody when the action itself did not come back.
 *
 * The one failure worth naming is the request being refused for its size: a
 * Server Action body is capped, the import sends the file as an argument, and
 * "check your connection" would send the operator looking in the wrong place.
 */
export function describeActionFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/413|body exceeded|too large|request entity/i.test(text)) {
    return 'That file is too large to import (5 MB limit). Split it into parts and import them one at a time.';
  }
  return 'The import could not be reached. Check your connection and try again.';
}

/**
 * The problem rows, as a CSV of the file's own cells.
 *
 * The original header line and the original values come back exactly as they
 * were typed, with two columns appended saying which row each was and what went
 * wrong. Appending rather than prepending is deliberate: the file can be fixed
 * in place and imported again, and the import ignores columns it does not map.
 */
export function problemRowsCsv(csv: ParsedCsv, problems: readonly RowProblem[]): string {
  const byRow = new Map<number, string[]>();
  for (const problem of problems) {
    if (problem.row < 1) continue;
    const messages = byRow.get(problem.row) ?? [];
    messages.push(problem.detail ? `${problem.message} (${problem.detail})` : problem.message);
    byRow.set(problem.row, messages);
  }

  const lines = [csvRow([...csv.headers, 'Import row', 'Problem'])];
  for (const row of [...byRow.keys()].sort((left, right) => left - right)) {
    const cells = csv.rows[row - 1] ?? [];
    lines.push(csvRow([...cells, row, (byRow.get(row) ?? []).join(' ')]));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Who a device was meant for, as one readable line. */
export function holderLabel(holder: UnmatchedHolder['holder']): string {
  const parts: string[] = [];
  if (holder.name) parts.push(holder.name);
  if (holder.osis) parts.push(`OSIS ${holder.osis}`);
  if (holder.staff_id) parts.push(`Staff id ${holder.staff_id}`);
  if (parts.length === 0) return holder.kind === 'staff' ? 'A member of staff' : 'A student';
  return parts.join(', ');
}

/* --- Import history ------------------------------------------------------ */

/** One past import, as the history table reads it. */
export interface ImportRunView {
  id: string;
  kind: 'people' | 'devices';
  at: string;
  actorName: string;
  inserted: number;
  updated: number;
  unchanged: number;
  errorCount: number;
  /** Device imports that could not find the person a machine was held by. */
  unmatched: number;
  /** Defaults to `user` for runs written before attribution existed. */
  performedVia: 'user' | 'ai';
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel: string | null;
}

/** One row of `app_admin_import_runs`, mapped to what the history table reads. */
export interface ImportRunRow {
  id: string;
  kind: string;
  at: string;
  actor_name: string | null;
  performed_via?: string | null;
  ai_model?: string | null;
  inserted: number;
  updated: number;
  unchanged: number;
  error_count: number;
  summary: { unmatched_holders?: unknown[] } | null;
}

/**
 * `mapImportRun` lives here, and not beside the action that calls it, because
 * `import-actions.ts` carries the `'use server'` directive: every function it
 * exports becomes a Server Action and must be async, and this one is a plain
 * synchronous mapper.
 */
export function mapImportRun(row: ImportRunRow): ImportRunView {
  return {
    id: row.id,
    kind: row.kind === 'devices' ? 'devices' : 'people',
    at: row.at,
    actorName: row.actor_name ?? 'An administrator',
    inserted: row.inserted,
    updated: row.updated,
    unchanged: row.unchanged,
    errorCount: row.error_count,
    unmatched: Array.isArray(row.summary?.unmatched_holders)
      ? row.summary.unmatched_holders.length
      : 0,
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
  };
}
