import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/import/csv';

describe('parseCsv', () => {
  it('reads a plain file into headers and rows', () => {
    const csv = parseCsv('Name,OSIS\nPat Example,240000123\nRiver Sample,240000124\n');
    expect(csv.headers).toEqual(['Name', 'OSIS']);
    expect(csv.rows).toEqual([
      ['Pat Example', '240000123'],
      ['River Sample', '240000124'],
    ]);
  });

  it('reads a last line that has no trailing newline', () => {
    const csv = parseCsv('Name,OSIS\nPat Example,240000123');
    expect(csv.rows).toEqual([['Pat Example', '240000123']]);
  });

  it('keeps commas and newlines that sit inside quoted fields', () => {
    const csv = parseCsv('Name,Notes\n"Example, Pat","Cart 3, room 214\nBack on Tuesday"\n');
    expect(csv.rows).toEqual([['Example, Pat', 'Cart 3, room 214\nBack on Tuesday']]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    const csv = parseCsv('Notes\n"She said ""take the cart"" on Monday"\n');
    expect(csv.rows).toEqual([['She said "take the cart" on Monday']]);
  });

  it('keeps a comma directly after a closing quote as a delimiter', () => {
    const csv = parseCsv('A,B\n"one","two"\n');
    expect(csv.rows).toEqual([['one', 'two']]);
  });

  it('strips a byte order mark and reads CRLF line endings', () => {
    const csv = parseCsv('﻿Student ID:,Name\r\n240000123,Pat Example\r\n');
    expect(csv.headers).toEqual(['Student ID:', 'Name']);
    expect(csv.rows).toEqual([['240000123', 'Pat Example']]);
  });

  it('normalises a CRLF that is embedded in a quoted field', () => {
    const csv = parseCsv('Name,Notes\r\nPat Example,"first line\r\nsecond line"\r\n');
    expect(csv.rows).toEqual([['Pat Example', 'first line\nsecond line']]);
  });

  it('pads a short row and keeps the extra cells of a long one', () => {
    const csv = parseCsv('A,B,C\n1,2\n1,2,3,4\n');
    expect(csv.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  it('drops trailing blank lines and keeps a blank line in the middle', () => {
    const csv = parseCsv('A,B\nx,y\n\nz,w\n\n\n');
    expect(csv.rows).toEqual([
      ['x', 'y'],
      ['', ''],
      ['z', 'w'],
    ]);
  });

  it('returns no rows for a header-only file', () => {
    expect(parseCsv('DeviceID,SerialNumber\n')).toEqual({
      headers: ['DeviceID', 'SerialNumber'],
      rows: [],
    });
  });

  it('returns nothing at all for an empty file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('﻿')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('\r\n\r\n')).toEqual({ headers: [], rows: [] });
  });

  it('leaves padding and stray quotes in unquoted fields alone', () => {
    const csv = parseCsv('A,B\n x , 12" screen \n');
    expect(csv.rows).toEqual([[' x ', ' 12" screen ']]);
  });

  it('closes an unterminated quoted field at the end of the file', () => {
    const csv = parseCsv('Notes\n"no closing quote');
    expect(csv.rows).toEqual([['no closing quote']]);
  });

  it('reads an empty trailing cell as an empty string', () => {
    const csv = parseCsv('A,B,C\nx,,\n');
    expect(csv.rows).toEqual([['x', '', '']]);
  });
});
