import { describe, expect, it } from 'vitest';
import {
  answerErrors,
  answerText,
  blankField,
  choiceCounts,
  fieldsFromJson,
  FORM_TEMPLATES,
  initialAnswers,
  moveField,
  respondentName,
  responseTable,
  samplePrefill,
  strokesToPath,
  templateFields,
  toTsv,
  usedDirectoryKeys,
  type FormField,
  type FormResponseRow,
} from '../src/lib/domain/forms';

const FIELDS: FormField[] = [
  { id: 'name', type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
  { id: 'phone', type: 'directory', directory: 'guardian_phone', label: 'Guardian phone', help: '', required: true },
  { id: 'shirt', type: 'single_choice', label: 'Shirt', help: '', required: true, options: ['S', 'M', 'L'] },
  { id: 'diet', type: 'multi_choice', label: 'Diet', help: '', required: false, options: ['Vegan', 'Halal'] },
  { id: 'ok', type: 'yes_no', label: 'Coming?', help: '', required: false },
  { id: 'sign', type: 'signature', label: 'Signature', help: '', required: false },
  { id: 'n', type: 'number', label: 'Siblings', help: '', required: false },
  { id: 'd', type: 'date', label: 'Arriving', help: '', required: false },
];

function row(overrides: Partial<FormResponseRow> = {}): FormResponseRow {
  return {
    id: 'r1',
    requesterId: 'p1',
    displayName: 'Jordan Rivera',
    externalId: '241000123',
    answers: {},
    changed: [],
    via: 'link',
    submittedAt: '2026-09-23T14:00:00.000Z',
    recordedByName: null,
    ...overrides,
  };
}

describe('reading stored questions', () => {
  it('drops anything it cannot read and keeps the rest in order', () => {
    const fields = fieldsFromJson([
      { id: 'a', type: 'short_text', label: 'A', required: true },
      { id: 'b', type: 'essay', label: 'Unknown' },
      { id: 'c', type: 'directory', directory: 'shoe_size', label: 'Bad' },
      { id: 'd', type: 'dropdown', label: 'D', options: ['x', 3, 'y'] },
      'nonsense',
    ]);
    expect(fields.map((field) => field.id)).toEqual(['a', 'd']);
    expect(fields[1].options).toEqual(['x', 'y']);
  });

  it('gives a new choice question two choices and a directory question its label', () => {
    expect(blankField('dropdown', []).options).toEqual(['Option 1', 'Option 2']);
    const phone = blankField('directory', [], 'guardian_phone');
    expect(phone.label).toBe('Guardian phone');
    expect(phone.required).toBe(true);
    expect(phone.id).toMatch(/^[a-z0-9]{4,16}$/);
  });

  it('builds every template with unique, valid ids', () => {
    for (const template of FORM_TEMPLATES) {
      const ids = templateFields(template).map((field) => field.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9]{1,16}$/);
    }
  });

  it('knows which directory facts a form already asks for', () => {
    expect([...usedDirectoryKeys(FIELDS)].sort()).toEqual(['full_name', 'guardian_phone']);
  });

  it('moves a question without losing any', () => {
    expect(moveField(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveField(['a', 'b', 'c'], 2, 5)).toEqual(['a', 'b', 'c']);
  });
});

describe('answers', () => {
  it('starts directory questions on "keep" and nothing else', () => {
    expect(initialAnswers(FIELDS, { name: 'Jordan' }, { phone: '••• ••• 0142' })).toEqual({
      name: { keep: true },
      phone: { keep: true },
    });
  });

  it('says which required questions are unanswered and which answers do not fit', () => {
    const errors = answerErrors(FIELDS, {
      name: { keep: true },
      phone: '',
      n: 'three',
      d: '2026-02-30',
    });
    expect(Object.keys(errors).sort()).toEqual(['d', 'n', 'phone', 'shirt']);
    expect(answerErrors(FIELDS, { name: { keep: true }, phone: { keep: true }, shirt: 'M' })).toEqual({});
  });

  it('reads a stored answer as one line of text, and a signature as a word', () => {
    expect(answerText(FIELDS[3], ['Vegan', 'Halal'])).toBe('Vegan, Halal');
    expect(answerText(FIELDS[4], true)).toBe('Yes');
    expect(answerText(FIELDS[5], 'M1 2L3 4')).toBe('Signed');
    expect(answerText(FIELDS[0], null)).toBe('');
  });

  it('counts choices in the order the form lists them', () => {
    const rows = [
      row({ answers: { shirt: 'M', ok: true } }),
      row({ id: 'r2', answers: { shirt: 'M', ok: false } }),
      row({ id: 'r3', answers: { shirt: 'L' } }),
    ];
    expect(choiceCounts(FIELDS[2], rows)).toEqual([
      { option: 'S', count: 0 },
      { option: 'M', count: 2 },
      { option: 'L', count: 1 },
    ]);
    expect(choiceCounts(FIELDS[4], rows)).toEqual([
      { option: 'Yes', count: 1 },
      { option: 'No', count: 1 },
    ]);
  });
});

describe('responses as a table', () => {
  it('names an unmatched respondent by the name they typed', () => {
    expect(respondentName(row({ displayName: null, requesterId: null, answers: { name: 'A Visitor' } }), FIELDS)).toBe(
      'A Visitor',
    );
    expect(respondentName(row({ displayName: null, requesterId: null }), FIELDS)).toBe('Not matched');
  });

  it('lays out one column per question and pastes as a table', () => {
    const table = responseTable(
      FIELDS,
      [row({ answers: { name: 'Jordan Rivera', shirt: 'M', diet: ['Vegan'] }, via: 'kiosk', recordedByName: 'Nia' })],
      () => 'Sep 23',
    );
    expect(table[0]).toEqual([
      'Submitted',
      'Respondent',
      'OSIS or staff ID',
      'Full name',
      'Guardian phone',
      'Shirt',
      'Diet',
      'Coming?',
      'Signature',
      'Siblings',
      'Arriving',
      'Taken at',
    ]);
    expect(table[1].at(-1)).toBe('Kiosk (Nia)');

    const tsv = toTsv([
      ['Name', 'Note'],
      ['Jordan', 'line one\nline\ttwo'],
      ['=HYPERLINK("x")', '+1'],
    ]);
    expect(tsv.split('\n')).toEqual(['Name\tNote', 'Jordan\tline one line two', `'=HYPERLINK("x")\t'+1`]);
  });
});

describe('signatures', () => {
  it('stores strokes as a compact path inside the pad', () => {
    const path = strokesToPath([
      [
        { x: 10.4, y: 20.6 },
        { x: 10.4, y: 20.6 },
        { x: 700, y: -5 },
      ],
      [{ x: 5, y: 5 }],
    ]);
    expect(path).toBe('M10 21L600 0M5 5L6 5');
    expect(path).toMatch(/^[ML0-9 .-]+$/);
  });
});

describe('the preview', () => {
  it('fills an invented person in and masks the phone', () => {
    const sample = samplePrefill(FIELDS);
    expect(sample.prefill).toEqual({ name: 'Jordan Rivera' });
    expect(sample.masked.phone).toMatch(/^••• ••• \d{4}$/);
  });
});
