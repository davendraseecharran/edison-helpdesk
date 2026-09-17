/**
 * The directory as a spreadsheet: which columns, in which order, for each list.
 *
 * Two layouts rather than one with blanks in it, because students and staff are
 * two lists everywhere else in this application and a single sheet with an
 * empty "Guardian phone" column down the staff half would be a sheet somebody
 * has to explain. The headings are the words the screens use, so a column is
 * recognisable without the application open beside it.
 *
 * Pure: no database, no request, so the shape of the file is settled by a test
 * rather than by opening one.
 */

import type { PersonKind } from '@/lib/domain/types';

export interface PersonCsvRow {
  displayName: string;
  externalId: string | null;
  email: string | null;
  officialClass: string | null;
  department: string | null;
  guardianName?: string | null;
  guardianPhone?: string | null;
}

const STUDENT_COLUMNS = ['Name', 'OSIS', 'Class', 'Email', 'Guardian name', 'Guardian phone'];
const STAFF_COLUMNS = ['Name', 'Staff ID', 'Department', 'Email'];

export function peopleCsvColumns(kind: PersonKind): string[] {
  return kind === 'staff' ? STAFF_COLUMNS : STUDENT_COLUMNS;
}

/**
 * One row, in column order. A missing value is an empty cell rather than the
 * word "none": a blank is what a spreadsheet means by "not recorded", and it
 * survives the round trip back through a reader.
 */
export function personCsvRow(kind: PersonKind, person: PersonCsvRow): (string | null)[] {
  if (kind === 'staff') {
    return [person.displayName, person.externalId, person.department, person.email];
  }
  return [
    person.displayName,
    person.externalId,
    person.officialClass,
    person.email,
    person.guardianName ?? null,
    person.guardianPhone ?? null,
  ];
}

/** The stem the file saves under: `edison-students-2026-09-16.csv`. */
export function peopleCsvStem(kind: PersonKind): string {
  return kind === 'staff' ? 'staff' : 'students';
}
