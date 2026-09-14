import { describe, expect, it } from 'vitest';
import {
  buildImportPlan,
  countDataRows,
  describeActionFailure,
  describeDetection,
  fieldsFor,
  findParseErrors,
  holderLabel,
  mergeProblems,
  prefillMapping,
  presetLabel,
  problemRowsCsv,
  remapRunRows,
  resolvePreset,
  summariseImport,
  type ImportRunResult,
} from '../src/lib/data/import-plan';
import { PRESETS, parseCsv } from '../src/lib/import/index';
import type { ColumnPreset } from '../src/lib/import/index';

const students = PRESETS.find((preset) => preset.id === 'appsheet_students') as ColumnPreset;
const inventory = PRESETS.find((preset) => preset.id === 'appsheet_inventory') as ColumnPreset;

const STUDENT_CSV = [
  'Student ID:,Name,studentEmail,Class of,officalClass,Parent,parentNumber,studentAddress,Notes',
  '"240,000,123",Pat Example,PAT@Edison.Example,2027,9A1,Robin Example,(212) 555-0100,"12 Sample Road, Apt 4",Cart 3',
  '240000124,River Sample,river@edison.example,2028,10B2,Sam Sample,2125550101,,',
  'not-an-osis,Quinn Placeholder,quinn@edison.example,2029,11C3,,,,',
  ',,,,,,,,',
].join('\n');

const INVENTORY_CSV = [
  'DeviceID,SerialNumber,AssetTag,Type,Manufacturer,Model,OS,Status,Location,Notes,Assigned To,OSIS,StaffID,Student Name,Staff Name',
  'ab12cd34-win,,ED-0001,Laptop,Dell,Latitude 3440,,Deployed,Room 214,,Student,240000123,,Pat Example,',
  ',,,,,,,,,,,,,,',
  'ef56gh78-cros,,ED-0002,Chromebook,HP,Fortis G10,,In Stock,Cart 3,,,,,,',
].join('\n');

function runResult(over: Partial<ImportRunResult> = {}): ImportRunResult {
  return {
    run_id: null,
    kind: 'people',
    mode: 'dry_run',
    total: 0,
    inserts: 0,
    updates: 0,
    unchanged: 0,
    errors: [],
    unmatched_holders: [],
    assignments_created: 0,
    ...over,
  };
}

describe('resolvePreset', () => {
  it('starts from the named preset when no mapping was adjusted', () => {
    const preset = resolvePreset({ kind: 'people', presetId: 'appsheet_students' });
    expect(preset.map).toEqual(students.map);
    expect(preset.fixed).toEqual({ kind: 'student' });
  });

  it('replaces the preset wholly rather than merging, so a cleared column stays cleared', () => {
    const preset = resolvePreset({
      kind: 'people',
      presetId: 'appsheet_students',
      customMap: { display_name: 'Full name' },
    });
    expect(preset.map).toEqual({ display_name: 'Full name' });
    expect(preset.map.osis).toBeUndefined();
  });

  it('drops a target field the database does not keep and an empty column choice', () => {
    const preset = resolvePreset({
      kind: 'people',
      presetId: 'appsheet_students',
      customMap: { display_name: 'Name', active: 'Archived', email: '   ' },
    });
    expect(preset.map).toEqual({ display_name: 'Name' });
  });

  it('never lets an import decide a person is archived', () => {
    expect(fieldsFor('people')).not.toContain('active');
    // `kind` is the operator's choice for a file, not a column in it.
    expect(fieldsFor('people')).not.toContain('kind');
  });

  it('takes the people kind from the operator over the preset', () => {
    const preset = resolvePreset({
      kind: 'people',
      presetId: 'appsheet_students',
      personKind: 'staff',
    });
    expect(preset.fixed).toEqual({ kind: 'staff' });
  });

  it('fixes nothing for a device file', () => {
    expect(resolvePreset({ kind: 'devices', presetId: 'appsheet_inventory' }).fixed).toBeUndefined();
  });
});

describe('prefillMapping', () => {
  it('points each field at the file’s own spelling of the header', () => {
    const map = prefillMapping(['student id', 'NAME', 'officalClass'], students);
    expect(map.osis).toBe('student id');
    expect(map.display_name).toBe('NAME');
    expect(map.official_class).toBe('officalClass');
  });

  it('leaves out a field the file has no column for', () => {
    const map = prefillMapping(['Name'], students);
    expect(map.osis).toBeUndefined();
    expect(map.display_name).toBe('Name');
  });
});

describe('buildImportPlan', () => {
  it('maps a student export into rows, and reports the rows it cannot save', () => {
    const plan = buildImportPlan(STUDENT_CSV, { kind: 'people', presetId: 'appsheet_students' });

    expect(plan.detectedPresetId).toBe('appsheet_students');
    // The blank line in the middle is not a row anybody typed.
    expect(plan.rowCount).toBe(3);
    expect(plan.parseErrors).toEqual([]);
    expect(plan.rows).toHaveLength(2);

    const first = plan.rows[0] as Record<string, unknown>;
    expect(first.kind).toBe('student');
    expect(first.osis).toBe('240000123');
    expect(first.email).toBe('pat@edison.example');
    expect(first.parent_phone).toBe('2125550100');
    expect(first.display_name).toBe('Pat Example');
    expect(first.last_name).toBe('Example');
    expect('active' in first).toBe(false);

    expect(plan.normalisedErrors).toHaveLength(1);
    expect(plan.normalisedErrors[0].row).toBe(3);
    expect(plan.normalisedErrors[0].message).toContain('6 to 12 digits');
  });

  it('reads a device export without inventing a type or a status', () => {
    const plan = buildImportPlan(INVENTORY_CSV, { kind: 'devices', presetId: 'appsheet_inventory' });

    expect(plan.detectedPresetId).toBe('appsheet_inventory');
    expect(plan.rowCount).toBe(2);
    expect(plan.rows).toHaveLength(2);

    const laptop = plan.rows[0] as Record<string, unknown>;
    expect(laptop.serial_number).toBe('AB12CD34');
    expect(laptop.os).toBe('WIN');
    expect(laptop.status).toBe('deployed');
    expect(laptop.holder).toEqual({
      kind: 'student',
      osis: '240000123',
      staff_id: null,
      name: 'Pat Example',
    });

    const chromebook = plan.rows[1] as Record<string, unknown>;
    expect(chromebook.holder).toBeNull();
  });

  it('honours a mapping the operator re-pointed by hand', () => {
    const csv = 'Ident,Full name\n240000125,Alex Placeholder\n';
    const plan = buildImportPlan(csv, {
      kind: 'people',
      presetId: 'appsheet_students',
      customMap: { osis: 'Ident', display_name: 'Full name' },
      personKind: 'staff',
    });
    expect(plan.detectedPresetId).toBeNull();
    expect(plan.rows).toEqual([
      expect.objectContaining({ kind: 'staff', osis: '240000125', display_name: 'Alex Placeholder' }),
    ]);
  });
});

describe('findParseErrors', () => {
  it('says nothing about a well-formed file', () => {
    expect(findParseErrors(parseCsv('A,B\n1,2\n'))).toEqual([]);
  });

  it('flags a row with more values than the file has columns', () => {
    const errors = findParseErrors(parseCsv('A,B\n1,2,3\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(1);
    expect(errors[0].message).toContain('quotation marks');
  });

  it('treats an empty file as one problem with the file rather than a row', () => {
    const errors = findParseErrors(parseCsv(''));
    expect(errors).toEqual([{ row: 0, message: expect.stringContaining('empty') }]);
  });

  it('does not count a blank line in the middle as a row', () => {
    expect(countDataRows(parseCsv('A,B\n1,2\n\n3,4\n'))).toBe(2);
  });
});

describe('summariseImport', () => {
  it('writes the four chips, with thousands separated and no middle dots', () => {
    const summary = summariseImport(
      runResult({ inserts: 312, updates: 40, unchanged: 1207 }),
      1562,
      3,
    );
    expect(summary.chips.map((chip) => chip.label)).toEqual([
      '312 new',
      '40 changed',
      '1,207 unchanged',
      '3 problems',
    ]);
    expect(summary.chips.some((chip) => chip.label.includes('·'))).toBe(false);
  });

  it('adds the chips up to the rows in the file, not to the rows the RPC saw', () => {
    const summary = summariseImport(runResult({ inserts: 2, updates: 1, unchanged: 4 }), 10, 3);
    expect(summary.inserts + summary.updates + summary.unchanged + summary.problems).toBe(
      summary.total,
    );
  });

  it('counts one problem in the singular', () => {
    const summary = summariseImport(runResult(), 1, 1);
    expect(summary.chips[3].label).toBe('1 problem');
    expect(summary.chips[3].tone).toBe('problem');
  });

  it('keeps the problem chip quiet when there are none', () => {
    expect(summariseImport(runResult(), 0, 0).chips[3].tone).toBe('plain');
  });

  it('puts the rows a commit would write on the button', () => {
    const summary = summariseImport(runResult({ inserts: 312, updates: 40, unchanged: 1207 }), 1562, 3);
    expect(summary.changing).toBe(352);
  });
});

describe('mergeProblems', () => {
  it('gathers the three stages into one list ordered by row', () => {
    const merged = mergeProblems(
      [{ row: 9, message: 'Too many values.' }],
      [{ row: 2, message: 'No name.' }],
      [{ row: 5, message: 'This row could not be saved.', detail: 'duplicate key' }],
    );
    expect(merged.map((problem) => problem.row)).toEqual([2, 5, 9]);
    expect(merged[1].detail).toBe('duplicate key');
  });
});

describe('problemRowsCsv', () => {
  it('quotes the file’s own cells back, with the row number and the problem appended', () => {
    const csv = parseCsv(STUDENT_CSV);
    const file = problemRowsCsv(csv, [{ row: 3, message: 'An OSIS number is 6 to 12 digits.' }]);
    const lines = file.trimEnd().split('\r\n');

    expect(lines[0].endsWith('Notes,Import row,Problem')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Quinn Placeholder');
    expect(lines[1]).toContain('not-an-osis');
    expect(lines[1].endsWith('3,An OSIS number is 6 to 12 digits.')).toBe(true);
    // The file it produces is still a file the reader can read.
    expect(parseCsv(file).rows[0]).toHaveLength(csv.headers.length + 2);
  });

  it('gathers every problem on one row into that row’s line', () => {
    const csv = parseCsv('A,B\n1,2\n');
    const file = problemRowsCsv(csv, [
      { row: 1, message: 'First.' },
      { row: 1, message: 'Second.', detail: 'from the database' },
    ]);
    expect(parseCsv(file).rows).toHaveLength(1);
    expect(file).toContain('First. Second. (from the database)');
  });
});

describe('labels', () => {
  it('names the preset a file was recognised as', () => {
    const detection = describeDetection(parseCsv(STUDENT_CSV).headers);
    expect(detection?.id).toBe('appsheet_students');
    expect(detection?.sentence).toBe('Looks like the AppSheet student directory export.');
  });

  it('recognises the inventory tab', () => {
    expect(describeDetection(parseCsv(INVENTORY_CSV).headers)?.id).toBe(inventory.id);
  });

  it('recognises nothing in a file it has never seen', () => {
    expect(describeDetection(['Alpha', 'Beta'])).toBeNull();
    expect(presetLabel(null)).toBe('Custom mapping');
  });

  it('says who a device was meant for without a middle dot', () => {
    expect(holderLabel({ kind: 'student', osis: '240000123', staff_id: null, name: 'Pat Example' }))
      .toBe('Pat Example, OSIS 240000123');
    expect(holderLabel({ kind: 'staff', osis: null, staff_id: null, name: null })).toBe(
      'A member of staff',
    );
  });
});

/*
 * Row numbers.
 *
 * `app_admin_import` reports a problem by the position of the row in the array
 * it was handed, and that array is the file with its blank lines, its malformed
 * lines and its unsavable lines taken out. Every number that reaches an
 * operator has to be a row of the spreadsheet instead.
 */

// Row 2 is blank, row 3 cannot be saved, row 4 has slid sideways, so only rows
// 1 and 5 are sent — and the RPC will call them 1 and 2.
const RAGGED_CSV = [
  'Student ID:,Name,Notes',
  '240000201,Ada Fixture,Cart 1',
  ',,',
  'not-an-osis,Cleo Fixture,',
  '240000204,"Dara Fixture",slid,sideways',
  '240000205,Esme Fixture,Cart 2',
].join('\n');

describe('source rows', () => {
  it('records the file row each sent row came from', () => {
    const plan = buildImportPlan(RAGGED_CSV, { kind: 'people', presetId: 'appsheet_students' });

    expect(plan.rowCount).toBe(4);
    expect(plan.parseErrors.map((error) => error.row)).toEqual([4]);
    expect(plan.normalisedErrors.map((error) => error.row)).toEqual([3]);
    // Row 4 is left out even though it normalised: its fields have slid.
    expect(plan.rows).toHaveLength(2);
    expect(plan.sourceRows).toEqual([1, 5]);
    expect((plan.rows[1] as Record<string, unknown>).display_name).toBe('Esme Fixture');
  });

  it('turns the RPC\u2019s positions back into rows of the file', () => {
    const plan = buildImportPlan(RAGGED_CSV, { kind: 'people', presetId: 'appsheet_students' });
    const remapped = remapRunRows(
      runResult({
        errors: [{ row: 2, message: 'This row could not be saved.', detail: 'duplicate key' }],
        unmatched_holders: [{ row: 1, holder: { kind: 'student', name: 'Ada Fixture' } }],
      }),
      plan.sourceRows,
    );

    expect(remapped.errors[0].row).toBe(5);
    expect(remapped.errors[0].detail).toBe('duplicate key');
    expect(remapped.unmatched_holders[0].row).toBe(1);
  });

  it('leaves a position it cannot place alone rather than guessing', () => {
    expect(remapRunRows(runResult({ errors: [{ row: 9, message: 'x' }] }), [1, 5]).errors[0].row)
      .toBe(9);
  });

  it('quotes the right line back in the problem rows file', () => {
    const plan = buildImportPlan(RAGGED_CSV, { kind: 'people', presetId: 'appsheet_students' });
    const problems = mergeProblems(plan.parseErrors, plan.normalisedErrors, [
      { row: 5, message: 'This row could not be saved.' },
    ]);
    const file = problemRowsCsv(plan.csv, problems);

    expect(problems.map((problem) => problem.row)).toEqual([3, 4, 5]);
    expect(file).toContain('Cleo Fixture');
    expect(file).toContain('Esme Fixture');
    expect(file).not.toContain('Ada Fixture');
  });
});

describe('the chips add up', () => {
  it('counts a row that failed twice as one row that did not land', () => {
    // Malformed AND unsavable: one line of the spreadsheet, two sentences.
    const csv = ['Student ID:,Name', 'not-an-osis,Fern Fixture,slid', '240000301,Gale Fixture'].join(
      '\n',
    );
    const plan = buildImportPlan(csv, { kind: 'people', presetId: 'appsheet_students' });
    const problems = mergeProblems(plan.parseErrors, plan.normalisedErrors, []);

    expect(plan.parseErrors.map((error) => error.row)).toEqual([1]);
    expect(plan.normalisedErrors.map((error) => error.row)).toEqual([1]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('quotation marks');
    expect(problems[0].message).toContain('6 to 12 digits');

    // One row sent, one row a problem, two rows in the file.
    const summary = summariseImport(
      runResult({ inserts: plan.rows.length }),
      plan.rowCount,
      problems.length,
    );
    expect(summary.inserts + summary.updates + summary.unchanged + summary.problems).toBe(
      summary.total,
    );
  });
});

describe('describeActionFailure', () => {
  it('names the request being refused for its size', () => {
    expect(describeActionFailure(new Error('Body exceeded 5mb limit'))).toContain('5 MB limit');
    expect(describeActionFailure(new Error('Request failed with status 413'))).toContain(
      '5 MB limit',
    );
  });

  it('falls back to something an operator can act on', () => {
    expect(describeActionFailure(new Error('fetch failed'))).toContain('Check your connection');
  });
});
