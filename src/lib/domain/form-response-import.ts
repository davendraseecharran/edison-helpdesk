/**
 * Responses from a Google Sheet, read the way an officer would read them.
 *
 * The sheet behind a Google Form has one column per question, headed with the
 * question's own words, plus a Timestamp and — when the form collected them —
 * an email column. Copied out of Sheets (tab-separated) or saved as a CSV,
 * it is split into cells by the Resolved import's reader (`readSheet`), and
 * everything here is what comes after that: which column is which question,
 * what each cell becomes as an answer, and who each row names.
 *
 * The database has the last word (`app_import_form_responses`): it matches
 * the person, checks every answer against its question again and decides
 * what is already there. The checks here are its checks made early, so the
 * preview can show a row that will be refused while the sheet can still be
 * fixed.
 *
 * Pure: no React, no Supabase.
 */

import { toDateKey } from '@/lib/format';
import {
  FORM_DIRECTORY_MAX,
  FORM_LONG_MAX,
  FORM_SHORT_MAX,
  fieldLabel,
  type AnswerValue,
  type FormField,
} from '@/lib/domain/forms';
import { parseSheetMoment, type Sheet } from '@/lib/domain/ticket-import';
import { foldName } from '@/lib/domain/checkin';

/** Rows in one call to the database, which refuses more. */
export const RESPONSE_IMPORT_BATCH = 200;
/** Rows in one sheet. */
export const RESPONSE_IMPORT_MAX_ROWS = 2000;

/**
 * What one column is. `q:<id>` is a question of this form; the four identity
 * targets are who answered, used to find them in the directory and not
 * stored as answers.
 */
export type ColumnTarget =
  | 'skip'
  | 'timestamp'
  | 'email'
  | 'external_id'
  | 'name'
  | 'first_name'
  | 'last_name'
  | `q:${string}`;

export const IDENTITY_TARGET_LABELS: Record<Exclude<ColumnTarget, `q:${string}`>, string> = {
  skip: 'Leave out',
  timestamp: 'Time sent',
  email: 'Email (who answered)',
  external_id: 'OSIS (who answered)',
  name: 'Full name (who answered)',
  first_name: 'First name (who answered)',
  last_name: 'Last name (who answered)',
};

export function targetOptions(fields: readonly FormField[]): Array<{ value: ColumnTarget; label: string }> {
  return [
    ...fields
      .filter((field) => field.type !== 'signature')
      .map((field) => ({ value: `q:${field.id}` as ColumnTarget, label: fieldLabel(field) })),
    { value: 'timestamp', label: IDENTITY_TARGET_LABELS.timestamp },
    { value: 'email', label: IDENTITY_TARGET_LABELS.email },
    { value: 'external_id', label: IDENTITY_TARGET_LABELS.external_id },
    { value: 'name', label: IDENTITY_TARGET_LABELS.name },
    { value: 'first_name', label: IDENTITY_TARGET_LABELS.first_name },
    { value: 'last_name', label: IDENTITY_TARGET_LABELS.last_name },
    { value: 'skip', label: IDENTITY_TARGET_LABELS.skip },
  ];
}

function questionOf(target: ColumnTarget, fields: readonly FormField[]): FormField | undefined {
  if (!target.startsWith('q:')) return undefined;
  const id = target.slice(2);
  return fields.find((field) => field.id === id);
}

function identityGuess(header: string): ColumnTarget {
  const text = ` ${foldName(header)} `;
  if (/^ (timestamp|time stamp|submitted|submitted at|date submitted|time submitted|submission time) $/.test(text)) {
    return 'timestamp';
  }
  if (/ (email|e mail) /.test(text)) return 'email';
  if (/ (osis|student id|id number|student number|staff id) /.test(text)) return 'external_id';
  if (/ (first|given) name /.test(text)) return 'first_name';
  if (/ (last|family|sur) ?name /.test(text)) return 'last_name';
  if (/ name /.test(text) && !/ (parent|guardian|project|team|club) /.test(text)) return 'name';
  return 'skip';
}

/**
 * A target for every column: a question whose words are the heading, first
 * exactly and then ignoring punctuation and case; otherwise who answered or
 * when; otherwise left out. Each target goes to the first column that asks
 * for it.
 */
export function guessTargets(headers: readonly string[], fields: readonly FormField[]): ColumnTarget[] {
  const taken = new Set<ColumnTarget>();
  const byLabel = new Map<string, FormField>();
  for (const field of fields) {
    if (field.type === 'signature') continue;
    const key = foldName(fieldLabel(field));
    if (key !== '' && !byLabel.has(key)) byLabel.set(key, field);
  }
  return headers.map((header) => {
    const exact = fields.find((field) => field.type !== 'signature' && fieldLabel(field).trim() === header.trim());
    const folded = exact ?? byLabel.get(foldName(header));
    let target: ColumnTarget = folded ? `q:${folded.id}` : identityGuess(header);
    if (target !== 'skip' && taken.has(target)) target = 'skip';
    if (target !== 'skip') taken.add(target);
    return target;
  });
}

/** Problems with the mapping as a whole. */
export function targetProblems(targets: readonly ColumnTarget[]): string[] {
  const problems: string[] = [];
  const counts = new Map<ColumnTarget, number>();
  for (const target of targets) counts.set(target, (counts.get(target) ?? 0) + 1);
  for (const [target, count] of counts) {
    if (target !== 'skip' && count > 1) problems.push('Two columns are set to the same thing. Leave one out.');
  }
  if (!targets.some((target) => target.startsWith('q:'))) {
    problems.push('No column is set to a question yet. Choose which question each column answers.');
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Cells into answers
// ---------------------------------------------------------------------------

/**
 * The choices a checkboxes cell names. Google writes them joined by ", ", and
 * a choice can itself contain a comma, so the pieces are rejoined until each
 * run is one of the question's choices. Null when a piece is left over.
 */
export function splitChoices(cell: string, options: readonly string[]): string[] | null {
  const byFold = new Map(options.map((option) => [option.trim().toLowerCase(), option]));
  const pieces = cell.split(',');
  const picked: string[] = [];
  let run = '';
  for (const piece of pieces) {
    run = run === '' ? piece : `${run},${piece}`;
    const hit = byFold.get(run.trim().toLowerCase());
    if (hit !== undefined) {
      if (!picked.includes(hit)) picked.push(hit);
      run = '';
    }
  }
  if (run.trim() !== '') return null;
  return picked;
}

function choiceOf(cell: string, options: readonly string[]): string | null {
  const folded = cell.trim().toLowerCase();
  return options.find((option) => option.trim().toLowerCase() === folded) ?? null;
}

/** A date cell as `YYYY-MM-DD`, from any of the shapes a sheet writes. */
export function dateCell(cell: string): string | null {
  const text = cell.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
  }
  const instant = parseSheetMoment(text);
  return instant === null ? null : toDateKey(new Date(instant));
}

/**
 * One cell as the answer to one question, or why it cannot be. An empty cell
 * is no answer, which is never an error here: the import does not hold rows
 * sent before a question existed to the question's rules.
 */
export function answerFromCell(field: FormField, cell: string): { value?: AnswerValue; error?: string } {
  const text = cell.trim();
  const label = fieldLabel(field);
  if (text === '') return {};
  switch (field.type) {
    case 'short_text':
      return text.length > FORM_SHORT_MAX ? { error: `"${label}" is over ${FORM_SHORT_MAX} characters.` } : { value: text };
    case 'long_text':
      return text.length > FORM_LONG_MAX ? { error: `"${label}" is over ${FORM_LONG_MAX} characters.` } : { value: text };
    case 'directory':
      return text.length > FORM_DIRECTORY_MAX
        ? { error: `"${label}" is over ${FORM_DIRECTORY_MAX} characters.` }
        : { value: text };
    case 'number': {
      const bare = text.replace(/,/g, '');
      return /^-?\d{1,12}(\.\d{1,6})?$/.test(bare) ? { value: bare } : { error: `"${text}" is not a number for "${label}".` };
    }
    case 'date': {
      const key = dateCell(text);
      return key === null ? { error: `"${text}" is not a date for "${label}".` } : { value: key };
    }
    case 'yes_no': {
      const folded = text.toLowerCase();
      if (['yes', 'y', 'true'].includes(folded)) return { value: true };
      if (['no', 'n', 'false'].includes(folded)) return { value: false };
      return { error: `"${text}" is not yes or no for "${label}".` };
    }
    case 'single_choice':
    case 'dropdown': {
      const choice = choiceOf(text, field.options ?? []);
      return choice === null ? { error: `"${text}" is not one of the choices for "${label}".` } : { value: choice };
    }
    case 'multi_choice': {
      const choices = splitChoices(text, field.options ?? []);
      return choices === null
        ? { error: `"${text}" is not made of the choices for "${label}".` }
        : { value: choices };
    }
    case 'signature':
      return {};
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Who a row says answered, from its identity columns and directory questions. */
export interface RowIdentity {
  email: string;
  external_id: string;
  name: string;
}

export function identityOf(
  cells: readonly string[],
  targets: readonly ColumnTarget[],
  fields: readonly FormField[],
): RowIdentity {
  const found: RowIdentity = { email: '', external_id: '', name: '' };
  let first = '';
  let last = '';
  targets.forEach((target, index) => {
    const cell = (cells[index] ?? '').trim();
    if (cell === '') return;
    if (target === 'email' && found.email === '') found.email = cell;
    else if (target === 'external_id' && found.external_id === '') found.external_id = cell;
    else if (target === 'name' && found.name === '') found.name = cell;
    else if (target === 'first_name') first = cell;
    else if (target === 'last_name') last = cell;
    else {
      // A directory question's answer says who answered as well as answering.
      const field = questionOf(target, fields);
      if (field?.type !== 'directory') return;
      if (field.directory === 'email' && found.email === '') found.email = cell;
      if (field.directory === 'external_id' && found.external_id === '') found.external_id = cell;
      if (field.directory === 'full_name' && found.name === '') found.name = cell;
    }
  });
  if (found.name === '' && (first !== '' || last !== '')) found.name = `${first} ${last}`.trim();
  return found;
}

/** The directory's answer about one row, from the preview's lookup. */
export interface RowMatch {
  state: 'match' | 'none' | 'ambiguous';
  personId: string | null;
  displayName: string | null;
}

/** Exactly what one row sends to `app_import_form_responses`. */
export interface ResponsePayload {
  submitted_at: string | null;
  email: string | null;
  external_id: string | null;
  name: string | null;
  answers: Record<string, AnswerValue>;
}

export interface ResponsePreviewRow {
  line: number;
  cells: string[];
  identity: RowIdentity;
  payload: ResponsePayload | null;
  errors: string[];
  notes: string[];
  match: RowMatch | null;
}

export function previewResponses(
  sheet: Sheet,
  targets: readonly ColumnTarget[],
  fields: readonly FormField[],
  matches: ReadonlyArray<RowMatch | undefined>,
  nowMs: number,
): ResponsePreviewRow[] {
  return sheet.rows.map((cells, index) => {
    const errors: string[] = [];
    const notes: string[] = [];
    const answers: Record<string, AnswerValue> = {};
    let submittedAt: string | null = null;

    targets.forEach((target, column) => {
      const cell = (cells[column] ?? '').trim();
      if (target === 'timestamp') {
        if (cell === '') return;
        const instant = parseSheetMoment(cell);
        if (instant === null) errors.push(`"${cell}" is not a time the helpdesk can read.`);
        else if (Date.parse(instant) > nowMs + 5 * 60_000) errors.push('The time it was sent is in the future.');
        else submittedAt = instant;
        return;
      }
      const field = questionOf(target, fields);
      if (!field) return;
      const answer = answerFromCell(field, cell);
      if (answer.error) errors.push(answer.error);
      else if (answer.value !== undefined) answers[field.id] = answer.value;
    });

    if (Object.keys(answers).length === 0 && errors.length === 0) errors.push('Nothing in this row answers a question.');

    const identity = identityOf(cells, targets, fields);
    const match = matches[index] ?? null;
    if (match?.state === 'none' && (identity.email || identity.external_id || identity.name)) {
      notes.push('Nobody in the directory matches. It comes in unmatched.');
    } else if (match?.state === 'ambiguous') {
      notes.push('More than one person in the directory matches. It comes in unmatched.');
    } else if (!identity.email && !identity.external_id && !identity.name) {
      notes.push('No email, OSIS or name to match. It comes in unmatched.');
    }
    if (submittedAt === null && targets.includes('timestamp')) notes.push('No time sent, so it takes the time of the import.');

    const payload: ResponsePayload | null =
      errors.length === 0
        ? {
            submitted_at: submittedAt,
            email: identity.email || null,
            external_id: identity.external_id || null,
            name: identity.name || null,
            answers,
          }
        : null;

    return { line: index + 2, cells, identity, payload, errors, notes, match };
  });
}

/** How one row came back from the database. */
export interface ResponseImportOutcome {
  line: number;
  outcome: 'made' | 'updated' | 'skipped' | 'refused';
  message: string | null;
}

export function responseImportSummary(outcomes: readonly ResponseImportOutcome[]): string {
  const count = (kind: ResponseImportOutcome['outcome']) => outcomes.filter((row) => row.outcome === kind).length;
  const made = count('made');
  const updated = count('updated');
  const skipped = count('skipped');
  const refused = count('refused');
  const parts = [
    made === 0 && updated === 0
      ? 'Imported nothing new.'
      : `Imported ${made + updated} ${made + updated === 1 ? 'response' : 'responses'}.`,
  ];
  if (updated > 0) parts.push(`${updated} replaced an older answer.`);
  if (skipped > 0) parts.push(`Skipped ${skipped} already here.`);
  if (refused > 0) parts.push(`Refused ${refused}.`);
  return parts.join(' ');
}

/** One row of a batch as the database answered it; `index` counts from one. */
export interface ResponseBatchRow {
  index: number;
  outcome: 'made' | 'updated' | 'skipped' | 'refused';
  message: string | null;
}

export interface ResponseBatchResult {
  ok: boolean;
  error?: string;
  rows: ResponseBatchRow[];
}
