/**
 * A sheet of finished work, read the way a person at the desk would read it.
 *
 * The desk kept a Google Sheet before it had a helpdesk, and the Resolved page
 * takes it back in: rows copied straight out of Sheets (tab-separated, headings
 * first) or a CSV file dropped on the dialog. This module is everything about
 * that which does not need a network: splitting the text into cells, guessing
 * which column is which from its heading, reading the dates a spreadsheet
 * actually holds, and deciding — row by row, before anything is written — what
 * each row will become and what is wrong with it.
 *
 * The database has the last word (`app_import_resolved_tickets`, the same rules
 * the assistant's import uses), and every check here is one it makes again.
 * They are made here as well so the preview can show a refusal while the
 * person can still fix the sheet, rather than after a batch has gone.
 *
 * Pure: no React, no Supabase. The dialog feeds it the directory's answers.
 */

import { isValidDateKey, schoolWallTime } from '@/lib/format';
import {
  type Priority,
  type TicketCategory,
  PRIORITY_LABELS,
  TICKET_CATEGORY_LABELS,
} from '@/lib/domain/types';
import { momentProblem } from '@/lib/domain/ticket-moments';

/** Rows in one call to the database, which refuses more. */
export const IMPORT_BATCH = 200;
/** Rows in one sheet. Past this it is a migration, not a paste. */
export const IMPORT_MAX_ROWS = 1000;

export type ImportField =
  | 'title'
  | 'issue'
  | 'requester'
  | 'location'
  | 'category'
  | 'priority'
  | 'opened'
  | 'resolved'
  | 'solution'
  | 'resolvedBy'
  | 'skip';

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  title: 'Title',
  issue: 'Issue',
  requester: 'Requester',
  location: 'Location',
  category: 'Category',
  priority: 'Priority',
  opened: 'Opened',
  resolved: 'Resolved',
  solution: 'Solution',
  resolvedBy: 'Resolved by',
  skip: 'Leave out',
};

export const IMPORT_FIELDS = Object.keys(IMPORT_FIELD_LABELS) as ImportField[];

export interface Sheet {
  headers: string[];
  rows: string[][];
  delimiter: '\t' | ',' | ';';
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * Which character separates the cells.
 *
 * Google Sheets copies as tab-separated text, so a tab anywhere in the heading
 * line settles it. Otherwise it is a CSV, and a European export separates with
 * semicolons: whichever of the two the heading line holds more of, outside
 * quotes.
 */
export function detectDelimiter(text: string): Sheet['delimiter'] {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char === '\t') return '\t';
    else if (!quoted && char === ',') commas += 1;
    else if (!quoted && char === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Cells, by RFC 4180's rules with the separator given: a field that starts
 * with a quote runs to its closing quote, a doubled quote inside it is one
 * quote, and a line break inside it is part of the cell. That last case is
 * the one that matters here — Sheets quotes any cell somebody pressed
 * Alt+Enter in, and a note with three lines is a common thing on a desk's
 * sheet.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += char;
    started = true;
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The sheet: headings, then every row that has anything in it, each padded to
 * the same width. Null when there is nothing to read. A row wider than the
 * headings gets a column named for its position rather than losing a cell.
 */
export function readSheet(text: string): Sheet | null {
  if (text.trim() === '') return null;
  const delimiter = detectDelimiter(text);
  const table = parseDelimited(text, delimiter).filter((cells) =>
    cells.some((cell) => cell.trim() !== ''),
  );
  if (table.length === 0) return null;

  const [head, ...body] = table;
  const width = Math.max(...table.map((cells) => cells.length));
  const headers = Array.from({ length: width }, (_, index) => {
    const name = (head[index] ?? '').trim();
    return name === '' ? `Column ${index + 1}` : name;
  });
  const rows = body.map((cells) =>
    Array.from({ length: width }, (_, index) => (cells[index] ?? '').trim()),
  );
  return { headers, rows, delimiter };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function words(header: string): string {
  return ` ${header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * What a heading most likely means, in the order the questions have to be
 * asked: "Resolved by" is a person before it is a date, "Reported by" is the
 * requester before "reported" is a date, and "Resolution" is a solution even
 * though it begins like "resolved".
 */
const RULES: Array<[ImportField, RegExp]> = [
  ['resolvedBy', / (resolved|fixed|closed|completed|handled|done|worked|solved) by |technician| tech |netrider| assigned to | assignee | owner /],
  ['requester', / (requested|reported|submitted|called|opened) by |requester|requestor| caller |customer|student|teacher| staff | osis | email | e mail | contact | name | who | user /],
  ['resolved', / (resolution|resolved|closed|completed|fixed|finish) (date|day|time|on) | date (of )?(resolution|resolved|closed|completed|fixed) /],
  ['solution', /solution|resolution| fix | how | action|what was done|outcome| remedy /],
  ['resolved', /resolv|closed|close date|completed|finished| fixed | done | date out | end /],
  ['opened', /open|created|reported|received|submitted|called|logged| date in |start| date | when |timestamp| day /],
  ['title', /title|summary|subject|short/],
  ['issue', /issue|description|detail|problem|notes?|comment|what| request /],
  ['category', /categor| type | kind |device/],
  ['priority', /priorit|urgen|severity/],
  ['location', /location| room |where|place|building|floor/],
];

export function guessField(header: string): ImportField {
  const text = words(header);
  for (const [field, pattern] of RULES) {
    if (pattern.test(text)) return field;
  }
  return 'skip';
}

/**
 * A field for every column. Each field is given to the first column that asks
 * for it; a second column asking for the same thing is left out rather than
 * quietly overwriting the first, and the select beside it says so. A sheet
 * with no title column is fine: the title is cut from the issue, row by row.
 */
export function autoMap(headers: readonly string[]): ImportField[] {
  const taken = new Set<ImportField>();
  const mapping = headers.map((header) => {
    const field = guessField(header);
    if (field === 'skip' || taken.has(field)) return 'skip';
    taken.add(field);
    return field;
  });
  return mapping;
}

/** Problems with the mapping as a whole, which stop the import before any row. */
export function mappingProblems(mapping: readonly ImportField[]): string[] {
  const problems: string[] = [];
  const has = (field: ImportField) => mapping.includes(field);
  if (!has('title') && !has('issue')) {
    problems.push('Choose which column is the title or the issue.');
  }
  if (!has('opened') && !has('resolved')) {
    problems.push('Choose which column holds the date it was opened or resolved.');
  }
  const counts = new Map<ImportField, number>();
  for (const field of mapping) counts.set(field, (counts.get(field) ?? 0) + 1);
  for (const [field, count] of counts) {
    if (field !== 'skip' && count > 1) {
      problems.push(`Two columns are set to ${IMPORT_FIELD_LABELS[field]}. Leave one out.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

function monthOf(name: string): number | null {
  const at = MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase());
  return at === -1 ? null : at + 1;
}

function dateKey(year: number, month: number, day: number): string | null {
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidDateKey(key) ? key : null;
}

function fullYear(text: string): number {
  const year = Number(text);
  return text.length <= 2 ? 2000 + year : year;
}

/** "14:30", "2:30 PM", "2:30:15 pm", "2 PM", "" (midnight). Null when it is not a time. */
function clockOf(text: string): { hour: number; minute: number } | null {
  const trimmed = text.trim().toLowerCase().replace(/\./g, '');
  if (trimmed === '') return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(trimmed);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[4];
  if (match[2] === undefined && meridiem === undefined) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.startsWith('a')) hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * One moment, from what a spreadsheet cell actually says.
 *
 * A date with no time is the START of that school day, exactly as the
 * assistant's import reads it (`historicInstant`), so the same sheet imported
 * through either door names the same instants and is recognised as the same
 * rows the second time. A time with no zone is school-local. A full ISO
 * instant with a zone is taken as written.
 *
 * Read: 2025-09-12, 2025/09/12, 9/12/2025, 9/12/25 (month first, as a US
 * sheet writes it), Sep 12 2025, 12 Sep 2025, September 12, 2025, with an
 * optional leading weekday and an optional time after any of them.
 */
export function parseSheetMoment(text: string): string | null {
  let value = text.trim().replace(/\s+/g, ' ');
  if (value === '') return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  value = value.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');

  let key: string | null = null;
  let rest = '';
  let match: RegExpExecArray | null;

  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T,]+(.*))?$/.exec(value))) {
    key = dateKey(Number(match[1]), Number(match[2]), Number(match[3]));
    rest = match[4] ?? '';
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,]+(.*))?$/.exec(value))) {
    key = dateKey(fullYear(match[3]), Number(match[1]), Number(match[2]));
    rest = match[4] ?? '';
  } else if ((match = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?:[ ,]+(?:at )?(.*))?$/i.exec(value))) {
    const month = monthOf(match[1]);
    key = month === null ? null : dateKey(Number(match[3]), month, Number(match[2]));
    rest = match[4] ?? '';
  } else if ((match = /^(\d{1,2}) ([a-z]{3,9})\.?,? (\d{4})(?:[ ,]+(?:at )?(.*))?$/i.exec(value))) {
    const month = monthOf(match[2]);
    key = month === null ? null : dateKey(Number(match[3]), month, Number(match[1]));
    rest = match[4] ?? '';
  }

  if (key === null) return null;
  const clock = clockOf(rest);
  if (clock === null) return null;
  return schoolWallTime(key, clock.hour, clock.minute);
}

const CATEGORY_WORDS: Array<[TicketCategory, RegExp]> = [
  ['chromebook', /chromebook|chrome book/],
  ['laptop_desktop', /laptop|desktop|computer|\bpc\b|mac|imac|windows/],
  ['projector_display', /projector|display|monitor|screen|smart ?board|tv|panel|hdmi/],
  ['network', /network|wi-?fi|wireless|internet|ethernet|connect/],
  ['printer', /print|copier|scan/],
  ['account', /account|password|login|log in|sign in|google|email/],
  ['software', /software|app|program|install|update/],
  ['phone', /phone|voicemail|extension/],
  ['other', /^other$|^misc/],
];

/** A category from a label, a value, or a word that says which. */
export function categoryOf(text: string): { value: TicketCategory; known: boolean } {
  const cleaned = text.trim().toLowerCase();
  if (cleaned === '') return { value: 'other', known: true };
  for (const [value, label] of Object.entries(TICKET_CATEGORY_LABELS)) {
    if (cleaned === value || cleaned === label.toLowerCase()) {
      return { value: value as TicketCategory, known: true };
    }
  }
  for (const [value, pattern] of CATEGORY_WORDS) {
    if (pattern.test(cleaned)) return { value, known: true };
  }
  return { value: 'other', known: false };
}

/** A priority from its name or the words sheets use for one. */
export function priorityOf(text: string): { value: Priority; known: boolean } {
  const cleaned = text.trim().toLowerCase();
  if (cleaned === '') return { value: 'normal', known: true };
  if (cleaned in PRIORITY_LABELS) return { value: cleaned as Priority, known: true };
  if (/^(critical|emergency|asap|p0|p1|1)$/.test(cleaned)) return { value: 'urgent', known: true };
  if (/^(medium|med|normal|standard|p3|3)$/.test(cleaned)) return { value: 'normal', known: true };
  if (/^(p2|2|important)$/.test(cleaned)) return { value: 'high', known: true };
  if (/^(minor|p4|4|5)$/.test(cleaned)) return { value: 'low', known: true };
  return { value: 'normal', known: false };
}

/** A title from the issue when the sheet has none: its first line, cut at a word. */
export function titleFromIssue(issue: string): string {
  const line = issue.trim().split(/\r?\n/)[0].trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What the directory said about one requester cell. */
export interface RequesterAnswer {
  found: 'match' | 'none' | 'ambiguous';
  matches: number;
  id: string | null;
  displayName: string | null;
}

/** An account that could be named as the one who fixed it. */
export interface ResolverCandidate {
  id: string;
  displayName: string;
}

export interface PreviewContext {
  nowMs: number;
  actorId: string;
  isAdmin: boolean;
  /** Answers keyed by the requester cell, lower-cased. Absent while being looked up. */
  people: ReadonlyMap<string, RequesterAnswer>;
  /** Active accounts that work tickets. */
  resolvers: readonly ResolverCandidate[];
}

/** Exactly what one row sends to `app_import_resolved_tickets`. */
export interface ImportPayload {
  title: string;
  issue: string | null;
  opened_at: string;
  resolved_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  requester_id: string | null;
  location: string | null;
  category: TicketCategory;
  priority: Priority;
  solution: string | null;
}

export interface PreviewRow {
  /** The row's line in the sheet, headings being line 1. */
  line: number;
  cells: string[];
  /** Null when the row cannot be sent. */
  payload: ImportPayload | null;
  errors: string[];
  notes: string[];
  requester: { key: string; state: 'none' | 'pending' | 'match' | 'ambiguous' | 'unmatched'; label: string | null };
}

function cellOf(cells: readonly string[], mapping: readonly ImportField[], field: ImportField): string {
  const index = mapping.indexOf(field);
  return index === -1 ? '' : (cells[index] ?? '').trim();
}

function resolverFor(name: string, resolvers: readonly ResolverCandidate[]): ResolverCandidate | null {
  const folded = name.trim().toLowerCase();
  const whole = resolvers.filter((account) => account.displayName.toLowerCase() === folded);
  if (whole.length === 1) return whole[0];
  if (whole.length > 1) return null;
  // "Dev" on a sheet for "Dev Patel", when there is exactly one Dev.
  const first = resolvers.filter(
    (account) => account.displayName.toLowerCase().split(/\s+/)[0] === folded,
  );
  return first.length === 1 ? first[0] : null;
}

/**
 * Every row, as it will land or why it will not.
 *
 * `errors` stop a row: it is not sent. `notes` do not: the row lands, and the
 * note says what was assumed on the way (a category the helpdesk does not
 * have, a requester nobody in the directory matches, a technician with no
 * account here).
 */
export function previewRows(
  sheet: Sheet,
  mapping: readonly ImportField[],
  context: PreviewContext,
): PreviewRow[] {
  return sheet.rows.map((cells, index) => {
    const errors: string[] = [];
    const notes: string[] = [];

    const issueText = cellOf(cells, mapping, 'issue');
    let title = cellOf(cells, mapping, 'title');
    if (title === '' && issueText !== '') title = titleFromIssue(issueText);
    if (title.length < 3) errors.push('Needs a title of at least three characters.');
    else if (title.length > 120) errors.push('The title is over 120 characters. Map the long text to Issue.');
    if (issueText.length > 6000) errors.push('The issue is over 6000 characters.');

    const openedText = cellOf(cells, mapping, 'opened');
    const resolvedText = cellOf(cells, mapping, 'resolved');
    let opened = openedText === '' ? null : parseSheetMoment(openedText);
    let resolved = resolvedText === '' ? null : parseSheetMoment(resolvedText);
    if (openedText !== '' && opened === null) errors.push(`“${openedText}” is not a date the helpdesk can read.`);
    if (resolvedText !== '' && resolved === null) errors.push(`“${resolvedText}” is not a date the helpdesk can read.`);
    if (openedText === '' && resolvedText === '') errors.push('Needs the date it was opened or resolved.');
    if (opened === null && resolved !== null && openedText === '') {
      opened = resolved;
      notes.push('No opened date, so it opens when it was resolved.');
    }
    if (resolved === null && opened !== null && resolvedText === '') {
      resolved = opened;
      notes.push('No resolved date, so it is resolved when it was opened.');
    }
    if (opened !== null && resolved !== null) {
      const openedProblem = momentProblem(opened, context.nowMs, 'The opened date');
      const resolvedProblem = momentProblem(resolved, context.nowMs, 'The resolved date');
      if (openedProblem) errors.push(openedProblem);
      if (resolvedProblem) errors.push(resolvedProblem);
      if (Date.parse(resolved) < Date.parse(opened)) {
        errors.push('Resolved before it was opened. Check which date column is which.');
      }
    }

    const categoryText = cellOf(cells, mapping, 'category');
    const category = categoryOf(categoryText);
    if (!category.known) notes.push(`“${categoryText}” is not a category here; filed as Other.`);
    const priorityText = cellOf(cells, mapping, 'priority');
    const priority = priorityOf(priorityText);
    if (!priority.known) notes.push(`“${priorityText}” is not a priority here; filed as Normal.`);

    const solution = cellOf(cells, mapping, 'solution');
    if (solution.length > 6000) errors.push('The solution is over 6000 characters.');

    // Who fixed it. An account when there is one and naming it is allowed;
    // otherwise the importer, with the sheet's name kept in the history.
    const resolverText = cellOf(cells, mapping, 'resolvedBy');
    let resolvedBy: string | null = null;
    let resolvedByName: string | null = null;
    if (resolverText !== '') {
      if (resolverText.length > 120) errors.push('The name of who fixed it is over 120 characters.');
      const account = resolverFor(resolverText, context.resolvers);
      if (account && account.id === context.actorId) {
        resolvedBy = null;
      } else if (account && context.isAdmin) {
        resolvedBy = account.id;
      } else if (account) {
        resolvedByName = resolverText;
        notes.push(`Only an administrator can credit ${account.displayName}. It will be yours, with the name kept in the history.`);
      } else {
        resolvedByName = resolverText;
        notes.push(`No account called ${resolverText}. It will be yours, with the name kept in the history.`);
      }
    }

    // Who asked. The directory's answer, when it has come back.
    const requesterKey = cellOf(cells, mapping, 'requester');
    let requesterId: string | null = null;
    let requester: PreviewRow['requester'] = { key: requesterKey, state: 'none', label: null };
    if (requesterKey !== '') {
      const answer = context.people.get(requesterKey.toLowerCase());
      if (!answer) {
        requester = { key: requesterKey, state: 'pending', label: null };
      } else if (answer.found === 'match' && answer.id) {
        requesterId = answer.id;
        requester = { key: requesterKey, state: 'match', label: answer.displayName };
      } else if (answer.found === 'ambiguous') {
        requester = { key: requesterKey, state: 'ambiguous', label: `${answer.matches} people match` };
        notes.push(`${answer.matches} people match “${requesterKey}”. The requester is left unknown.`);
      } else {
        requester = { key: requesterKey, state: 'unmatched', label: 'Not in the directory' };
        notes.push(`Nobody in the directory matches “${requesterKey}”. The requester is left unknown.`);
      }
    }

    const location = cellOf(cells, mapping, 'location');

    const payload: ImportPayload | null =
      errors.length === 0 && opened !== null && resolved !== null
        ? {
            title,
            issue: issueText === '' ? null : issueText,
            opened_at: opened,
            resolved_at: resolved,
            resolved_by: resolvedBy,
            resolved_by_name: resolvedByName,
            requester_id: requesterId,
            location: location === '' ? null : location,
            category: category.value,
            priority: priority.value,
            solution: solution === '' ? null : solution,
          }
        : null;

    return { line: index + 2, cells, payload, errors, notes, requester };
  });
}

/** The distinct requester cells, in the order they first appear. */
export function requesterKeys(sheet: Sheet, mapping: readonly ImportField[]): string[] {
  const index = mapping.indexOf('requester');
  if (index === -1) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const cells of sheet.rows) {
    const key = (cells[index] ?? '').trim();
    if (key === '' || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    keys.push(key);
  }
  return keys;
}

/** How one row came back from the database. */
export interface ImportOutcome {
  line: number;
  outcome: 'made' | 'skipped' | 'refused';
  ticketId: string | null;
  ticketNumber: string | null;
  message: string | null;
}

/** The result, counted: what was made, what was already here, what was not. */
export function importSummary(outcomes: readonly ImportOutcome[]): string {
  const made = outcomes.filter((row) => row.outcome === 'made').length;
  const skipped = outcomes.filter((row) => row.outcome === 'skipped').length;
  const refused = outcomes.filter((row) => row.outcome === 'refused').length;
  const parts = [made === 0 ? 'Made nothing new.' : `Made ${made} ${made === 1 ? 'ticket' : 'tickets'}.`];
  if (skipped > 0) parts.push(`Skipped ${skipped} already in the helpdesk.`);
  if (refused > 0) parts.push(`Refused ${refused}.`);
  return parts.join(' ');
}
