/**
 * Reading the desk's sheet: cells, columns, dates, and what each row becomes.
 *
 * Everything the import dialog decides before the database is asked. The
 * database decides again (tests/db/m5-ticket-opened-at.test.ts); what is
 * pinned here is that a sheet copied out of Google Sheets or saved as a CSV
 * arrives as the cells somebody typed, that the columns are guessed the way a
 * person would guess them, and that every row either lands as something
 * exact or says why it will not.
 */

import { describe, expect, it } from 'vitest';
import {
  autoMap,
  categoryOf,
  detectDelimiter,
  guessField,
  importSummary,
  mappingProblems,
  parseDelimited,
  parseSheetMoment,
  previewRows,
  priorityOf,
  readSheet,
  requesterKeys,
  titleFromIssue,
  type PreviewContext,
} from '../src/lib/domain/ticket-import';
import { schoolDayStart } from '../src/lib/format';
import { momentForSubmit, momentFromParts, momentLabel, momentParts, momentProblem } from '../src/lib/domain/ticket-moments';

describe('cells', () => {
  it('reads tab-separated rows the way Google Sheets copies them', () => {
    const text = 'Title\tOpened\nProjector in 118\t9/12/2025\nCart 3 charger\t9/13/2025\n';
    expect(detectDelimiter(text)).toBe('\t');
    const sheet = readSheet(text);
    expect(sheet?.headers).toEqual(['Title', 'Opened']);
    expect(sheet?.rows).toEqual([
      ['Projector in 118', '9/12/2025'],
      ['Cart 3 charger', '9/13/2025'],
    ]);
  });

  it('keeps a quoted cell whole: its tabs, commas, doubled quotes and line breaks', () => {
    const tsv = 'Title\tNotes\nPrinter\t"Jammed, again.\nSaid ""fixed"" twice"\n';
    expect(parseDelimited(tsv, '\t')).toEqual([
      ['Title', 'Notes'],
      ['Printer', 'Jammed, again.\nSaid "fixed" twice'],
    ]);
    const csv = 'Title,Notes\r\n"Wi-Fi, room 204","Dropped"\r\n';
    expect(detectDelimiter(csv)).toBe(',');
    expect(parseDelimited(csv, ',')).toEqual([
      ['Title', 'Notes'],
      ['Wi-Fi, room 204', 'Dropped'],
    ]);
  });

  it('reads a semicolon CSV, drops empty rows, strips a byte-order mark and pads short rows', () => {
    const text = '﻿Title;Room;Opened\nProjector;118\n;;\n\nSmartboard;204;2025-09-12\n';
    expect(detectDelimiter(text)).toBe(';');
    const sheet = readSheet(text);
    expect(sheet?.headers).toEqual(['Title', 'Room', 'Opened']);
    expect(sheet?.rows).toEqual([
      ['Projector', '118', ''],
      ['Smartboard', '204', '2025-09-12'],
    ]);
  });

  it('names a blank heading, and a cell past the last heading, by position', () => {
    const sheet = readSheet('Title\t\nA\tB\tC\n');
    expect(sheet?.headers).toEqual(['Title', 'Column 2', 'Column 3']);
    expect(sheet?.rows[0]).toEqual(['A', 'B', 'C']);
  });

  it('has nothing to say about an empty box', () => {
    expect(readSheet('')).toBeNull();
    expect(readSheet('  \n\t\n')).toBeNull();
  });
});

describe('columns', () => {
  it('guesses each heading the way a person reads it', () => {
    const cases: Array<[string, string]> = [
      ['Title', 'title'],
      ['Summary', 'title'],
      ['Problem', 'issue'],
      ['Description', 'issue'],
      ['Requester', 'requester'],
      ['Reported by', 'requester'],
      ['Student OSIS', 'requester'],
      ['Email', 'requester'],
      ['Room', 'location'],
      ['Category', 'category'],
      ['Device type', 'category'],
      ['Priority', 'priority'],
      ['Date', 'opened'],
      ['Date opened', 'opened'],
      ['Called in', 'opened'],
      ['Resolved', 'resolved'],
      ['Date resolved', 'resolved'],
      ['Resolution date', 'resolved'],
      ['Closed', 'resolved'],
      ['Solution', 'solution'],
      ['Resolution', 'solution'],
      ['How fixed', 'solution'],
      ['Resolved by', 'resolvedBy'],
      ['Fixed by', 'resolvedBy'],
      ['Technician', 'resolvedBy'],
      ['Asset tag', 'skip'],
    ];
    for (const [header, field] of cases) {
      expect([header, guessField(header)]).toEqual([header, field]);
    }
  });

  it('gives each field to one column and leaves the second out', () => {
    expect(autoMap(['Date', 'Problem', 'Notes', 'Resolved', 'Fixed by'])).toEqual([
      'opened',
      'issue',
      'skip',
      'resolved',
      'resolvedBy',
    ]);
  });

  it('says what stops the import as a whole', () => {
    expect(mappingProblems(['issue', 'opened'])).toEqual([]);
    expect(mappingProblems(['requester', 'opened'])).toEqual([
      'Choose which column is the title or the issue.',
    ]);
    expect(mappingProblems(['title', 'skip'])).toEqual([
      'Choose which column holds the date it was opened or resolved.',
    ]);
    expect(mappingProblems(['title', 'opened', 'opened'])[0]).toContain('Two columns are set to Opened');
  });
});

describe('values', () => {
  it('reads a plain day as the start of that school day, like the assistant import', () => {
    expect(parseSheetMoment('2025-09-12')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('9/12/2025')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('9/12/25')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('Sep 12, 2025')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('12 September 2025')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('Friday, September 12, 2025')).toBe(schoolDayStart('2025-09-12'));
    expect(parseSheetMoment('2025/09/12')).toBe(schoolDayStart('2025-09-12'));
  });

  it('reads a time as school time, in either clock', () => {
    // 2:30 pm in New York in September is 18:30Z; in December it is 19:30Z.
    expect(parseSheetMoment('9/12/2025 14:30:00')).toBe('2025-09-12T18:30:00.000Z');
    expect(parseSheetMoment('9/12/2025 2:30 PM')).toBe('2025-09-12T18:30:00.000Z');
    expect(parseSheetMoment('Dec 3, 2025 at 9:05 am')).toBe('2025-12-03T14:05:00.000Z');
    expect(parseSheetMoment('2025-12-03 12:00 AM')).toBe('2025-12-03T05:00:00.000Z');
    expect(parseSheetMoment('2025-09-12T10:00:00Z')).toBe('2025-09-12T10:00:00.000Z');
  });

  it('refuses what is not a date rather than guessing', () => {
    for (const text of ['next tuesday', '13/45/2025', '2025-02-30', 'Yes', '9/12', '9/12/2025 25:00', 'Smarch 3, 2025']) {
      expect([text, parseSheetMoment(text)]).toEqual([text, null]);
    }
  });

  it('files categories and priorities from the words sheets use', () => {
    expect(categoryOf('Projector or display')).toEqual({ value: 'projector_display', known: true });
    expect(categoryOf('SmartBoard')).toEqual({ value: 'projector_display', known: true });
    expect(categoryOf('wifi')).toEqual({ value: 'network', known: true });
    expect(categoryOf('Password reset')).toEqual({ value: 'account', known: true });
    expect(categoryOf('Furniture')).toEqual({ value: 'other', known: false });
    expect(priorityOf('Urgent')).toEqual({ value: 'urgent', known: true });
    expect(priorityOf('medium')).toEqual({ value: 'normal', known: true });
    expect(priorityOf('whenever')).toEqual({ value: 'normal', known: false });
  });

  it('cuts a title from the issue at a word, on its first line', () => {
    expect(titleFromIssue('Projector will not wake\nTried the remote.')).toBe('Projector will not wake');
    const long = 'The podium laptop in room 118 shows no signal on the projector after the summer reimage of every machine';
    const title = titleFromIssue(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(title)).toBe(true);
    expect(long[title.length]).toBe(' ');
  });
});

describe('rows', () => {
  const NOW = Date.parse('2026-09-23T16:00:00Z');
  const context = (overrides: Partial<PreviewContext> = {}): PreviewContext => ({
    nowMs: NOW,
    actorId: 'me',
    isAdmin: false,
    people: new Map([
      ['nia okonkwo', { found: 'match', matches: 1, id: 'person-1', displayName: 'Nia Okonkwo' }],
      ['sam lee', { found: 'ambiguous', matches: 2, id: null, displayName: null }],
      ['nobody', { found: 'none', matches: 0, id: null, displayName: null }],
    ]),
    resolvers: [
      { id: 'me', displayName: 'Dev Patel' },
      { id: 'colleague', displayName: 'Rosa Martinez' },
    ],
    ...overrides,
  });

  const sheet = readSheet(
    [
      'Problem\tWho\tOpened\tResolved\tFixed by\tSolution\tCategory\tPriority',
      'Projector in 118 will not wake\tNia Okonkwo\t9/12/2025 9:05 AM\t9/12/2025 10:15 AM\tDev\tReseated HDMI\tProjector\tHigh',
      'Cart 3 charger missing\tSam Lee\t9/15/2025\t\tRosa Martinez\t\tFurniture\twhenever',
      'Printer jam\tnobody\t9/20/2025\t9/18/2025\t\t\t\t',
      'Wi-Fi drops\t\t1/5/2019\t1/6/2019\t\t\t\t',
      'x\t\tlater\t\t\t\t\t',
      'Future\t\t10/1/2026\t10/2/2026\t\t\t\t',
    ].join('\n'),
  )!;
  const mapping = autoMap(sheet.headers);

  it('maps the sample sheet as expected', () => {
    expect(mapping).toEqual(['issue', 'requester', 'opened', 'resolved', 'resolvedBy', 'solution', 'category', 'priority']);
    expect(requesterKeys(sheet, mapping)).toEqual(['Nia Okonkwo', 'Sam Lee', 'nobody']);
  });

  it('turns a good row into exactly what the database takes', () => {
    const [first] = previewRows(sheet, mapping, context());
    expect(first.line).toBe(2);
    expect(first.errors).toEqual([]);
    expect(first.notes).toEqual([]);
    expect(first.requester).toEqual({ key: 'Nia Okonkwo', state: 'match', label: 'Nia Okonkwo' });
    expect(first.payload).toEqual({
      title: 'Projector in 118 will not wake',
      issue: 'Projector in 118 will not wake',
      opened_at: '2025-09-12T13:05:00.000Z',
      resolved_at: '2025-09-12T14:15:00.000Z',
      // "Dev" is the importer's own first name: their own work, sent as nobody.
      resolved_by: null,
      resolved_by_name: null,
      requester_id: 'person-1',
      location: null,
      category: 'projector_display',
      priority: 'high',
      solution: 'Reseated HDMI',
    });
  });

  it('lands a row with notes, and says what it assumed', () => {
    const second = previewRows(sheet, mapping, context())[1];
    expect(second.errors).toEqual([]);
    expect(second.payload?.resolved_at).toBe(second.payload?.opened_at);
    expect(second.payload?.requester_id).toBeNull();
    expect(second.payload?.category).toBe('other');
    expect(second.payload?.priority).toBe('normal');
    // A NetRider cannot credit a colleague; the name goes into the history.
    expect(second.payload?.resolved_by).toBeNull();
    expect(second.payload?.resolved_by_name).toBe('Rosa Martinez');
    expect(second.notes.join(' ')).toContain('No resolved date');
    expect(second.notes.join(' ')).toContain('2 people match');
    expect(second.notes.join(' ')).toContain('Only an administrator can credit Rosa Martinez');
    expect(second.notes.join(' ')).toContain('filed as Other');
    expect(second.notes.join(' ')).toContain('filed as Normal');
  });

  it('lets an administrator credit the colleague by account', () => {
    const second = previewRows(sheet, mapping, context({ isAdmin: true }))[1];
    expect(second.payload?.resolved_by).toBe('colleague');
    expect(second.payload?.resolved_by_name).toBeNull();
  });

  it('refuses a row out of order, before 2020, unreadable or in the future', () => {
    const rows = previewRows(sheet, mapping, context());
    expect(rows[2].payload).toBeNull();
    expect(rows[2].errors).toContain('Resolved before it was opened. Check which date column is which.');
    expect(rows[2].requester.state).toBe('unmatched');

    expect(rows[3].errors).toContain('The opened date cannot be before 2020.');

    expect(rows[4].errors).toContain('Needs a title of at least three characters.');
    expect(rows[4].errors).toContain('“later” is not a date the helpdesk can read.');

    expect(rows[5].errors).toContain('The opened date cannot be in the future.');
  });

  it('waits for the directory before naming a requester', () => {
    const [first] = previewRows(sheet, mapping, context({ people: new Map() }));
    expect(first.requester.state).toBe('pending');
    expect(first.payload?.requester_id).toBeNull();
  });

  it('counts the result the way the dialog says it', () => {
    expect(
      importSummary([
        { line: 2, outcome: 'made', ticketId: 'a', ticketNumber: 'EDT-1', message: null },
        { line: 3, outcome: 'made', ticketId: 'b', ticketNumber: 'EDT-2', message: null },
        { line: 4, outcome: 'skipped', ticketId: 'c', ticketNumber: 'EDT-3', message: null },
        { line: 5, outcome: 'refused', ticketId: null, ticketNumber: null, message: 'No.' },
      ]),
    ).toBe('Made 2 tickets. Skipped 1 already in the helpdesk. Refused 1.');
    expect(
      importSummary([{ line: 2, outcome: 'skipped', ticketId: 'c', ticketNumber: 'EDT-3', message: null }]),
    ).toBe('Made nothing new. Skipped 1 already in the helpdesk.');
  });
});

describe('the opened and resolved moments on intake', () => {
  const NOW = Date.parse('2026-09-23T16:00:00Z');

  it('builds an instant from a school-local date and clock, and reads it back', () => {
    const iso = momentFromParts('2026-09-12', '09:05');
    expect(iso).toBe('2026-09-12T13:05:00.000Z');
    expect(momentParts(iso!)).toEqual({ date: '2026-09-12', time: '09:05' });
    expect(momentFromParts('2026-09-12', '9:5')).toBeNull();
  });

  it('holds the database’s bounds', () => {
    expect(momentProblem('2026-09-23T15:00:00Z', NOW, 'The opened time')).toBeNull();
    expect(momentProblem('2026-09-23T17:00:00Z', NOW, 'The opened time')).toBe('The opened time cannot be in the future.');
    expect(momentProblem('2019-12-31T12:00:00Z', NOW, 'The opened time')).toBe('The opened time cannot be before 2020.');
    expect(
      momentProblem('2026-09-20T12:00:00Z', NOW, 'The resolved time', {
        iso: '2026-09-21T12:00:00Z',
        what: 'it was opened',
      }),
    ).toBe('The resolved time cannot be before it was opened.');
  });

  it('sends nothing for now, or for a moment within a minute of it', () => {
    expect(momentForSubmit(null, NOW)).toBeNull();
    expect(momentForSubmit(new Date(NOW - 30_000).toISOString(), NOW)).toBeNull();
    expect(momentForSubmit('2026-09-22T12:00:00.000Z', NOW)).toBe('2026-09-22T12:00:00.000Z');
  });

  it('labels the quiet control', () => {
    expect(momentLabel(null, NOW)).toBe('Now');
    expect(momentLabel('2026-09-23T13:05:00Z', NOW)).toBe('Today, 9:05 AM');
    expect(momentLabel('2026-09-22T20:10:00Z', NOW)).toBe('Yesterday, 4:10 PM');
    expect(momentLabel('2026-09-12T13:05:00Z', NOW)).toBe('Sep 12, 9:05 AM');
    expect(momentLabel('2025-03-02T14:05:00Z', NOW)).toBe('Mar 2, 2025, 9:05 AM');
  });
});
