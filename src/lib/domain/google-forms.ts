/**
 * Google Forms, in and out.
 *
 * A skills officer arriving here has a term of Google Forms behind them, and
 * the officers they hand a form to may still want one. This module is
 * everything about that which does not need a network:
 *
 *   IN, from a link. A public Google Form's page carries the whole form as a
 *   JSON array assigned to `FB_PUBLIC_LOAD_DATA_`. `extractLoadData` finds it
 *   and `draftFromLoadData` reads it: the title, the description and each
 *   question with its type, choices and whether it is required.
 *   IN, from a script. A school form that needs a sign-in never shows that
 *   page to a server, so the officer runs `APPS_SCRIPT_READER` in their own
 *   Google account; it writes the same facts as JSON, which
 *   `draftFromAppsScript` reads.
 *   OUT, as a script. `googleFormScript` writes an Apps Script that builds the
 *   same form with FormApp in the officer's Google account.
 *
 * Every door ends at the same `FormDraft`: questions in this helpdesk's own
 * types, what was changed on the way, and what could not come at all. A
 * question whose title says it is a name, an email, an OSIS, a class or a
 * guardian is offered as a directory question, which the preview can turn off.
 *
 * Pure: no React, no fetch. `src/lib/google-forms/fetch.ts` does the network.
 */

import {
  DIRECTORY_LABELS,
  FORM_DESCRIPTION_MAX,
  FORM_FIELD_LIMIT,
  FORM_HELP_MAX,
  FORM_LABEL_MAX,
  FORM_OPTION_LIMIT,
  FORM_OPTION_MAX,
  FORM_TITLE_MAX,
  fieldLabel,
  fieldsFromJson,
  isChoiceType,
  newFieldId,
  type DirectoryKey,
  type FormField,
  type QuestionType,
} from '@/lib/domain/forms';

// ---------------------------------------------------------------------------
// The draft every door arrives at
// ---------------------------------------------------------------------------

export interface DraftQuestion {
  type: QuestionType;
  label: string;
  help: string;
  required: boolean;
  options?: string[];
  /** A directory fact the title names, offered rather than imposed. */
  directory: DirectoryKey | null;
  /** What Google called it: "Short answer", "Linear scale". */
  from: string;
  /** What changed on the way, when something did. */
  note: string | null;
}

export interface SkippedItem {
  label: string;
  reason: string;
}

export interface FormDraft {
  source: 'google' | 'apps_script' | 'edison';
  title: string;
  description: string;
  questions: DraftQuestion[];
  skipped: SkippedItem[];
}

// ---------------------------------------------------------------------------
// Directory questions, by what their title says
// ---------------------------------------------------------------------------

function words(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * The directory fact a question's title asks for, or null.
 *
 * Asked in the order that settles overlaps: a guardian's phone and a
 * guardian's name before a name or a number, an email before a name ("Name
 * and email" is an email box more often than a name box). "First name" and
 * "Last name" are not a directory question: the directory holds a full name,
 * and prefilling half of it into each box would be wrong in both.
 */
export function directoryKeyFor(title: string): DirectoryKey | null {
  const text = words(title);
  const guardian = / (parent|guardian|mother|father|family|emergency contact)/.test(text);
  if (guardian && / (phone|cell|number|telephone|contact)/.test(text) && !/ email /.test(text)) {
    return 'guardian_phone';
  }
  if (guardian && / name /.test(text)) return 'guardian_name';
  if (guardian) return null;
  if (/ (e mail|email) /.test(text)) return 'email';
  if (/ (osis|student id|student number|id number|staff id) /.test(text)) return 'external_id';
  if (/ (class of|graduation year|grad year|year of graduation) /.test(text)) return 'class_of';
  if (/ (official class|homeroom|home room) /.test(text)) return 'official_class';
  // A bare "Grade" or "Class" is the official class ("10B" says both); "Which
  // class are you taking" is not, so only the short titles count.
  if (/^ (your |current )?(grade|class|grade level|grade and class)( are you in)? $/.test(text)) {
    return 'official_class';
  }
  if (/^ what (grade|class) are you in $/.test(text)) return 'official_class';
  if (
    / (full name|student name|student s name|first and last name|first last name) /.test(text) ||
    /^ (your )?name( first and last| last first| first last)? $/.test(text)
  ) {
    return 'full_name';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Limits, applied the same way to every door
// ---------------------------------------------------------------------------

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit).trimEnd();
}

function cleanOptions(raw: readonly string[]): { options: string[]; note: string | null } {
  const seen = new Set<string>();
  const options: string[] = [];
  let cut = false;
  for (const entry of raw) {
    const text = clip(entry, FORM_OPTION_MAX);
    if (text === '' || seen.has(text)) continue;
    if (text !== entry.trim()) cut = true;
    seen.add(text);
    options.push(text);
  }
  if (options.length > FORM_OPTION_LIMIT) {
    return {
      options: options.slice(0, FORM_OPTION_LIMIT),
      note: `Only the first ${FORM_OPTION_LIMIT} of ${options.length} choices came across.`,
    };
  }
  return { options, note: cut ? `A choice longer than ${FORM_OPTION_MAX} characters was shortened.` : null };
}

function joinNotes(...notes: Array<string | null>): string | null {
  const present = notes.filter((note): note is string => note !== null && note !== '');
  return present.length === 0 ? null : present.join(' ');
}

function question(
  type: QuestionType,
  label: string,
  help: string,
  required: boolean,
  from: string,
  extra: { options?: readonly string[]; note?: string | null } = {},
): DraftQuestion {
  const cleanLabel = clip(label, FORM_LABEL_MAX);
  const draft: DraftQuestion = {
    type,
    label: cleanLabel,
    help: clip(help, FORM_HELP_MAX),
    required,
    directory: type === 'short_text' || type === 'long_text' ? directoryKeyFor(cleanLabel) : null,
    from,
    note: extra.note ?? null,
  };
  if (isChoiceType(type)) {
    const cleaned = cleanOptions(extra.options ?? []);
    draft.options = cleaned.options;
    draft.note = joinNotes(draft.note, cleaned.note);
  }
  if (label.trim().length > FORM_LABEL_MAX) {
    draft.note = joinNotes(draft.note, `The question was cut to ${FORM_LABEL_MAX} characters.`);
  }
  return draft;
}

/** A scale from `low` to `high`, as the one-choice question it becomes. */
function scaleQuestion(
  label: string,
  help: string,
  required: boolean,
  from: string,
  steps: readonly string[],
  lowLabel: string,
  highLabel: string,
): DraftQuestion {
  const ends =
    lowLabel !== '' || highLabel !== ''
      ? `${steps[0] ?? ''}${lowLabel ? ` is ${lowLabel}` : ''}${lowLabel && highLabel ? ', ' : ''}${
          highLabel ? `${steps[steps.length - 1] ?? ''} is ${highLabel}` : ''
        }.`
      : '';
  const fullHelp = [help.trim(), ends].filter(Boolean).join(' ');
  return question('single_choice', label, fullHelp, required, from, {
    options: steps,
    note: `${from} became one choice from ${steps[0] ?? '1'} to ${steps[steps.length - 1] ?? ''}.`,
  });
}

// ---------------------------------------------------------------------------
// IN: the public page's FB_PUBLIC_LOAD_DATA_
// ---------------------------------------------------------------------------

/** The byte ceiling on a page this module will look at. */
export const GOOGLE_PAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The JSON assigned to `FB_PUBLIC_LOAD_DATA_` on a Google Form's page, or null.
 *
 * Found by walking brackets from the first `[` after the name, with strings
 * (and the escapes inside them) stepped over, so a `]` in a question title
 * does not end the array early. Parsed as JSON and nothing else: nothing on
 * the page is ever evaluated.
 */
export function extractLoadData(html: string): unknown {
  const at = html.indexOf('FB_PUBLIC_LOAD_DATA_');
  if (at === -1) return null;
  const equals = html.indexOf('=', at);
  if (equals === -1) return null;
  const start = html.indexOf('[', equals);
  if (start === -1 || start - equals > 20) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Google's own item types, by the number the page carries. */
const GOOGLE_TYPES: Record<number, string> = {
  0: 'Short answer',
  1: 'Paragraph',
  2: 'Multiple choice',
  3: 'Dropdown',
  4: 'Checkboxes',
  5: 'Linear scale',
  6: 'Title and description',
  7: 'Grid',
  8: 'Section',
  9: 'Date',
  10: 'Time',
  11: 'Image',
  12: 'Video',
  13: 'File upload',
  18: 'Rating',
};

/**
 * The form a page's `FB_PUBLIC_LOAD_DATA_` describes, or null when the array
 * is not the shape of one.
 *
 *   data[1][0]   description
 *   data[1][1]   items: [id, title, help, type, entries, ...]
 *   data[1][8]   title (data[3] is the file's name, used when it is empty)
 *   entry        [entryId, options, required (1), scale labels, ...]
 *   option       [text, ..., isOther at 4]
 */
export function draftFromLoadData(data: unknown): FormDraft | null {
  const root = list(data);
  const body = list(root[1]);
  if (body.length === 0 || !Array.isArray(body[1])) return null;

  const title = text(body[8]) || text(root[3]);
  const description = text(body[0]);
  const questions: DraftQuestion[] = [];
  const skipped: SkippedItem[] = [];
  let heading: { title: string; help: string } | null = null;

  for (const raw of list(body[1])) {
    const item = list(raw);
    const label = text(item[1]).trim();
    const help = text(item[2]);
    const typeId = typeof item[3] === 'number' ? item[3] : -1;
    const from = GOOGLE_TYPES[typeId] ?? 'An unknown kind of question';
    const entries = list(item[4]);
    const entry = list(entries[0]);
    const required = entry[2] === 1 || entry[2] === true;
    const rawOptions = list(entry[1]).map(list);
    const hasOther = rawOptions.some((option) => option[4] === 1 || option[4] === true);
    const options = rawOptions
      .filter((option) => !(option[4] === 1 || option[4] === true))
      .map((option) => text(option[0]));
    const otherNote = hasOther ? 'The "Other" write-in was left out.' : null;

    let added: DraftQuestion | null = null;
    switch (typeId) {
      case 0:
        added = question('short_text', label, help, required, from);
        break;
      case 1:
        added = question('long_text', label, help, required, from);
        break;
      case 2:
        added = question('single_choice', label, help, required, from, { options, note: otherNote });
        break;
      case 3:
        added = question('dropdown', label, help, required, from, { options });
        break;
      case 4:
        added = question('multi_choice', label, help, required, from, { options, note: otherNote });
        break;
      case 5:
      case 18: {
        const labels = list(entry[3]).map(text);
        const steps = options.length > 0 ? options : [];
        if (steps.length === 0) {
          skipped.push({ label: label || 'Untitled', reason: `${from} with no steps to choose from.` });
          break;
        }
        added = scaleQuestion(label, help, required, from, steps, labels[0] ?? '', labels[1] ?? '');
        break;
      }
      case 9: {
        const flags = list(entry[7]);
        added = question('date', label, help, required, from, {
          note: flags[0] === 1 ? 'The time of day was left off; it asks for the date.' : null,
        });
        break;
      }
      case 10:
        added = question('short_text', label, help, required, from, { note: 'A time became a short answer.' });
        break;
      case 6:
      case 8:
        heading = { title: label, help: help.trim() };
        if (help.trim() === '') {
          skipped.push({
            label: label || 'Untitled section',
            reason: typeId === 8 ? 'A section break. The form here is one page.' : 'A heading with no text under it.',
          });
          heading = null;
        }
        break;
      case 7:
        skipped.push({ label: label || 'Untitled grid', reason: 'A grid has no match here. Ask it as separate questions.' });
        break;
      case 13:
        skipped.push({ label: label || 'Untitled upload', reason: 'File uploads are not taken by these forms.' });
        break;
      case 11:
      case 12:
        skipped.push({ label: label || `Untitled ${from.toLowerCase()}`, reason: `${from}s are not part of these forms.` });
        break;
      default:
        skipped.push({ label: label || 'Untitled', reason: 'A kind of question this helpdesk has no match for.' });
    }

    if (added) {
      if (heading) {
        // A section's own words, kept where somebody will read them: under
        // the first question of the section.
        const lead = [heading.title, heading.help].filter(Boolean).join('. ');
        added.help = clip([lead, added.help].filter(Boolean).join('\n'), FORM_HELP_MAX);
        added.note = joinNotes(added.note, `The section "${heading.title || 'Untitled'}" is now in its help text.`);
        heading = null;
      }
      questions.push(added);
    }
  }

  if (heading) skipped.push({ label: heading.title || 'Untitled section', reason: 'A heading with no question after it.' });
  return finish({ source: 'google', title, description, questions, skipped });
}

// ---------------------------------------------------------------------------
// IN: the Apps Script reader's JSON
// ---------------------------------------------------------------------------

/**
 * Reads a Google Form by its edit link and logs it as JSON, for a form the
 * server cannot see because it needs a sign-in. Run in the officer's own
 * Google account, which is the one that can open the form.
 *
 * FormApp's item types, and what each carries:
 *   TEXT, PARAGRAPH_TEXT, DATE, DATETIME, TIME, DURATION   required
 *   MULTIPLE_CHOICE, CHECKBOX                              choices, other
 *   LIST                                                   choices
 *   SCALE                                                  lower, upper, labels
 *   RATING                                                 scale
 *   SECTION_HEADER, PAGE_BREAK                             help text only
 *   GRID, CHECKBOX_GRID, FILE_UPLOAD, IMAGE, VIDEO         nothing we can use
 */
export const APPS_SCRIPT_READER = `/**
 * Reads a Google Form and prints it as JSON for Edison Helpdesk.
 * 1. Paste your form's EDIT link between the quotes below.
 * 2. Press Run. Allow access when Google asks (it only reads the form).
 * 3. Copy everything the Execution log shows and paste it back into Edison.
 */
var FORM_EDIT_LINK = 'PASTE_THE_EDIT_LINK_HERE';

function exportFormForEdison() {
  var form = FormApp.openByUrl(FORM_EDIT_LINK);
  var out = {
    source: 'edison-apps-script',
    version: 1,
    title: form.getTitle(),
    description: form.getDescription(),
    items: []
  };
  form.getItems().forEach(function (item) {
    var type = String(item.getType());
    var entry = { type: type, title: item.getTitle(), help: item.getHelpText(), required: false };
    var typed = null;
    switch (item.getType()) {
      case FormApp.ItemType.TEXT: typed = item.asTextItem(); break;
      case FormApp.ItemType.PARAGRAPH_TEXT: typed = item.asParagraphTextItem(); break;
      case FormApp.ItemType.DATE: typed = item.asDateItem(); break;
      case FormApp.ItemType.DATETIME: typed = item.asDateTimeItem(); break;
      case FormApp.ItemType.TIME: typed = item.asTimeItem(); break;
      case FormApp.ItemType.DURATION: typed = item.asDurationItem(); break;
      case FormApp.ItemType.MULTIPLE_CHOICE:
        typed = item.asMultipleChoiceItem();
        entry.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        entry.other = typed.hasOtherOption();
        break;
      case FormApp.ItemType.CHECKBOX:
        typed = item.asCheckboxItem();
        entry.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        entry.other = typed.hasOtherOption();
        break;
      case FormApp.ItemType.LIST:
        typed = item.asListItem();
        entry.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        break;
      case FormApp.ItemType.SCALE:
        typed = item.asScaleItem();
        entry.lower = typed.getLowerBound();
        entry.upper = typed.getUpperBound();
        entry.lowerLabel = typed.getLeftLabel();
        entry.upperLabel = typed.getRightLabel();
        break;
      default:
        if (type === 'RATING' && item.asRatingItem) {
          typed = item.asRatingItem();
          entry.lower = 1;
          entry.upper = typed.getRatingScaleLevel();
        }
    }
    if (typed && typed.isRequired) entry.required = typed.isRequired();
    out.items.push(entry);
  });
  Logger.log(JSON.stringify(out));
}
`;

/** The JSON inside whatever was pasted: the log's timestamps and all. */
export function jsonInPaste(pasted: string): unknown {
  const start = pasted.indexOf('{');
  const end = pasted.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(pasted.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SCRIPT_TYPES: Record<string, string> = {
  TEXT: 'Short answer',
  PARAGRAPH_TEXT: 'Paragraph',
  MULTIPLE_CHOICE: 'Multiple choice',
  CHECKBOX: 'Checkboxes',
  LIST: 'Dropdown',
  SCALE: 'Linear scale',
  RATING: 'Rating',
  DATE: 'Date',
  DATETIME: 'Date and time',
  TIME: 'Time',
  DURATION: 'Duration',
  SECTION_HEADER: 'Title and description',
  PAGE_BREAK: 'Section',
  GRID: 'Grid',
  CHECKBOX_GRID: 'Checkbox grid',
  FILE_UPLOAD: 'File upload',
  IMAGE: 'Image',
  VIDEO: 'Video',
};

function stringList(value: unknown): string[] {
  return list(value).map((entry) => (typeof entry === 'number' ? String(entry) : text(entry)));
}

/** What `APPS_SCRIPT_READER` logged, as a draft; null when it is not that. */
export function draftFromAppsScript(value: unknown): FormDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.source !== 'edison-apps-script' || !Array.isArray(root.items)) return null;

  const questions: DraftQuestion[] = [];
  const skipped: SkippedItem[] = [];
  let heading: { title: string; help: string } | null = null;

  for (const raw of root.items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const type = text(item.type).toUpperCase();
    const label = text(item.title).trim();
    const help = text(item.help);
    const required = item.required === true;
    const from = SCRIPT_TYPES[type] ?? 'An unknown kind of question';
    const choices = stringList(item.choices);
    const otherNote = item.other === true ? 'The "Other" write-in was left out.' : null;

    let added: DraftQuestion | null = null;
    switch (type) {
      case 'TEXT':
        added = question('short_text', label, help, required, from);
        break;
      case 'PARAGRAPH_TEXT':
        added = question('long_text', label, help, required, from);
        break;
      case 'MULTIPLE_CHOICE':
        added = question('single_choice', label, help, required, from, { options: choices, note: otherNote });
        break;
      case 'CHECKBOX':
        added = question('multi_choice', label, help, required, from, { options: choices, note: otherNote });
        break;
      case 'LIST':
        added = question('dropdown', label, help, required, from, { options: choices });
        break;
      case 'SCALE':
      case 'RATING': {
        const lower = Number(item.lower);
        const upper = Number(item.upper);
        if (!Number.isInteger(lower) || !Number.isInteger(upper) || upper < lower || upper - lower > 20) {
          skipped.push({ label: label || 'Untitled', reason: `${from} with no steps to choose from.` });
          break;
        }
        const steps = Array.from({ length: upper - lower + 1 }, (_, at) => String(lower + at));
        added = scaleQuestion(label, help, required, from, steps, text(item.lowerLabel), text(item.upperLabel));
        break;
      }
      case 'DATE':
        added = question('date', label, help, required, from);
        break;
      case 'DATETIME':
        added = question('date', label, help, required, from, {
          note: 'The time of day was left off; it asks for the date.',
        });
        break;
      case 'TIME':
      case 'DURATION':
        added = question('short_text', label, help, required, from, {
          note: `${from === 'Time' ? 'A time' : 'A duration'} became a short answer.`,
        });
        break;
      case 'SECTION_HEADER':
      case 'PAGE_BREAK':
        if (help.trim() === '') {
          skipped.push({
            label: label || 'Untitled section',
            reason: type === 'PAGE_BREAK' ? 'A section break. The form here is one page.' : 'A heading with no text under it.',
          });
        } else {
          heading = { title: label, help: help.trim() };
        }
        break;
      case 'GRID':
      case 'CHECKBOX_GRID':
        skipped.push({ label: label || 'Untitled grid', reason: 'A grid has no match here. Ask it as separate questions.' });
        break;
      case 'FILE_UPLOAD':
        skipped.push({ label: label || 'Untitled upload', reason: 'File uploads are not taken by these forms.' });
        break;
      case 'IMAGE':
      case 'VIDEO':
        skipped.push({ label: label || `Untitled ${from.toLowerCase()}`, reason: `${from}s are not part of these forms.` });
        break;
      default:
        skipped.push({ label: label || 'Untitled', reason: 'A kind of question this helpdesk has no match for.' });
    }

    if (added) {
      if (heading) {
        const lead = [heading.title, heading.help].filter(Boolean).join('. ');
        added.help = clip([lead, added.help].filter(Boolean).join('\n'), FORM_HELP_MAX);
        added.note = joinNotes(added.note, `The section "${heading.title || 'Untitled'}" is now in its help text.`);
        heading = null;
      }
      questions.push(added);
    }
  }
  if (heading) skipped.push({ label: heading.title || 'Untitled section', reason: 'A heading with no question after it.' });

  return finish({
    source: 'apps_script',
    title: text(root.title),
    description: text(root.description),
    questions,
    skipped,
  });
}

// ---------------------------------------------------------------------------
// IN: this helpdesk's own JSON ("Download as JSON")
// ---------------------------------------------------------------------------

export interface EdisonFormJson {
  edison_form: 1;
  title: string;
  description: string;
  audience: 'directory' | 'anyone';
  fields: FormField[];
}

export function formJson(form: {
  title: string;
  description: string;
  audience: 'directory' | 'anyone';
  fields: readonly FormField[];
}): EdisonFormJson {
  return {
    edison_form: 1,
    title: form.title,
    description: form.description,
    audience: form.audience,
    fields: form.fields.map((field) => ({ ...field })),
  };
}

export function draftFromEdisonJson(value: unknown): FormDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.edison_form !== 1) return null;
  const fields = fieldsFromJson(root.fields);
  const questions: DraftQuestion[] = fields.map((field) => {
    if (field.type === 'directory') {
      const draft = question('short_text', fieldLabel(field), field.help, field.required, 'Directory question');
      draft.directory = field.directory ?? null;
      return draft;
    }
    return question(field.type, field.label, field.help, field.required, 'Question', { options: field.options });
  });
  return finish({
    source: 'edison',
    title: text(root.title),
    description: text(root.description),
    questions,
    skipped: [],
  });
}

// ---------------------------------------------------------------------------
// Every door's last step
// ---------------------------------------------------------------------------

function finish(draft: FormDraft): FormDraft {
  const title = clip(draft.title, FORM_TITLE_MAX) || 'Imported form';
  const description = clip(draft.description, FORM_DESCRIPTION_MAX);
  let questions = draft.questions;
  const skipped = [...draft.skipped];
  if (questions.length > FORM_FIELD_LIMIT) {
    for (const extra of questions.slice(FORM_FIELD_LIMIT)) {
      skipped.push({ label: extra.label || 'Untitled', reason: `A form here holds ${FORM_FIELD_LIMIT} questions.` });
    }
    questions = questions.slice(0, FORM_FIELD_LIMIT);
  }
  // A choice question with nothing to choose cannot be answered.
  const answerable = questions.filter((entry) => {
    if (isChoiceType(entry.type) && (entry.options ?? []).length === 0) {
      skipped.push({ label: entry.label || 'Untitled', reason: 'A choice question with no choices.' });
      return false;
    }
    return true;
  });
  // One directory suggestion per fact: the first question that asks for it.
  const offered = new Set<DirectoryKey>();
  for (const entry of answerable) {
    if (entry.directory === null) continue;
    if (offered.has(entry.directory)) entry.directory = null;
    else offered.add(entry.directory);
  }
  return { ...draft, title, description, questions: answerable, skipped };
}

/**
 * Whatever was pasted into the import box, read: a Google Form link to fetch,
 * or JSON from the script or from this helpdesk's own download.
 */
export type ImportInput =
  | { kind: 'link'; link: string }
  | { kind: 'draft'; draft: FormDraft }
  | { kind: 'unreadable'; message: string };

export function readImportInput(pasted: string): ImportInput {
  const trimmed = pasted.trim();
  if (trimmed === '') return { kind: 'unreadable', message: 'Paste a Google Form link, or the JSON the script printed.' };
  if (!trimmed.includes('{')) {
    const link = googleFormLink(trimmed);
    if (link.ok) return { kind: 'link', link: link.url };
    return { kind: 'unreadable', message: link.error };
  }
  const json = jsonInPaste(trimmed);
  if (json === null) {
    return { kind: 'unreadable', message: 'That JSON is cut off. Copy all of the Execution log and paste it again.' };
  }
  const draft = draftFromAppsScript(json) ?? draftFromEdisonJson(json);
  if (draft === null) {
    return { kind: 'unreadable', message: 'That JSON is not a form. Run the script again and copy what it prints.' };
  }
  return { kind: 'draft', draft };
}

/**
 * The questions a draft becomes, with a directory question wherever the
 * preview left one ticked. A directory fact is asked once, so a second
 * question the preview ticked for the same fact stays a short answer.
 */
export function fieldsFromDraft(draft: FormDraft, useDirectory: ReadonlySet<number>): FormField[] {
  const fields: FormField[] = [];
  const asked = new Set<DirectoryKey>();
  draft.questions.forEach((entry, index) => {
    const id = newFieldId(fields.map((field) => field.id));
    if (entry.directory && useDirectory.has(index) && !asked.has(entry.directory)) {
      asked.add(entry.directory);
      fields.push({
        id,
        type: 'directory',
        directory: entry.directory,
        label: entry.label || DIRECTORY_LABELS[entry.directory],
        help: entry.help,
        required: entry.required,
      });
      return;
    }
    const field: FormField = { id, type: entry.type, label: entry.label, help: entry.help, required: entry.required };
    if (isChoiceType(entry.type)) field.options = [...(entry.options ?? [])];
    fields.push(field);
  });
  return fields;
}

/** Every question the draft offers as a directory question, by index. */
export function suggestedDirectory(draft: FormDraft): Set<number> {
  const picked = new Set<number>();
  draft.questions.forEach((entry, index) => {
    if (entry.directory) picked.add(index);
  });
  return picked;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const FORM_ID = /^[A-Za-z0-9_-]{10,120}$/;

/**
 * A Google Form link, rebuilt from its id, or why it is not one.
 *
 * Only two shapes are accepted and neither is fetched as typed: the id is
 * taken out and a fresh `https://docs.google.com/forms/...` or
 * `https://forms.gle/...` address is built around it, so nothing else a
 * person pasted — a port, a user name, a different host — reaches the fetch.
 */
export function googleFormLink(pasted: string): { ok: true; url: string; short: boolean } | { ok: false; error: string } {
  const raw = pasted.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'That is not a link. Copy the form’s link from Google Forms and paste it here.' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only a Google Form link can be read here.' };
  }
  if (host === 'forms.gle') {
    const id = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return { ok: false, error: 'That forms.gle link is cut short.' };
    return { ok: true, url: `https://forms.gle/${id}`, short: true };
  }
  if (host !== 'docs.google.com') {
    return { ok: false, error: 'Only a Google Form link can be read here: docs.google.com/forms or forms.gle.' };
  }
  const canonical = canonicalFormPath(url.pathname);
  if (canonical === null) {
    return { ok: false, error: 'That Google link is not a form. Open the form and copy its link.' };
  }
  return { ok: true, url: `https://docs.google.com${canonical}`, short: false };
}

/**
 * `/forms/d/e/<id>/viewform` for a published form's id, `/forms/d/<id>/viewform`
 * for an editor's id (which Google redirects to the published one when the form
 * is shared). A `/u/1/` account segment is dropped. Null for anything else.
 */
export function canonicalFormPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'forms') return null;
  let rest = parts.slice(1);
  if (rest[0] === 'u' && /^\d+$/.test(rest[1] ?? '')) rest = rest.slice(2);
  if (rest[0] !== 'd') return null;
  if (rest[1] === 'e' && FORM_ID.test(rest[2] ?? '')) return `/forms/d/e/${rest[2]}/viewform`;
  if (FORM_ID.test(rest[1] ?? '') && rest[1] !== 'e') return `/forms/d/${rest[1]}/viewform`;
  return null;
}

/**
 * Where a redirect may go next: another Google Form address (rebuilt), the
 * sign-in page (which means the form needs one), or nowhere.
 */
export function redirectTarget(location: string, from: string): { kind: 'form'; url: string } | { kind: 'signin' } | { kind: 'refused' } {
  let url: URL;
  try {
    url = new URL(location, from);
  } catch {
    return { kind: 'refused' };
  }
  const host = url.hostname.toLowerCase();
  if (host === 'accounts.google.com' || (host === 'docs.google.com' && url.pathname.includes('ServiceLogin'))) {
    return { kind: 'signin' };
  }
  if (url.protocol !== 'https:' || host !== 'docs.google.com') return { kind: 'refused' };
  const path = canonicalFormPath(url.pathname);
  return path === null ? { kind: 'refused' } : { kind: 'form', url: `https://docs.google.com${path}` };
}

/** Whether a page Google answered with is its sign-in page rather than a form. */
export function looksLikeSignIn(html: string): boolean {
  return /accounts\.google\.com\/(v3\/signin|ServiceLogin|AccountChooser)/i.test(html) || /<title>\s*Sign in/i.test(html);
}

// ---------------------------------------------------------------------------
// OUT: an Apps Script that builds the form in Google Forms
// ---------------------------------------------------------------------------

export interface ExportScript {
  script: string;
  /** What will not be the same in Google Forms. */
  notes: string[];
}

function js(value: string): string {
  // JSON is a JavaScript literal; the two line separators JSON allows raw are
  // not legal in an older JavaScript string, so they are escaped too.
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * An Apps Script that makes this form in Google Forms: the title, the
 * description, and every question with its help text, choices and whether it
 * is required. A directory question becomes an ordinary question with the
 * same words (Google has no directory to fill it from), a number question
 * keeps a number check, a yes-or-no becomes a choice of Yes and No, and a
 * signature, which Google Forms cannot take, is left out and said so.
 */
export function googleFormScript(form: {
  title: string;
  description: string;
  fields: readonly FormField[];
}): ExportScript {
  const notes: string[] = [];
  const lines: string[] = [];
  let directory = 0;

  for (const field of form.fields) {
    const label = fieldLabel(field);
    const help = field.help.trim();
    const tail = `${help ? `.setHelpText(${js(help)})` : ''}.setRequired(${field.required ? 'true' : 'false'})`;
    switch (field.type) {
      case 'short_text':
        lines.push(`  form.addTextItem().setTitle(${js(label)})${tail};`);
        break;
      case 'long_text':
        lines.push(`  form.addParagraphTextItem().setTitle(${js(label)})${tail};`);
        break;
      case 'number':
        lines.push(
          `  form.addTextItem().setTitle(${js(label)})${tail}`,
          `    .setValidation(FormApp.createTextValidation().requireNumber().setHelpText('Write a number.').build());`,
        );
        break;
      case 'date':
        lines.push(`  form.addDateItem().setTitle(${js(label)})${tail};`);
        break;
      case 'yes_no':
        lines.push(`  form.addMultipleChoiceItem().setTitle(${js(label)}).setChoiceValues(['Yes', 'No'])${tail};`);
        break;
      case 'single_choice':
        lines.push(
          `  form.addMultipleChoiceItem().setTitle(${js(label)}).setChoiceValues([${(field.options ?? []).map(js).join(', ')}])${tail};`,
        );
        break;
      case 'multi_choice':
        lines.push(
          `  form.addCheckboxItem().setTitle(${js(label)}).setChoiceValues([${(field.options ?? []).map(js).join(', ')}])${tail};`,
        );
        break;
      case 'dropdown':
        lines.push(
          `  form.addListItem().setTitle(${js(label)}).setChoiceValues([${(field.options ?? []).map(js).join(', ')}])${tail};`,
        );
        break;
      case 'directory':
        directory += 1;
        if (field.directory === 'email') {
          lines.push(
            `  form.addTextItem().setTitle(${js(label)})${tail}`,
            `    .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());`,
          );
        } else {
          lines.push(`  form.addTextItem().setTitle(${js(label)})${tail};`);
        }
        break;
      case 'signature':
        lines.push(`  // Left out: "${label.replace(/[\r\n]+/g, ' ')}" is a signature, and Google Forms cannot take one.`);
        notes.push(`"${label}" is a signature, which Google Forms cannot take. It is left out.`);
        break;
    }
  }

  if (directory > 0) {
    notes.push(
      directory === 1
        ? 'The directory question becomes an ordinary question with the same words: Google Forms has no directory to fill it in from.'
        : `The ${directory} directory questions become ordinary questions with the same words: Google Forms has no directory to fill them in from.`,
    );
  }

  const script = [
    '/**',
    ` * Makes the form ${form.title.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ')} in Google Forms, for Edison Helpdesk.`,
    ' * Press Run. Allow access when Google asks: it makes one new form in your Drive.',
    ' * When it finishes, the Execution log shows the new form’s links.',
    ' */',
    'function makeForm() {',
    `  var form = FormApp.create(${js(form.title)});`,
    ...(form.description.trim() ? [`  form.setDescription(${js(form.description.trim())});`] : []),
    ...lines,
    "  Logger.log('Edit it: ' + form.getEditUrl());",
    "  Logger.log('Send it: ' + form.getPublishedUrl());",
    '}',
    '',
  ].join('\n');

  return { script, notes };
}

/** Where a new Apps Script project opens. */
export const APPS_SCRIPT_NEW = 'https://script.new';

/** What reading a pasted link or JSON answers. */
export type GoogleReadResult =
  | { ok: true; draft: FormDraft }
  | {
      ok: false;
      reason: 'invalid' | 'signin' | 'not_found' | 'unreadable' | 'too_large' | 'unreachable';
      message: string;
    };
