/**
 * Pure helpers for the directory and inventory screens: which field a
 * database message belongs beside, how a picker groups its results, and how a
 * person's second line reads. No React, no server, so all of it is testable
 * in the fast suite.
 */

import { PERSON_KIND_LABELS, type PersonKind } from './types';

/**
 * The form field a person-record message belongs next to.
 *
 * The database writes one message per rejected field, in words an operator
 * reads ("An OSIS number is 6 to 12 digits..."). Matching on those words is
 * how the message lands beside the input rather than at the foot of the form;
 * a message nothing matches goes to the foot, which is still correct.
 */
export function personErrorField(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes('osis')) return 'externalId';
  if (text.includes('staff id')) return 'email';
  if (text.includes('email')) return 'email';
  if (text.includes('guardian phone') || text.includes('home phone')) return 'guardianPhone';
  if (text.includes('class of') || text.includes('four-digit')) return 'classOf';
  if (text.includes('student or staff')) return 'kind';
  if (text.includes('display name') || text.includes("person's name")) return 'displayName';
  // The optimistic lock is about the whole record, not one field.
  if (text.includes('changed since you opened it')) return null;
  return null;
}

/** The form field a device-record message belongs next to. */
export function deviceErrorField(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes('serial number')) return 'serialNumber';
  if (text.includes('asset tag')) return 'assetTag';
  if (text.includes('device type')) return 'deviceType';
  if (text.includes('manufacturer')) return 'manufacturer';
  if (text.includes('model')) return 'model';
  if (text.includes('status')) return 'status';
  if (text.includes('location')) return 'location';
  return null;
}

/** A picker groups students and staff under their own headings, students first. */
export const PERSON_GROUP_ORDER: PersonKind[] = ['student', 'staff'];

export interface PersonGroup<T extends { kind: PersonKind }> {
  kind: PersonKind;
  label: string;
  items: T[];
}

/**
 * Results split by kind in a fixed order, keeping the search's own order
 * within each group. Empty groups are left out, so a search that only finds
 * staff shows one heading rather than an empty "Students".
 */
export function groupPeople<T extends { kind: PersonKind }>(results: T[]): PersonGroup<T>[] {
  return PERSON_GROUP_ORDER.map((kind) => ({
    kind,
    label: kind === 'student' ? 'Students' : 'Staff',
    items: results.filter((result) => result.kind === kind),
  })).filter((group) => group.items.length > 0);
}

/**
 * The quiet second line under a person's name: what they are, then where.
 * "Student, 9A" or "Staff, Science" — never a middle dot, never all caps.
 */
export function personSubtitle(person: {
  kind: PersonKind;
  officialClass?: string | null;
  classOf?: string | null;
  department?: string | null;
  staffRole?: string | null;
}): string {
  const parts = [PERSON_KIND_LABELS[person.kind]];
  if (person.kind === 'student') {
    if (person.officialClass) parts.push(person.officialClass);
    else if (person.classOf) parts.push(`class of ${person.classOf}`);
  } else {
    if (person.department) parts.push(person.department);
    else if (person.staffRole) parts.push(person.staffRole);
  }
  return parts.join(', ');
}

/** "Class 9A, class of 2029" for a student; "Science, Teacher" for staff. Empty when nothing is known. */
export function personPlacement(person: {
  kind: PersonKind;
  officialClass?: string | null;
  classOf?: string | null;
  department?: string | null;
  staffRole?: string | null;
}): string {
  const parts: string[] = [];
  if (person.kind === 'student') {
    if (person.officialClass) parts.push(`Class ${person.officialClass}`);
    if (person.classOf) parts.push(`class of ${person.classOf}`);
  } else {
    if (person.department) parts.push(person.department);
    if (person.staffRole) parts.push(person.staffRole);
  }
  return parts.join(', ');
}

/** "12 selected", "1 device", "3 devices": one place for the plural. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A record page's tickets: the live ones first, all of them, then the most
 * recent closed ones up to `recentLimit`. Both lists keep the newest-first
 * order the database returned.
 */
export function splitRecordTickets<T extends { status: string }>(
  tickets: T[],
  recentLimit = 10,
): { open: T[]; recent: T[] } {
  const live = new Set(['open', 'assigned', 'in_progress', 'waiting']);
  const open = tickets.filter((ticket) => live.has(ticket.status));
  const recent = tickets.filter((ticket) => !live.has(ticket.status)).slice(0, recentLimit);
  return { open, recent };
}

/**
 * The column names the database lists in a created or updated event's
 * detail, in the words a technician uses. Acronyms keep their capitals; the
 * rest is lower case because the list follows "Changed" in a sentence.
 */
export const RECORD_FIELD_LABELS: Record<string, string> = {
  kind: 'kind',
  first_name: 'first name',
  last_name: 'last name',
  display_name: 'display name',
  email: 'email',
  external_id: 'OSIS or staff ID',
  source_external_id: 'source ID',
  school_dbn: 'school DBN',
  department: 'department',
  staff_role: 'role',
  official_class: 'official class',
  class_of: 'class of',
  student_status: 'enrolment status',
  guardian_name: 'parent or guardian',
  guardian_phone: 'guardian phone',
  home_phone: 'home phone',
  address: 'address',
  notes: 'notes',
  device_type: 'type',
  serial_number: 'serial number',
  asset_tag: 'asset tag',
  manufacturer: 'manufacturer',
  model: 'model',
  os_version: 'OS',
  status: 'status',
  location: 'location',
  assigned_requester_id: 'assignment',
};

/**
 * "kind, first_name, osis" as "kind, first name, OSIS", or null when the
 * detail is not a list of known columns, so anything else stays as written.
 */
export function describeFieldList(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const names = detail.split(',').map((name) => name.trim());
  if (names.length === 0 || names.some((name) => !(name in RECORD_FIELD_LABELS))) return null;
  return names.map((name) => RECORD_FIELD_LABELS[name]).join(', ');
}
