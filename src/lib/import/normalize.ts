/**
 * Turning spreadsheet cells into rows the database will accept.
 *
 * The AppSheet tabs are a mirror of how people type, not of what the tables
 * hold: an OSIS arrives as `243,025,319`, an email in the case someone's phone
 * chose, a serial in whichever case the label printer used, a blank cell as the
 * empty string rather than as a missing value. Every rule below folds a value
 * to the ONE spelling the database stores, and folds it the same way
 * app_upsert_person and app_upsert_device do, so the dry run an operator reads
 * and the commit that follows agree:
 *
 *   osis          separators stripped, then 6 to 12 digits or the row is an
 *                 error (the column check is `^[0-9]{6,12}$`, and a value that
 *                 still has letters in it is a typo, not an identifier)
 *   email         trimmed and lower-cased, so uniqueness is by address
 *   staff_id      trimmed and upper-cased
 *   device id,    trimmed and upper-cased, matching the unique indexes, which
 *   serial,       are on upper(...)
 *   asset tag
 *   phones        kept as text: digits, and a leading + when the sheet had one.
 *                 Never parsed into a number — a leading zero is not noise
 *   everything    whitespace collapsed; an empty cell becomes null
 *
 * `active` is never emitted. Archiving a person is the administrator's switch
 * and app_upsert_person refuses the key outright.
 *
 * Errors carry the DATA row number, 1-based with the header excluded, so the
 * number in the import screen is the row the operator can go and fix. A row
 * that errors is left out of `rows`; the rest of the file still imports.
 */

// @ts-expect-error Node's native type stripping resolves the real file name, and TypeScript
// reads the same path. See the note at the top of csv.ts.
import { isBlankRow, type ParsedCsv } from './csv.ts';
// @ts-expect-error Same: the extension is what lets `node scripts/import-directory.mts` run this.
import { normaliseHeader, type ColumnPreset } from './presets.ts';

export interface PersonRow {
  kind: 'student' | 'staff';
  first_name: string;
  last_name: string;
  display_name: string;
  email: string | null;
  osis: string | null;
  staff_id: string | null;
  school_dbn: string | null;
  department: string | null;
  role_title: string | null;
  official_class: string | null;
  class_of: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  home_phone: string | null;
  address: string | null;
  notes: string | null;
}

export interface DeviceHolder {
  kind: 'student' | 'staff';
  osis: string | null;
  staff_id: string | null;
  name: string | null;
}

export interface DeviceRow {
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  status: 'in_stock' | 'deployed' | 'in_repair' | 'retired' | 'lost' | 'surplus';
  location: string | null;
  notes: string | null;
  holder: DeviceHolder | null;
}

export interface RowError {
  row: number;
  message: string;
}

const MISSING_NAME = 'This row has no name. Add one to the spreadsheet and import again.';
const MISSING_KIND = 'This row does not say whether the person is a student or staff.';
const MISSING_DEVICE_ID =
  'This row has no device id, serial number or asset tag. Add one and import again.';

/** The same sentence app_upsert_person raises, so both places read alike. */
function badOsis(raw: string): string {
  return `An OSIS number is 6 to 12 digits. Check "${raw}" and enter it again.`;
}

/** Trims and collapses runs of whitespace, newlines from a quoted cell included. */
function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** A blank cell is an absent value, not the empty string. */
function textOrNull(raw: string): string | null {
  const value = collapse(raw);
  return value === '' ? null : value;
}

/** Identifiers the database compares upper-cased: serial, asset tag, staff id. */
function upperOrNull(raw: string): string | null {
  const value = collapse(raw).toUpperCase();
  return value === '' ? null : value;
}

function emailOrNull(raw: string): string | null {
  const value = collapse(raw).toLowerCase();
  return value === '' ? null : value;
}

/**
 * Phone numbers stay text. Formatting is dropped so two spellings of one number
 * match; a leading `+` survives because an international number without it is a
 * different number.
 */
function phoneOrNull(raw: string): string | null {
  const value = collapse(raw);
  const digits = value.replace(/[^0-9]/g, '');
  if (digits === '') return null;
  return value.startsWith('+') ? `+${digits}` : digits;
}

/**
 * Folds an OSIS the way the database does: commas and spaces out, and then it
 * either is 6 to 12 digits or it is not an OSIS. Anything else — a letter, a
 * dash, `n/a` — returns null rather than being quietly cut down to the digits
 * it happens to contain.
 */
export function normaliseOsis(raw: string): string | null {
  const digits = raw.replace(/[,\s]/g, '');
  return /^[0-9]{6,12}$/.test(digits) ? digits : null;
}

/**
 * Splits an AppSheet device id such as `PW0FYJ9B-WIN` into its serial and its
 * operating system. The split is on the LAST hyphen, because serials in the
 * sheet contain hyphens and the suffix never does. An id with no suffix is a
 * serial on its own.
 */
export function splitDeviceId(raw: string): { serial: string | null; os: string | null } {
  const value = collapse(raw).toUpperCase();
  if (value === '') return { serial: null, os: null };
  const at = value.lastIndexOf('-');
  if (at <= 0) return { serial: value, os: null };
  const serial = value.slice(0, at);
  const os = value.slice(at + 1);
  return { serial: serial === '' ? null : serial, os: os === '' ? null : os };
}

/**
 * Maps the inventory sheet's status words onto the `devices.status` check.
 * A word nobody recognises means in stock: an unknown status must not stop an
 * import, and "in stock" is the state that claims the least.
 */
export function mapStatus(raw: string): DeviceRow['status'] {
  const word = collapse(raw).toLowerCase().replace(/[_-]+/g, ' ');
  switch (word) {
    case 'deployed':
      return 'deployed';
    case '':
    case 'in stock':
    case 'available':
      return 'in_stock';
    case 'repair':
    case 'in repair':
      return 'in_repair';
    case 'retired':
      return 'retired';
    case 'lost':
    case 'missing':
      return 'lost';
    case 'surplus':
      return 'surplus';
    default:
      return 'in_stock';
  }
}

/** Reads one target field out of a row, through the preset's mapping. */
type CellReader = (row: string[], field: string) => string;

function cellReader(csv: ParsedCsv, preset: ColumnPreset): CellReader {
  // First column wins when a sheet repeats a header, which is what a reader
  // looking at the file left to right would assume.
  const columns = new Map<string, number>();
  csv.headers.forEach((header, at) => {
    const key = normaliseHeader(header);
    if (key !== '' && !columns.has(key)) columns.set(key, at);
  });

  return (row, field) => {
    const fixed = preset.fixed?.[field];
    if (fixed !== undefined) return fixed;
    const header = preset.map[field];
    if (header === undefined) return '';
    const at = columns.get(normaliseHeader(header));
    if (at === undefined) return '';
    return row[at] ?? '';
  };
}

/**
 * The student sheet has one `Name` column and the staff sheet has two. Splitting
 * on the LAST space keeps `Pat Q Example` together as `Pat Q` + `Example`, and a
 * one-word name becomes the last name, because that is the half a directory is
 * ordered and searched by. The display name is always what the sheet showed.
 */
function readName(cell: CellReader, row: string[], preset: ColumnPreset) {
  const splitColumns = preset.map.first_name !== undefined || preset.map.last_name !== undefined;
  const given = collapse(cell(row, 'display_name'));

  if (splitColumns) {
    const first = collapse(cell(row, 'first_name'));
    const last = collapse(cell(row, 'last_name'));
    const display = given !== '' ? given : [first, last].filter((half) => half !== '').join(' ');
    return { first_name: first, last_name: last, display_name: display };
  }

  const at = given.lastIndexOf(' ');
  return {
    first_name: at === -1 ? '' : given.slice(0, at),
    last_name: at === -1 ? given : given.slice(at + 1),
    display_name: given,
  };
}

/** Normalises a parsed people sheet. Rows that cannot be saved become errors. */
export function toPersonRows(
  csv: ParsedCsv,
  preset: ColumnPreset,
): { rows: PersonRow[]; errors: RowError[] } {
  const cell = cellReader(csv, preset);
  const rows: PersonRow[] = [];
  const errors: RowError[] = [];

  csv.rows.forEach((raw, index) => {
    const row = index + 1;
    if (isBlankRow(raw)) return;

    const kind = collapse(cell(raw, 'kind')).toLowerCase();
    if (kind !== 'student' && kind !== 'staff') {
      errors.push({ row, message: MISSING_KIND });
      return;
    }

    const name = readName(cell, raw, preset);
    if (name.display_name === '') {
      errors.push({ row, message: MISSING_NAME });
      return;
    }

    const rawOsis = collapse(cell(raw, 'osis'));
    let osis: string | null = null;
    if (rawOsis !== '') {
      osis = normaliseOsis(rawOsis);
      if (osis === null) {
        errors.push({ row, message: badOsis(rawOsis) });
        return;
      }
    }

    rows.push({
      kind,
      first_name: name.first_name,
      last_name: name.last_name,
      display_name: name.display_name,
      email: emailOrNull(cell(raw, 'email')),
      osis,
      staff_id: upperOrNull(cell(raw, 'staff_id')),
      school_dbn: textOrNull(cell(raw, 'school_dbn')),
      department: textOrNull(cell(raw, 'department')),
      role_title: textOrNull(cell(raw, 'role_title')),
      official_class: textOrNull(cell(raw, 'official_class')),
      class_of: textOrNull(cell(raw, 'class_of')),
      parent_name: textOrNull(cell(raw, 'parent_name')),
      parent_phone: phoneOrNull(cell(raw, 'parent_phone')),
      home_phone: phoneOrNull(cell(raw, 'home_phone')),
      address: textOrNull(cell(raw, 'address')),
      notes: textOrNull(cell(raw, 'notes')),
    });
  });

  return { rows, errors };
}

/**
 * Normalises a parsed inventory sheet.
 *
 * `DeviceID` fills in a missing serial and operating system, and only those: a
 * sheet that has its own `SerialNumber` or `OS` column means them, and a
 * derived value must never overwrite one somebody typed.
 *
 * The holder is the four "Assigned To / OSIS / StaffID / name" columns folded
 * into one object for the import RPC to match against the directory. It is null
 * when there is nothing to match on — a kind with no identifier and no name
 * says only that the sheet has a column.
 */
export function toDeviceRows(
  csv: ParsedCsv,
  preset: ColumnPreset,
): { rows: DeviceRow[]; errors: RowError[] } {
  const cell = cellReader(csv, preset);
  const rows: DeviceRow[] = [];
  const errors: RowError[] = [];

  csv.rows.forEach((raw, index) => {
    const row = index + 1;
    if (isBlankRow(raw)) return;

    const deviceId = upperOrNull(cell(raw, 'device_id'));
    const derived = deviceId === null ? { serial: null, os: null } : splitDeviceId(deviceId);
    const serial = upperOrNull(cell(raw, 'serial_number')) ?? derived.serial;
    const assetTag = upperOrNull(cell(raw, 'asset_tag'));
    if (deviceId === null && serial === null && assetTag === null) {
      errors.push({ row, message: MISSING_DEVICE_ID });
      return;
    }

    const rawHolderOsis = collapse(cell(raw, 'holder_osis'));
    let holderOsis: string | null = null;
    if (rawHolderOsis !== '') {
      holderOsis = normaliseOsis(rawHolderOsis);
      if (holderOsis === null) {
        errors.push({ row, message: badOsis(rawHolderOsis) });
        return;
      }
    }

    const holderStaffId = upperOrNull(cell(raw, 'holder_staff_id'));
    const studentName = textOrNull(cell(raw, 'holder_student_name'));
    const staffName = textOrNull(cell(raw, 'holder_staff_name'));
    const holderKind = readHolderKind(collapse(cell(raw, 'holder_kind')), {
      osis: holderOsis,
      staffId: holderStaffId,
      studentName,
      staffName,
    });
    const holderName =
      holderKind === 'staff' ? (staffName ?? studentName) : (studentName ?? staffName);

    const holder: DeviceHolder | null =
      holderKind !== null && (holderOsis !== null || holderStaffId !== null || holderName !== null)
        ? { kind: holderKind, osis: holderOsis, staff_id: holderStaffId, name: holderName }
        : null;

    rows.push({
      device_id: deviceId,
      serial_number: serial,
      asset_tag: assetTag,
      type: textOrNull(cell(raw, 'type')) ?? 'Laptop',
      manufacturer: textOrNull(cell(raw, 'manufacturer')),
      model: textOrNull(cell(raw, 'model')),
      os: textOrNull(cell(raw, 'os')) ?? derived.os,
      status: mapStatus(cell(raw, 'status')),
      location: textOrNull(cell(raw, 'location')),
      notes: textOrNull(cell(raw, 'notes')),
      holder,
    });
  });

  return { rows, errors };
}

/**
 * `Assigned To` says Student or Staff. When it is blank — and older rows in the
 * sheet leave it blank — the filled-in columns say the same thing: an OSIS or a
 * student name is a student, a staff id or a staff name is a member of staff.
 */
function readHolderKind(
  raw: string,
  found: {
    osis: string | null;
    staffId: string | null;
    studentName: string | null;
    staffName: string | null;
  },
): 'student' | 'staff' | null {
  const word = raw.toLowerCase();
  if (word === 'student') return 'student';
  if (word === 'staff') return 'staff';
  if (found.osis !== null) return 'student';
  if (found.staffId !== null) return 'staff';
  if (found.studentName !== null) return 'student';
  if (found.staffName !== null) return 'staff';
  return null;
}
