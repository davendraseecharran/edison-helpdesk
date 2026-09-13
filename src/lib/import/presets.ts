/**
 * Column presets for the school's AppSheet exports.
 *
 * The three tabs — Student Directory, Staff Directory, Master Inventory — are
 * written out with the headers they have always had, trailing colons, spaces
 * and the `officalClass` spelling included. Those exact strings live here so
 * the operator can drop the file in and get a mapping without reading a manual,
 * and so a header that changes shows up as a failing preset rather than as
 * silently missing data.
 *
 * A preset maps TARGET FIELD → SOURCE HEADER: the key is a column the database
 * accepts, the value is the spreadsheet column it comes from. `fixed` supplies a
 * value the sheet does not carry at all (the student sheet has no "kind"
 * column; every row in it is a student).
 *
 * PEOPLE_FIELDS is deliberately free of `active`: archiving a person is the
 * administrator's switch (app_set_person_active) and app_upsert_person refuses
 * the key outright, so an import must never be able to send it.
 */

export type ImportKind = 'people' | 'devices';

export interface ColumnPreset {
  id: 'appsheet_students' | 'appsheet_staff' | 'appsheet_inventory' | 'custom';
  label: string;
  kind: ImportKind;
  /** Values the file does not carry, applied to every row. */
  fixed?: Partial<Record<string, string>>;
  /** Target field → source header. */
  map: Record<string, string>;
}

/** Every people column an import may write. `active` is not one of them. */
export const PEOPLE_FIELDS: readonly string[] = [
  'kind',
  'first_name',
  'last_name',
  'display_name',
  'email',
  'osis',
  'staff_id',
  'school_dbn',
  'department',
  'role_title',
  'official_class',
  'class_of',
  'parent_name',
  'parent_phone',
  'home_phone',
  'address',
  'notes',
];

/**
 * Every device column an import may write, plus the four holder columns. The
 * holder fields are not columns on `devices`: normalize.ts folds them into one
 * `holder` object and the import RPC turns that into an assignment.
 */
export const DEVICE_FIELDS: readonly string[] = [
  'device_id',
  'serial_number',
  'asset_tag',
  'type',
  'manufacturer',
  'model',
  'os',
  'status',
  'location',
  'notes',
  'holder_kind',
  'holder_osis',
  'holder_staff_id',
  'holder_student_name',
  'holder_staff_name',
];

/**
 * Folds a header down to the part that identifies it: letters and digits only.
 * `Student ID:`, `student id` and `STUDENTID` are the same column, and a sheet
 * that gains or loses a colon still maps.
 */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const PRESETS: ColumnPreset[] = [
  {
    id: 'appsheet_students',
    label: 'AppSheet student directory',
    kind: 'people',
    fixed: { kind: 'student' },
    map: {
      osis: 'Student ID:',
      display_name: 'Name',
      email: 'studentEmail',
      parent_name: 'Parent',
      parent_phone: 'parentNumber',
      home_phone: 'homeNumber',
      class_of: 'Class of',
      official_class: 'officalClass',
      address: 'studentAddress',
      notes: 'Notes',
    },
  },
  {
    id: 'appsheet_staff',
    label: 'AppSheet staff directory',
    kind: 'people',
    fixed: { kind: 'staff' },
    map: {
      first_name: 'firstName',
      last_name: 'lastName',
      email: 'staffEmail',
      school_dbn: 'schoolDBN',
      department: 'Department:',
      role_title: 'Role:',
    },
  },
  {
    id: 'appsheet_inventory',
    label: 'AppSheet master inventory',
    kind: 'devices',
    map: {
      device_id: 'DeviceID',
      serial_number: 'SerialNumber',
      asset_tag: 'AssetTag',
      type: 'Type',
      manufacturer: 'Manufacturer',
      model: 'Model',
      os: 'OS',
      status: 'Status',
      location: 'Location',
      notes: 'Notes',
      holder_kind: 'Assigned To',
      holder_osis: 'OSIS',
      holder_staff_id: 'StaffID',
      holder_student_name: 'Student Name',
      holder_staff_name: 'Staff Name',
    },
  },
];

/** How many of a preset's source headers the file actually has. */
function countMatches(preset: ColumnPreset, present: Set<string>): number {
  let matches = 0;
  for (const header of Object.values(preset.map)) {
    if (present.has(normaliseHeader(header))) matches += 1;
  }
  return matches;
}

/**
 * Picks the preset a file's header line belongs to, or null when no preset
 * recognises at least three of its columns. Three is low enough that a sheet
 * with a renamed column still maps and high enough that "Name" and "Notes"
 * alone never decide anything. Extra columns are ignored, so a tab that has
 * grown a column since the last import still imports.
 */
export function detectPreset(headers: string[]): ColumnPreset | null {
  const present = new Set(headers.map(normaliseHeader));
  present.delete('');

  let best: ColumnPreset | null = null;
  let bestMatches = 0;
  for (const preset of PRESETS) {
    const matches = countMatches(preset, present);
    if (matches >= 3 && matches > bestMatches) {
      best = preset;
      bestMatches = matches;
    }
  }
  return best;
}
