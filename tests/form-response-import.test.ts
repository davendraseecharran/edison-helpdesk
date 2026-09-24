/**
 * A Google Form's sheet of responses, read before anything is written.
 *
 * The rows below are invented, in the shape Google Sheets copies them: a
 * Timestamp, an Email Address the form collected, then one column per
 * question headed with the question's words. Pinned here: which column is
 * which question, what each cell becomes, who each row says answered, and
 * which rows the preview refuses before the database has to.
 */

import { describe, expect, it } from 'vitest';
import { readSheet } from '../src/lib/domain/ticket-import';
import {
  answerFromCell,
  dateCell,
  guessTargets,
  identityOf,
  previewResponses,
  responseImportSummary,
  splitChoices,
  targetProblems,
} from '../src/lib/domain/form-response-import';
import type { FormField } from '../src/lib/domain/forms';

const FIELDS: FormField[] = [
  { id: 'name', type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
  { id: 'osis', type: 'directory', directory: 'external_id', label: 'OSIS', help: '', required: false },
  { id: 'shirt', type: 'single_choice', label: 'Shirt size', help: '', required: true, options: ['S', 'M', 'L'] },
  {
    id: 'diet',
    type: 'multi_choice',
    label: 'Dietary needs',
    help: '',
    required: false,
    options: ['Vegetarian', 'Nuts, tree nuts', 'Halal'],
  },
  { id: 'bus', type: 'yes_no', label: 'Taking the bus?', help: '', required: false },
  { id: 'age', type: 'number', label: 'Age', help: '', required: false },
  { id: 'day', type: 'date', label: 'Which day', help: '', required: false },
  { id: 'sign', type: 'signature', label: 'Signature', help: '', required: false },
];

const SHEET = [
  ['Timestamp', 'Email Address', 'Full Name', 'OSIS', 'Shirt size', 'Dietary needs', 'Taking the bus?', 'Age', 'Which day', 'Notes'],
  ['9/23/2026 14:05:31', 'nia.example@edison.example', 'Nia Example', '230000001', 'M', 'Vegetarian, Nuts, tree nuts', 'Yes', '15', '10/14/2026', 'hi'],
  ['9/23/2026 14:06:02', '', 'Jordan Example', '', 'XL', 'Halal', 'No', 'fifteen', '2026-02-30', ''],
  ['', '', '', '', 's', '', '', '1,200', '', ''],
].map((cells) => cells.join('\t')).join('\n');

describe('columns', () => {
  it('maps headings to questions by their words, and the rest to who and when', () => {
    const sheet = readSheet(SHEET)!;
    const targets = guessTargets(sheet.headers, FIELDS);
    expect(targets).toEqual(['timestamp', 'email', 'q:name', 'q:osis', 'q:shirt', 'q:diet', 'q:bus', 'q:age', 'q:day', 'skip']);
    expect(targetProblems(targets)).toEqual([]);
  });

  it('gives each target to one column, and says when no column is a question', () => {
    expect(guessTargets(['Name', 'Student name', 'First name', 'Last name'], [])).toEqual([
      'name',
      'skip',
      'first_name',
      'last_name',
    ]);
    expect(targetProblems(['timestamp', 'email'])).toEqual([
      'No column is set to a question yet. Choose which question each column answers.',
    ]);
    expect(targetProblems(['q:a', 'q:a'])).toContain('Two columns are set to the same thing. Leave one out.');
  });
});

describe('cells', () => {
  it('splits checkboxes even when a choice has a comma in it', () => {
    const options = ['Vegetarian', 'Nuts, tree nuts', 'Halal'];
    expect(splitChoices('Vegetarian, Nuts, tree nuts', options)).toEqual(['Vegetarian', 'Nuts, tree nuts']);
    expect(splitChoices('halal', options)).toEqual(['Halal']);
    expect(splitChoices('Vegetarian, Pescatarian', options)).toBeNull();
  });

  it('turns each cell into the answer its question takes, or says why not', () => {
    const [name, , shirt, , bus, age, day, sign] = FIELDS;
    expect(answerFromCell(name, ' Nia ')).toEqual({ value: 'Nia' });
    expect(answerFromCell(shirt, 'm')).toEqual({ value: 'M' });
    expect(answerFromCell(shirt, 'XL').error).toBe('"XL" is not one of the choices for "Shirt size".');
    expect(answerFromCell(bus, 'Yes')).toEqual({ value: true });
    expect(answerFromCell(bus, 'maybe').error).toContain('yes or no');
    expect(answerFromCell(age, '1,200')).toEqual({ value: '1200' });
    expect(answerFromCell(age, 'fifteen').error).toContain('not a number');
    expect(answerFromCell(day, '10/14/2026')).toEqual({ value: '2026-10-14' });
    expect(answerFromCell(day, '2026-02-30').error).toContain('not a date');
    expect(answerFromCell(sign, 'M1 1L2 2')).toEqual({});
    expect(answerFromCell(shirt, '   ')).toEqual({});
    expect(dateCell('Oct 14, 2026')).toBe('2026-10-14');
  });
});

describe('rows', () => {
  it('previews each row: who answered, what lands, and what is refused', () => {
    const sheet = readSheet(SHEET)!;
    const targets = guessTargets(sheet.headers, FIELDS);
    expect(identityOf(sheet.rows[0], targets, FIELDS)).toEqual({
      email: 'nia.example@edison.example',
      external_id: '230000001',
      name: 'Nia Example',
    });

    const now = Date.parse('2026-09-24T12:00:00Z');
    const rows = previewResponses(
      sheet,
      targets,
      FIELDS,
      [{ state: 'match', personId: 'p1', displayName: 'Nia Example' }, { state: 'none', personId: null, displayName: null }],
      now,
    );
    expect(rows.map((row) => row.line)).toEqual([2, 3, 4]);

    expect(rows[0].errors).toEqual([]);
    expect(rows[0].payload).toEqual({
      submitted_at: '2026-09-23T18:05:00.000Z',
      email: 'nia.example@edison.example',
      external_id: '230000001',
      name: 'Nia Example',
      answers: {
        name: 'Nia Example',
        osis: '230000001',
        shirt: 'M',
        diet: ['Vegetarian', 'Nuts, tree nuts'],
        bus: true,
        age: '15',
        day: '2026-10-14',
      },
    });

    expect(rows[1].payload).toBeNull();
    expect(rows[1].errors).toEqual([
      '"XL" is not one of the choices for "Shirt size".',
      '"fifteen" is not a number for "Age".',
      '"2026-02-30" is not a date for "Which day".',
    ]);

    // No time and nobody named: it still lands, unmatched, and says both.
    expect(rows[2].payload?.submitted_at).toBeNull();
    expect(rows[2].payload?.answers).toEqual({ shirt: 'S', age: '1200' });
    expect(rows[2].notes).toEqual([
      'No email, OSIS or name to match. It comes in unmatched.',
      'No time sent, so it takes the time of the import.',
    ]);
  });

  it('refuses a time in the future and a row that answers nothing', () => {
    const sheet = readSheet('Timestamp\tShirt size\n1/1/2099 09:00\tM\n9/1/2026 09:00\t')!;
    const rows = previewResponses(sheet, ['timestamp', 'q:shirt'], FIELDS, [], Date.parse('2026-09-24T12:00:00Z'));
    expect(rows[0].errors).toEqual(['The time it was sent is in the future.']);
    expect(rows[1].errors).toEqual(['Nothing in this row answers a question.']);
  });

  it('counts the result the way the dialog and the assistant say it', () => {
    expect(
      responseImportSummary([
        { line: 2, outcome: 'made', message: null },
        { line: 3, outcome: 'updated', message: null },
        { line: 4, outcome: 'skipped', message: 'Already imported.' },
        { line: 5, outcome: 'refused', message: 'Answer "Shirt size".' },
      ]),
    ).toBe('Imported 2 responses. 1 replaced an older answer. Skipped 1 already here. Refused 1.');
    expect(responseImportSummary([{ line: 2, outcome: 'skipped', message: null }])).toBe(
      'Imported nothing new. Skipped 1 already here.',
    );
  });
});
