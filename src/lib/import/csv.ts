/**
 * A dependency-free RFC 4180 CSV reader.
 *
 * This module and its siblings run in three places — the admin import screen in
 * the browser, a server action, and `node scripts/import-directory.mts` under
 * Node's native type stripping — so the whole folder stays plain TypeScript:
 * relative imports with an explicit `.ts` extension (what Node's ESM resolver
 * needs), no `server-only`, no Node APIs, no enums, no parameter properties.
 *
 * What the reader promises, and what it deliberately does not:
 *   * quoted fields keep their commas, newlines and doubled quotes;
 *   * every line ending (CRLF, CR, LF) becomes `\n`, inside quotes as well, so
 *     a note typed on Windows compares equal to the same note typed anywhere
 *     else;
 *   * a leading byte order mark is dropped, because Excel writes one and it
 *     would otherwise become part of the first header;
 *   * trailing blank lines disappear; a blank line in the MIDDLE of the file
 *     survives as an all-empty row, so the row numbers this file hands out
 *     still count the same lines the operator sees in the spreadsheet;
 *   * a short row is padded to the header count, and a long row keeps its extra
 *     cells rather than losing them quietly — over-long rows mean the source
 *     file has a quoting problem, and the operator should be able to see it;
 *   * nothing is trimmed, folded or interpreted. Values arrive exactly as
 *     typed; normalize.ts decides what they mean.
 */

export interface ParsedCsv {
  /** The first line, verbatim. Header matching happens in presets.ts. */
  headers: string[];
  /** Data rows, header excluded. Row N in an error message is `rows[N - 1]`. */
  rows: string[][];
}

/** True when a record carries nothing at all — a blank line in the file. */
function isBlankRecord(record: string[]): boolean {
  return record.every((field) => field === '');
}

/**
 * Splits the text into records of fields. Quoting is RFC 4180: a field that
 * opens with `"` ends at the next `"` that is not doubled, and `""` inside such
 * a field is one literal quote. A quote anywhere else is ordinary text, which
 * is what keeps `12" screen` readable.
 */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];

    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at += 1;
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
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  // A file that ends without a newline still has one last record in hand; a
  // file that ends WITH one does not, which is how the final line ending stops
  // being an empty row. An unterminated quote simply ends at the file's end.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

/** Reads CSV text into a header line and its data rows. */
export function parseCsv(text: string): ParsedCsv {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const records = splitRecords(normalised);

  while (records.length > 0 && isBlankRecord(records[records.length - 1])) {
    records.pop();
  }
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0];
  const rows = records.slice(1).map((record) => {
    if (record.length >= headers.length) return record;
    return [...record, ...new Array<string>(headers.length - record.length).fill('')];
  });
  return { headers, rows };
}

/** True when a data row is entirely empty, which normalisers skip in silence. */
export function isBlankRow(row: string[]): boolean {
  return isBlankRecord(row);
}
