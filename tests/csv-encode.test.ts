/**
 * The CSV writer and the audit log's kind labels.
 *
 * The writer's contract is that anything it produces comes back unchanged
 * through a reader, so the round trips here are the point rather than a bonus:
 * a backup nobody can read is not a backup. The reader used to be the import
 * screen's parser; the in-app importer is gone with the tables it wrote, so
 * this file carries a small RFC 4180 reader of its own, which is the honest
 * shape of the assertion anyway -- the writer has to satisfy a reader it does
 * not share code with.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/audit',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { csvField, csvHeaders, csvRow, encodeCsv, toCsv } from '../src/lib/csv';
import { auditKindLabel } from '../src/components/admin/AuditLog';

/** A minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF rows. */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const body = text.replace(/^\uFEFF/, '');

  while (index < body.length) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += char === '\r' && body[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [headers = [], ...data] = rows;
  return { headers, rows: data };
}

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('ED-1042')).toBe('ED-1042');
    expect(csvField('Chromebook will not charge')).toBe('Chromebook will not charge');
    expect(csvField(42)).toBe('42');
    expect(csvField(false)).toBe('false');
  });

  it('writes null and undefined as an empty field, not the words', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField('')).toBe('');
  });

  it('quotes commas, quotes and line endings, doubling the quotes', () => {
    expect(csvField('Ortiz, Mercedes')).toBe('"Ortiz, Mercedes"');
    expect(csvField('a 12" screen')).toBe('"a 12"" screen"');
    expect(csvField('first\nsecond')).toBe('"first\nsecond"');
    expect(csvField('first\r\nsecond')).toBe('"first\r\nsecond"');
    expect(csvField('"')).toBe('""""');
  });

  it('quotes leading and trailing whitespace, which trimming readers would eat', () => {
    expect(csvField(' 4T7K9 ')).toBe('" 4T7K9 "');
    expect(csvField('\tindented')).toBe('"\tindented"');
  });

  it('writes a date as its instant and an object as JSON', () => {
    expect(csvField(new Date('2026-09-13T14:05:00.000Z'))).toBe('2026-09-13T14:05:00.000Z');
    expect(csvField({ rows: 3 })).toBe('"{""rows"":3}"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas and escapes each one', () => {
    expect(csvRow(['ED-1042', null, 'Ortiz, Mercedes'])).toBe('ED-1042,,"Ortiz, Mercedes"');
  });
});

describe('encodeCsv', () => {
  it('writes a header line and one CRLF-terminated line per row', () => {
    const csv = encodeCsv(['id', 'title'], [
      { id: '1', title: 'Projector bulb' },
      { id: '2', title: 'Login loop' },
    ]);
    expect(csv).toBe('id,title\r\n1,Projector bulb\r\n2,Login loop\r\n');
  });

  it('reads back through the importer exactly as it went in', () => {
    const rows = [
      { number: 'ED-1042', title: 'Ortiz, Mercedes reports a 12" screen', note: null },
      { number: 'ED-1043', title: 'Two lines:\nsecond line', note: ' padded ' },
      { number: 'ED-1044', title: '', note: 'plain' },
    ];
    const parsed = parseCsv(encodeCsv(['number', 'title', 'note'], rows));
    expect(parsed.headers).toEqual(['number', 'title', 'note']);
    expect(parsed.rows).toEqual([
      ['ED-1042', 'Ortiz, Mercedes reports a 12" screen', ''],
      ['ED-1043', 'Two lines:\nsecond line', ' padded '],
      ['ED-1044', '', 'plain'],
    ]);
  });

  it('reads a column a row is missing as an empty cell rather than shifting the rest', () => {
    const csv = encodeCsv(['a', 'b', 'c'], [{ a: '1', c: '3' }]);
    expect(csv).toBe('a,b,c\r\n1,,3\r\n');
  });

  it('writes a header-only file for a table with no rows', () => {
    expect(encodeCsv(['id'], [])).toBe('id\r\n');
  });
});

describe('toCsv', () => {
  it('writes rows that already sit in column order, renamed headers and all', () => {
    const csv = toCsv(
      ['Asset tag', 'Holder'],
      [
        ['4T7K9', 'Ortiz, Mercedes'],
        ['8P2M1', null],
      ],
    );
    expect(csv).toBe('Asset tag,Holder\r\n4T7K9,"Ortiz, Mercedes"\r\n8P2M1,\r\n');
    expect(parseCsv(csv).rows).toEqual([
      ['4T7K9', 'Ortiz, Mercedes'],
      ['8P2M1', ''],
    ]);
  });
});

describe('csvHeaders', () => {
  it('takes the first row’s column order and adds anything a later row introduces', () => {
    expect(csvHeaders([{ id: 1, at: 2 }, { id: 3, at: 4, detail: 5 }])).toEqual([
      'id',
      'at',
      'detail',
    ]);
    expect(csvHeaders([])).toEqual([]);
  });
});

describe('auditKindLabel', () => {
  it('replaces underscores and capitalises the first word only', () => {
    expect(auditKindLabel('created')).toBe('Created');
    expect(auditKindLabel('returned_to_queue')).toBe('Returned to queue');
    expect(auditKindLabel('collaborator_added')).toBe('Collaborator added');
    expect(auditKindLabel('device_assigned')).toBe('Device assigned');
  });

  it('leaves later words as they were stored, so an initialism survives', () => {
    expect(auditKindLabel('person_OSIS_changed')).toBe('Person OSIS changed');
  });

  it('tidies stray spacing and never renders an empty label', () => {
    expect(auditKindLabel('  device__returned  ')).toBe('Device returned');
    expect(auditKindLabel('')).toBe('Change');
    expect(auditKindLabel('___')).toBe('Change');
  });
});
