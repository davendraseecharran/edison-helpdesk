/**
 * A dependency-free RFC 4180 CSV writer.
 *
 * The mirror of `src/lib/import/csv.ts`, which reads. Anything this module
 * writes is readable by `parseCsv` and comes back the same, which is the
 * property the backup screen depends on: an export the owner keeps is only
 * worth keeping if it can be read again.
 *
 * What it promises:
 *   * a field holding a comma, a quote, a line ending, or leading or trailing
 *     whitespace is wrapped in quotes, and quotes inside it are doubled;
 *   * `null` and `undefined` become an empty field, never the words "null" or
 *     "undefined" — a blank cell is what a missing value looks like in a
 *     spreadsheet, and it survives a round trip through the reader;
 *   * records end with CRLF, which is what RFC 4180 asks for and what Excel
 *     writes; the reader folds every line ending back to `\n` anyway;
 *   * a Date is written as its ISO instant, and an object or array as JSON, so
 *     a jsonb column exports as something a person can still read.
 *
 * What it deliberately does NOT do: neutralise leading `=`, `+`, `-` or `@` by
 * prefixing a quote. Spreadsheets treat those as formulas, and the usual guard
 * is to insert a character that was never in the data. These files are the
 * school's own records — a ticket titled "-4 Chromebooks missing" must come
 * back as it was typed, and a backup that silently edits its own contents is
 * not a backup. The screen tells the owner to keep the files private instead.
 */

/** One field, escaped as far as RFC 4180 requires and no further. */
export function csvField(value: unknown): string {
  const text = csvText(value);
  if (text === '') return '';
  const needsQuotes =
    text.includes('"') ||
    text.includes(',') ||
    text.includes('\n') ||
    text.includes('\r') ||
    // Not required by the grammar, but many readers trim an unquoted field, and
    // a trailing space in a serial number is exactly the sort of detail an
    // export exists to preserve.
    text !== text.trim();
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Whatever a database column holds, as the text that goes in the cell. */
function csvText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** One record, without its line ending. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(',');
}

/**
 * A whole file: the header line, then one line per row, each terminated.
 *
 * Every row is read through `headers`, so a row missing a key exports as a
 * blank cell rather than shifting every column after it — PostgREST omits a
 * key it has no value for, and a shifted column would be silent corruption.
 */
export function encodeCsv(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  return toCsv(
    headers,
    rows.map((row) => headers.map((header) => row[header])),
  );
}

/**
 * The same file from rows already in column order, which is what an export
 * that renames or reorders its columns hands over.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `${[csvRow(headers), ...rows.map(csvRow)].join('\r\n')}\r\n`;
}

/**
 * The column order for a set of rows: the first row's keys, then any key a
 * later row introduces. Postgres hands PostgREST its columns in table order,
 * so the first row settles the layout and the rest only ever add to it.
 */
export function csvHeaders(rows: readonly Record<string, unknown>[]): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return headers;
}
