/**
 * What a form is, as every screen, action and assistant tool agrees on it.
 *
 * Pure: no React, no `server-only`, no `'use server'`. The database's own
 * `app_form_clean_fields` and `app_form_clean_answers` are the authority; the
 * ceilings and checks here mirror them so a box stops where the column does
 * and a respondent hears about a missing answer before a round trip, not
 * instead of one.
 */

export const FORM_TITLE_MAX = 120;
export const FORM_DESCRIPTION_MAX = 2000;
export const FORM_FIELD_LIMIT = 60;
export const FORM_LABEL_MAX = 200;
export const FORM_HELP_MAX = 500;
export const FORM_OPTION_LIMIT = 50;
export const FORM_OPTION_MAX = 120;
export const FORM_SHORT_MAX = 500;
export const FORM_LONG_MAX = 5000;
export const FORM_DIRECTORY_MAX = 300;
export const FORM_SIGNATURE_MAX = 20000;
export const FORM_CAP_MAX = 10000;

/** The signature pad's drawing box. Paths are stored in these units. */
export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 200;

export type QuestionType =
  | 'short_text'
  | 'long_text'
  | 'single_choice'
  | 'multi_choice'
  | 'dropdown'
  | 'number'
  | 'date'
  | 'yes_no'
  | 'signature';

export type FieldType = QuestionType | 'directory';

export type DirectoryKey =
  | 'full_name'
  | 'external_id'
  | 'email'
  | 'class_of'
  | 'official_class'
  | 'guardian_name'
  | 'guardian_phone';

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  /** Choice questions only. */
  options?: string[];
  /** Directory questions only: which fact the directory answers. */
  directory?: DirectoryKey;
}

export type FormAudience = 'directory' | 'anyone';
export type FormState = 'open' | 'closed' | 'full';

export const QUESTION_TYPES: readonly QuestionType[] = [
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'dropdown',
  'number',
  'date',
  'yes_no',
  'signature',
];

export const DIRECTORY_KEYS: readonly DirectoryKey[] = [
  'full_name',
  'external_id',
  'email',
  'class_of',
  'official_class',
  'guardian_name',
  'guardian_phone',
];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  short_text: 'Short answer',
  long_text: 'Paragraph',
  single_choice: 'One choice',
  multi_choice: 'Checkboxes',
  dropdown: 'Dropdown',
  number: 'Number',
  date: 'Date',
  yes_no: 'Yes or no',
  signature: 'Signature',
};

export const DIRECTORY_LABELS: Record<DirectoryKey, string> = {
  full_name: 'Full name',
  external_id: 'OSIS or staff ID',
  email: 'School email',
  class_of: 'Class of',
  official_class: 'Official class',
  guardian_name: 'Guardian name',
  guardian_phone: 'Guardian phone',
};

export const FORM_STATE_LABELS: Record<FormState, string> = {
  open: 'Open',
  closed: 'Closed',
  full: 'Full',
};

export const AUDIENCE_LABELS: Record<FormAudience, string> = {
  directory: 'People in the directory',
  anyone: 'Anyone with the link',
};

export function isChoiceType(type: FieldType): boolean {
  return type === 'single_choice' || type === 'multi_choice' || type === 'dropdown';
}

export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value);
}

export function isDirectoryKey(value: unknown): value is DirectoryKey {
  return typeof value === 'string' && (DIRECTORY_KEYS as readonly string[]).includes(value);
}

export function isFormState(value: unknown): value is FormState {
  return value === 'open' || value === 'closed' || value === 'full';
}

/** The label a question shows, which a question still being written may not have. */
export function fieldLabel(field: Pick<FormField, 'label' | 'type' | 'directory'>): string {
  const label = field.label.trim();
  if (label !== '') return label;
  if (field.type === 'directory' && field.directory) return DIRECTORY_LABELS[field.directory];
  return 'Untitled question';
}

/** A fresh question id: short, lowercase, unique within the form. */
export function newFieldId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '');
    if (id.length >= 4 && !used.has(id)) return id;
  }
}

/** A new question of one type, as the builder adds it. */
export function blankField(type: FieldType, taken: Iterable<string>, directory?: DirectoryKey): FormField {
  const field: FormField = {
    id: newFieldId(taken),
    type,
    label: type === 'directory' && directory ? DIRECTORY_LABELS[directory] : '',
    help: '',
    required: type === 'directory',
  };
  if (isChoiceType(type)) field.options = ['Option 1', 'Option 2'];
  if (type === 'directory' && directory) field.directory = directory;
  return field;
}

/** One stored question, read defensively: anything unreadable is dropped. */
export function fieldFromJson(value: unknown): FormField | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const type = row.type;
  if (typeof row.id !== 'string' || (type !== 'directory' && !isQuestionType(type))) return null;
  const field: FormField = {
    id: row.id,
    type: type as FieldType,
    label: typeof row.label === 'string' ? row.label : '',
    help: typeof row.help === 'string' ? row.help : '',
    required: row.required === true,
  };
  if (isChoiceType(field.type)) {
    field.options = Array.isArray(row.options)
      ? row.options.filter((option): option is string => typeof option === 'string')
      : [];
  }
  if (field.type === 'directory') {
    if (!isDirectoryKey(row.directory)) return null;
    field.directory = row.directory;
  }
  return field;
}

export function fieldsFromJson(value: unknown): FormField[] {
  if (!Array.isArray(value)) return [];
  const fields: FormField[] = [];
  for (const entry of value) {
    const field = fieldFromJson(entry);
    if (field) fields.push(field);
  }
  return fields;
}

/** Which directory facts a form already asks for, so the builder can grey them out. */
export function usedDirectoryKeys(fields: readonly FormField[]): Set<DirectoryKey> {
  const used = new Set<DirectoryKey>();
  for (const field of fields) if (field.type === 'directory' && field.directory) used.add(field.directory);
  return used;
}

/** Moves one question from `from` to `to`, returning a new list. */
export function moveField<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** "Keep what the directory holds", for a prefilled answer nobody changed. */
export interface KeepAnswer {
  keep: true;
}

export type AnswerValue = string | boolean | number | string[] | KeepAnswer | null;
export type Answers = Record<string, AnswerValue>;

export function isKeep(value: unknown): value is KeepAnswer {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).keep === true;
}

/** Whether a question has an answer worth sending. */
export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (isKeep(value)) return true;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The first thing wrong with a set of answers, as the sentence the page shows
 * beside the question, keyed by question id. The database says the same things
 * again; this is so a respondent hears them before a round trip.
 */
export function answerErrors(fields: readonly FormField[], answers: Answers): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = answers[field.id];
    if (!isAnswered(value)) {
      if (field.required) errors[field.id] = 'Answer this question.';
      continue;
    }
    if (isKeep(value)) continue;
    if (field.type === 'number' && typeof value === 'string' && !/^-?\d{1,12}(\.\d{1,6})?$/.test(value.trim())) {
      errors[field.id] = 'Write a number.';
    }
    if (field.type === 'date' && typeof value === 'string' && !isRealDate(value.trim())) {
      errors[field.id] = 'Choose a real date.';
    }
    if (field.type === 'short_text' && typeof value === 'string' && value.trim().length > FORM_SHORT_MAX) {
      errors[field.id] = `Keep it under ${FORM_SHORT_MAX} characters.`;
    }
    if (field.type === 'directory' && typeof value === 'string' && value.trim().length > FORM_DIRECTORY_MAX) {
      errors[field.id] = `Keep it under ${FORM_DIRECTORY_MAX} characters.`;
    }
  }
  return errors;
}

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** One stored answer as a line of text, for a table cell, a CSV or a paste. */
export function answerText(field: FormField | undefined, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field?.type === 'signature') return typeof value === 'string' && value !== '' ? 'Signed' : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

// ---------------------------------------------------------------------------
// Responses as a table
// ---------------------------------------------------------------------------

/** Where a response came from: the public link, a kiosk, or a sheet imported later. */
export type FormResponseVia = 'link' | 'kiosk' | 'import';

export function responseVia(value: unknown): FormResponseVia {
  return value === 'kiosk' ? 'kiosk' : value === 'import' ? 'import' : 'link';
}

export const VIA_LABELS: Record<FormResponseVia, string> = {
  link: 'Link',
  kiosk: 'Kiosk',
  import: 'Imported',
};

export interface FormResponseRow {
  id: string;
  requesterId: string | null;
  displayName: string | null;
  externalId: string | null;
  answers: Record<string, unknown>;
  changed: string[];
  via: FormResponseVia;
  submittedAt: string;
  recordedByName: string | null;
}

/** The respondent, as the first column names them. */
export function respondentName(row: FormResponseRow, fields: readonly FormField[]): string {
  if (row.displayName) return row.displayName;
  const named = fields.find((field) => field.type === 'directory' && field.directory === 'full_name');
  const value = named ? row.answers[named.id] : undefined;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return 'Not matched';
}

/** Header and rows of the responses, in the form's question order. */
export function responseTable(
  fields: readonly FormField[],
  rows: readonly FormResponseRow[],
  formatInstant: (iso: string) => string,
): string[][] {
  const header = ['Submitted', 'Respondent', 'OSIS or staff ID', ...fields.map(fieldLabel), 'Taken at'];
  const body = rows.map((row) => [
    formatInstant(row.submittedAt),
    respondentName(row, fields),
    row.externalId ?? '',
    ...fields.map((field) => answerText(field, row.answers[field.id])),
    row.via === 'link' ? VIA_LABELS.link : `${VIA_LABELS[row.via]}${row.recordedByName ? ` (${row.recordedByName})` : ''}`,
  ]);
  return [header, ...body];
}

/**
 * Tab-separated text that Google Sheets and Excel paste as a table. A tab or a
 * line break inside a cell would split it, so both become spaces; a cell that
 * begins with a formula character is prefixed so a pasted answer can never be
 * executed as a formula.
 */
export function toTsv(table: readonly (readonly string[])[]): string {
  return table
    .map((row) =>
      row
        .map((cell) => {
          const flat = cell.replace(/[\t\r\n]+/g, ' ');
          return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
        })
        .join('\t'),
    )
    .join('\n');
}

/** Counts per choice for the summary cards, in the form's own order. */
export function choiceCounts(field: FormField, rows: readonly FormResponseRow[]): Array<{ option: string; count: number }> {
  const options = field.type === 'yes_no' ? ['Yes', 'No'] : field.options ?? [];
  const counts = new Map(options.map((option) => [option, 0]));
  for (const row of rows) {
    const value = row.answers[field.id];
    const picked =
      field.type === 'yes_no'
        ? typeof value === 'boolean'
          ? [value ? 'Yes' : 'No']
          : []
        : Array.isArray(value)
          ? value.map(String)
          : typeof value === 'string'
            ? [value]
            : [];
    for (const option of picked) {
      if (counts.has(option)) counts.set(option, (counts.get(option) ?? 0) + 1);
    }
  }
  return options.map((option) => ({ option, count: counts.get(option) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Strokes as an SVG path in the pad's own units: "M12 40L13 41L15 43M…".
 * Whole numbers only, so a signature is a few kilobytes rather than a PNG.
 */
export function strokesToPath(strokes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): string {
  const parts: string[] = [];
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    const points = stroke.map((point) => ({
      x: Math.max(0, Math.min(SIGNATURE_WIDTH, Math.round(point.x))),
      y: Math.max(0, Math.min(SIGNATURE_HEIGHT, Math.round(point.y))),
    }));
    const [first, ...rest] = points;
    let segment = `M${first.x} ${first.y}`;
    // A tap is a dot: give it a length so it draws.
    if (rest.length === 0) segment += `L${first.x + 1} ${first.y}`;
    let last = first;
    for (const point of rest) {
      if (point.x === last.x && point.y === last.y) continue;
      segment += `L${point.x} ${point.y}`;
      last = point;
    }
    parts.push(segment);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Templates: the three forms a skills officer starts from.
// ---------------------------------------------------------------------------

export type FormTemplateKey = 'trip' | 'checkin' | 'blank';

export interface FormTemplate {
  key: FormTemplateKey;
  name: string;
  summary: string;
  title: string;
  description: string;
  audience: FormAudience;
  fields: Array<Omit<FormField, 'id'>>;
}

export const FORM_TEMPLATES: readonly FormTemplate[] = [
  {
    key: 'trip',
    name: 'Trip sign-up',
    summary: 'Name, class and guardian filled in from the directory, plus a signature.',
    title: 'Trip sign-up',
    description: 'Sign up for the trip. Your details come from the school directory; fix anything that is out of date.',
    audience: 'directory',
    fields: [
      { type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
      { type: 'directory', directory: 'external_id', label: 'OSIS', help: '', required: true },
      { type: 'directory', directory: 'official_class', label: 'Official class', help: '', required: false },
      { type: 'directory', directory: 'guardian_name', label: 'Guardian name', help: '', required: true },
      {
        type: 'directory',
        directory: 'guardian_phone',
        label: 'Guardian phone',
        help: 'The number we call if something comes up on the day.',
        required: true,
      },
      {
        type: 'multi_choice',
        label: 'Dietary needs',
        help: '',
        required: false,
        options: ['Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Nut allergy'],
      },
      { type: 'signature', label: 'Guardian signature', help: 'Sign with a finger or a mouse.', required: true },
    ],
  },
  {
    key: 'checkin',
    name: 'Event check-in',
    summary: 'Who arrived, from their ID. Link an event and it marks them present.',
    title: 'Check in',
    description: '',
    audience: 'directory',
    fields: [
      { type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
      { type: 'directory', directory: 'official_class', label: 'Official class', help: '', required: false },
    ],
  },
  {
    key: 'blank',
    name: 'Blank form',
    summary: 'Start with nothing and add questions.',
    title: 'Untitled form',
    description: '',
    audience: 'directory',
    fields: [],
  },
];

export function templateFields(template: FormTemplate): FormField[] {
  const fields: FormField[] = [];
  for (const field of template.fields) {
    fields.push({ ...field, id: newFieldId(fields.map((entry) => entry.id)) });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// What the identity step and a submit answer, and the sentence for each.
// ---------------------------------------------------------------------------

export type RefusalReason =
  | 'missing'
  | 'closed'
  | 'full'
  | 'not_needed'
  | 'incomplete'
  | 'no_match'
  | 'throttled'
  | 'invalid'
  | 'error';

export interface Prefill {
  /** Directory values by question id. */
  prefill: Record<string, string>;
  /** Masked values by question id: a guardian phone as "••• ••• 1234". */
  masked: Record<string, string>;
}

export type IdentifyResult =
  | ({ ok: true; firstName: string; already: boolean } & Prefill)
  | { ok: false; reason: RefusalReason; message: string };

export type SubmitResult =
  | { ok: true; updated: boolean; firstName: string | null }
  | { ok: false; reason: RefusalReason; message: string };

export type KioskIdentifyResult =
  | ({ outcome: 'match'; requesterId: string; firstName: string; already: boolean } & Prefill)
  | { outcome: 'no_match' | 'ambiguous' | 'closed' | 'error'; message: string };

/** The line a respondent reads when a step is refused. */
export function refusalMessage(reason: RefusalReason): string {
  switch (reason) {
    case 'missing':
      return 'This form is not available. The link may be wrong, or the form was deleted.';
    case 'closed':
      return 'This form is closed and is not taking responses.';
    case 'full':
      return 'This form has all the responses it can take.';
    case 'incomplete':
      return 'Enter your school email and your OSIS or staff ID.';
    case 'no_match':
      return 'We could not find you with that email and ID. Check both and try again.';
    case 'throttled':
      return 'Too many tries. Wait fifteen minutes, then try again.';
    case 'not_needed':
      return 'This form does not need your ID.';
    case 'invalid':
      return 'Some answers need another look.';
    default:
      return 'That did not go through. Nothing was sent. Try again.';
  }
}

export function isRefusalReason(value: unknown): value is RefusalReason {
  return (
    value === 'missing' ||
    value === 'closed' ||
    value === 'full' ||
    value === 'not_needed' ||
    value === 'incomplete' ||
    value === 'no_match' ||
    value === 'throttled' ||
    value === 'invalid' ||
    value === 'error'
  );
}

/** A map of strings from the database, anything else dropped. */
export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** The ceiling on what one response may weigh on its way in. */
export const ANSWERS_MAX_BYTES = 200_000;

// ---------------------------------------------------------------------------
// Shapes the form actions take and give. Here because a `'use server'` module
// may export nothing but async functions.
// ---------------------------------------------------------------------------

export interface FormSettingsInput {
  isOpen: boolean;
  closesAt: string | null;
  responseCap: number | null;
  audience: FormAudience;
  groupId: string | null;
  eventId: string | null;
  shared: boolean;
}

export type FormShareResult =
  | { ok: true; url: string; qrSvg: string; kioskPath: string }
  | { ok: false; error: string };

export interface EventChoice {
  id: string;
  name: string;
  heldOn: string;
}

/**
 * The answers a form starts with: "keep the directory's" for every question
 * the directory answered, nothing for the rest.
 */
export function initialAnswers(
  fields: readonly FormField[],
  prefill: Record<string, string>,
  masked: Record<string, string>,
): Answers {
  const answers: Answers = {};
  for (const field of fields) {
    if (field.type !== 'directory') continue;
    if (prefill[field.id] !== undefined || masked[field.id] !== undefined) answers[field.id] = { keep: true };
  }
  return answers;
}

/** Invented values for the builder's preview. Nobody real. */

export const SAMPLE_PERSON: Record<DirectoryKey, string> = {
  full_name: 'Jordan Rivera',
  external_id: '241000123',
  email: 'jordan.rivera@edison.example',
  class_of: '2028',
  official_class: '10B',
  guardian_name: 'Robin Rivera',
  guardian_phone: '••• ••• 0142',
};

/** The preview's prefill for a set of questions, from the invented person. */
export function samplePrefill(fields: readonly FormField[]): Prefill {
  const prefill: Record<string, string> = {};
  const masked: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'directory' || !field.directory) continue;
    if (field.directory === 'guardian_phone') masked[field.id] = SAMPLE_PERSON.guardian_phone;
    else prefill[field.id] = SAMPLE_PERSON[field.directory];
  }
  return { prefill, masked };
}
