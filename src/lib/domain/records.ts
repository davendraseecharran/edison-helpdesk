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
 * app_save_person and app_validate_profile write one message per rejected
 * field, some in an operator's words ("OSIS must contain numbers only.") and
 * some naming the JSON key ("Enter a valid phone number for guardianPhone.").
 * Matching on either is how the message lands beside the input rather than at
 * the foot of the form; a message nothing matches goes to the foot, which is
 * still correct, and is where a message about the WHOLE record belongs anyway.
 */
export function personErrorField(message: string): string | null {
  const text = message.toLowerCase();
  // The optimistic lock is about the whole record, so it goes to the foot.
  if (text.includes('changed since you opened it')) return null;
  if (text.includes('osis')) return 'externalId';
  if (text.includes('email')) return 'email';
  if (text.includes('guardianphone')) return 'guardianPhone';
  if (text.includes('homephone')) return 'homePhone';
  if (text.includes('class of') || text.includes('classof')) return 'classOf';
  if (text.includes('enrollment status') || text.includes('studentstatus')) return 'studentStatus';
  if (text.includes('staff or student') || text.includes('student or staff')) return 'kind';
  if (text.includes('a name is required') || text.includes('displayname')) return 'displayName';
  if (text.includes('address')) return 'address';
  if (text.includes('notes')) return 'notes';
  return null;
}

/** The form field a device-record message belongs next to. */
export function deviceErrorField(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes('changed since you opened it')) return null;
  // "Device type, manufacturer, model and serial number are required." names
  // four fields at once, so it belongs at the foot rather than beside one of
  // them; the serial is the only one of the four with a rule of its own.
  if (text.includes('are required')) return null;
  if (text.includes('serial number') || text.includes('serialnumber')) return 'serialNumber';
  if (text.includes('asset tag') || text.includes('assettag')) return 'assetTag';
  if (text.includes('device type') || text.includes('devicetype')) return 'deviceType';
  if (text.includes('manufacturer')) return 'manufacturer';
  if (text.includes('model')) return 'model';
  if (text.includes('assignment') || text.includes('assignedrequesterid')) return 'assignedRequesterId';
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

/**
 * Whether an identifier was made up by the system rather than issued by anyone.
 *
 * A student's OSIS is nine digits a person can read out over the phone, and a
 * member of staff's ID is the local part of the address they sign in with —
 * `mellery`, which the school also uses. But a record imported or seeded without
 * a real address gets `marcus.ellery-1e1ec7b6`: a name slug with a hex tail,
 * unique and useful to the database and meaningless to anybody reading it under
 * a person's name in a picker.
 *
 * The shape is the test, because it is the only thing available where this
 * matters: one run of word characters, dots, hyphens or underscores, ending in a
 * hyphen and six or more hex digits, with no spaces. A department ("Grade 6
 * ELA", "Facilities") never matches; a real staff ID never matches either.
 */
/**
 * Whether a URL points at the machine it is displayed on.
 *
 * The pairing QR carries whatever `NEXT_PUBLIC_APP_ORIGIN` says the application
 * is reachable at, and in production that is the Vercel address. Locally it is
 * a loopback address, which a phone camera will happily read and then fail to
 * open, because 127.0.0.1 on a phone is the phone. The dialog says so rather
 * than letting somebody photograph a monitor twice.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'];

export function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(value).hostname);
  } catch {
    // Not a URL at all is not a loopback URL; the dialog shows it either way.
    return false;
  }
}

const GENERATED_IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*-[0-9a-f]{6,}$/i;

export function isGeneratedIdentifier(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return false;
  return GENERATED_IDENTIFIER.test(trimmed);
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

/**
 * The two columns at the end of a directory row, which depend on who is reading.
 *
 * A technician scans the roster for machines and for who is stuck, so they get
 * Devices and Open. A skills officer reads no tickets and hands out no
 * machines: both of those columns are a zero on every row for them, and a
 * column that is the same on every row is a column that is not there. What they
 * actually work from is an address and which rosters somebody is on.
 *
 * Here rather than in the list, so the rule is a unit test rather than two
 * accounts to sign in as.
 */
export type DirectoryTailColumn = 'devices' | 'open' | 'email' | 'groups';

export function directoryTailColumns(ticketWorker: boolean): DirectoryTailColumn[] {
  return ticketWorker ? ['devices', 'open'] : ['email', 'groups'];
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
