/**
 * A roster and a register, as files.
 *
 * Pure shaping on one side of the line and the export routes on the other:
 * what goes in which column is a product decision, and it is easier to read —
 * and to change — as a list of headers and a row builder than inside a route
 * handler that is also doing authorization, a database read and an audit
 * write. Pure, like `device-csv.ts` beside it, so the shape of both files can
 * be tested without a database.
 *
 * Both files are for a person to open in a spreadsheet, so a kind reads as
 * "Student" rather than `student` and a tick reads as "Yes" rather than `true`.
 * The recorded fact is a row that exists; the empty cell says "No" out loud
 * because a blank column in a spreadsheet is a question rather than an answer.
 */

import type { GroupField, GroupMember } from '@/lib/data/groups';
import type { RollEntry } from '@/lib/data/group-events';
import { PERSON_KIND_LABELS } from '@/lib/domain/types';
import { formatDateTime } from '@/lib/format';

const YES = 'Yes';
const NO = 'No';

/** The roster's columns: the six fixed ones, then one per checklist column. */
export function rosterColumns(fields: readonly GroupField[]): string[] {
  return [
    'Name',
    'Student or staff',
    'OSIS or staff ID',
    'Class or department',
    'Email',
    'Note',
    ...fields.map((field) => field.name),
  ];
}

export function rosterRow(
  member: GroupMember,
  fields: readonly GroupField[],
  marks: Record<string, string[]>,
): unknown[] {
  const ticked = new Set(marks[member.id] ?? []);
  return [
    member.displayName,
    PERSON_KIND_LABELS[member.kind],
    member.externalId,
    member.groupLabel,
    member.email,
    member.note,
    ...fields.map((field) => (ticked.has(field.id) ? YES : NO)),
  ];
}

export const ATTENDANCE_COLUMNS = [
  'Name',
  'OSIS or staff ID',
  'Class or department',
  'Present',
  'Marked at',
] as const;

export function attendanceRow(entry: RollEntry): unknown[] {
  return [
    entry.displayName,
    entry.externalId,
    entry.groupLabel,
    entry.present ? YES : NO,
    // The instant, as a person reads it, because a register is read next to a
    // day rather than parsed.
    entry.markedAt ? formatDateTime(entry.markedAt) : null,
  ];
}

/**
 * A group's name as the first part of a file name: lower case, words joined by
 * hyphens, nothing a file system or a shell has an opinion about. An empty
 * result falls back to "group", which happens for a roster named entirely in
 * punctuation and should still download.
 */
export function fileStem(prefix: string, groupName: string): string {
  const slug = groupName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? prefix : `${prefix}-${slug}`;
}
