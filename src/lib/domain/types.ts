/**
 * Domain types for the Edison helpdesk.
 *
 * These shapes are deliberately database-flavoured: stable ids, normalised
 * relations (collaborators, notes, events and work logs are separate
 * collections rather than nested blobs), and a primary owner kept separate from
 * the collaborator list. M2 replaces the in-memory demo store with Supabase
 * tables using the same field names so the views do not need rewriting.
 *
 * Timestamps are ISO 8601 strings. Calendar dates (school-local submission
 * date, work-log date) are `YYYY-MM-DD` strings so backdating never depends on
 * a timezone conversion.
 */

export type AccountId = string;
export type RequesterId = string;
export type TicketId = string;

export type Role = 'admin' | 'technician';

/**
 * `setup_pending` means the admin has created the account but the technician has
 * not chosen a password yet. `pending_approval` and `denied` belong to the
 * Google sign-in path: somebody signed in with a verified address that held no
 * invite, so an administrator has to decide before they are anything at all.
 * None of the three can reach ticket data (enforced server-side in M3/M5; here
 * it only shapes labels and lists).
 */
export type AccountStatus =
  | 'active'
  | 'inactive'
  | 'setup_pending'
  | 'pending_approval'
  | 'denied';

export type IntakeChannel = 'walk_in' | 'email' | 'phone_call';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type TicketStatus =
  | 'open'
  | 'assigned'
  | 'in_progress'
  | 'waiting'
  | 'resolved'
  | 'cancelled';

/**
 * What kind of problem a ticket is, from a fixed vocabulary rather than free
 * text, so the queue filter is a real filter instead of a search over however
 * somebody happened to type "wifi". `other` is the default and is honest: an
 * uncategorised ticket is not a miscategorised one.
 *
 * Mirrors the `tickets_category_valid` constraint and `app_category_labels()`
 * in 20260914100350_m5_ticket_category_devices.sql. The database REFUSES a value
 * outside this set rather than folding it to `other`.
 */
export type TicketCategory =
  | 'chromebook'
  | 'laptop_desktop'
  | 'projector_display'
  | 'network'
  | 'printer'
  | 'account'
  | 'software'
  | 'phone'
  | 'other';

export interface Account {
  id: AccountId;
  /** Display name used for attribution in history. */
  displayName: string;
  /** Sign-in identity. Synthetic for the prototype. */
  email: string;
  role: Role;
  status: AccountStatus;
  createdAt: string;
  /**
   * Simulated record of the last setup/recovery action an admin performed.
   * Never holds a link or token — those are credentials and are not logged.
   */
  lastCredentialActionAt?: string | null;
  lastCredentialActionKind?: 'setup_issued' | 'recovery_issued' | null;
}

/**
 * Minimal requester record. A requester is not an app account and has no login.
 * Later milestones extend this with directory attributes; ids stay stable.
 */
export interface Requester {
  id: RequesterId;
  displayName: string;
  kind: 'staff' | 'student' | 'role' | 'unknown';
  /** Department, grade band or role label — only what a technician needs. */
  descriptor?: string | null;
  /**
   * The directory record this requester is, when they are on the roster. Absent
   * for a requester typed in at the desk — a parent, a vendor, a visiting coach
   * — which stays a normal case rather than an incomplete one.
   */
  personId?: string | null;
}

export interface DeviceObservation {
  id: string;
  ticketId: TicketId;
  deviceType: string;
  manufacturer?: string | null;
  inventoryDeviceId?: string | null;
  /** Snapshot of the model observed at service time. */
  model?: string | null;
  osVersion?: string | null;
  /** Historical observations may lack a serial; new intake requires one. */
  serialNumber?: string | null;
  assetTag?: string | null;
  /** Set when the serial/asset tag is genuinely not applicable (e.g. a room drop). */
  identifiersNotApplicable?: boolean;
  recordedById: AccountId;
  recordedAt: string;
  /** Defaults to `user` for records written before attribution existed. */
  performedVia?: PerformedVia;
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel?: string | null;
}

/**
 * A machine from the inventory that a ticket names.
 *
 * Different in kind from a `DeviceObservation`: an observation is what a
 * technician saw and wrote down, and has to keep working for a laptop that is
 * not in the inventory at all. This is a claim that a specific inventory record
 * is involved, so its fields are the inventory's, not the technician's.
 */
export interface LinkedDevice {
  /** The inventory record's id. */
  id: string;
  /** The inventory's own identifier, e.g. `DEV-4F2A9C1B77E0`. */
  externalId: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  status: string;
  location: string | null;
  linkedAt: string;
  linkedById: AccountId;
}

export interface WorkNote {
  id: string;
  ticketId: TicketId;
  authorId: AccountId;
  body: string;
  createdAt: string;
  /** Defaults to `user` for records written before attribution existed. */
  performedVia?: PerformedVia;
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel?: string | null;
}

/**
 * Optional manual time entry. Totals are person-time: two technicians logging
 * 20 minutes each on one ticket is 40 technician-minutes. An absent work log is
 * "not recorded", which is different from a recorded zero.
 */
export interface WorkLog {
  id: string;
  ticketId: TicketId;
  contributorId: AccountId;
  /** School-local calendar date the work happened (`YYYY-MM-DD`). */
  workDate: string;
  minutes: number;
  description?: string | null;
  createdAt: string;
  /** Defaults to `user` for records written before attribution existed. */
  performedVia?: PerformedVia;
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel?: string | null;
}

export type ActivityKind =
  | 'created'
  | 'claimed'
  | 'assigned'
  | 'returned_to_queue'
  | 'collaborator_added'
  | 'collaborator_removed'
  | 'note_added'
  | 'device_recorded'
  | 'priority_changed'
  | 'status_changed'
  | 'time_logged'
  | 'resolved'
  | 'reopened'
  | 'cancelled'
  | 'category_changed'
  | 'device_linked'
  | 'device_unlinked';

/**
 * How a recorded action was carried out.
 *
 * `ai` means an assistant performed it on the actor's behalf. It never replaces
 * the actor: the responsible account is the same either way, so this only adds
 * context to history, it never removes accountability from it.
 */
export type PerformedVia = 'user' | 'ai';

export interface ActivityEvent {
  id: string;
  ticketId: TicketId;
  kind: ActivityKind;
  actorId: AccountId;
  at: string;
  /** Human-readable summary rendered in the ticket timeline. */
  summary: string;
  /** Optional longer body (reason text, note excerpt). Never a credential. */
  detail?: string | null;
  /** Defaults to `user` for records written before attribution existed. */
  performedVia?: PerformedVia;
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel?: string | null;
}

/**
 * A private in-app notice for one account.
 *
 * Notices are written by trusted server-side code only, never by a session, and
 * carry no credential: `href` is a relative in-app path, not a link with a token.
 */
export interface Notification {
  id: string;
  accountId: AccountId;
  /** Machine-readable category, e.g. `ticket_assigned`. */
  kind: string;
  title: string;
  body?: string | null;
  /** Relative in-app path this notice points at. */
  href?: string | null;
  createdAt: string;
  /** `null` while the notice is still unread. */
  readAt: string | null;
}

export interface Ticket {
  id: TicketId;
  /** Readable ticket number shown in queues, e.g. "EDT-1042". */
  number: string;
  title: string;
  issue: string;
  /** `null` together with `requesterUnknown` expresses an explicitly unknown requester. */
  requesterId: RequesterId | null;
  requesterUnknown: boolean;
  /** `null` means unknown location; `isRemote` marks remote/no-location work. */
  location: string | null;
  isRemote: boolean;
  channel: IntakeChannel;
  priority: Priority;
  status: TicketStatus;
  /** What kind of problem this is. `other` until somebody says otherwise. */
  category: TicketCategory;
  /**
   * How many inventory machines this ticket names.
   *
   * A count rather than the ids on purpose. `app_list_tickets` returns
   * `device_count` for a queue row, because a list renders a number and
   * fetching every id for twenty-five rows to call `.length` on them is work
   * nobody reads. The ids, and everything else about each machine, are on
   * `TicketDetail.linkedDevices`, which is where a screen that needs them is.
   */
  linkedDeviceCount: number;
  /** School-local submission date, backdatable by an admin (`YYYY-MM-DD`). */
  submittedOn: string;
  /**
   * When the request was opened. Usually the moment it was recorded; a ticket
   * logged later carries the earlier moment here and the real one in
   * `loggedAt`. The older date-only backdate (`submittedOn`) never moved it.
   */
  createdAt: string;
  /** When it was actually written down, when that was later than `createdAt`. */
  loggedAt?: string | null;
  createdById: AccountId;
  /** Primary owner. Preserved even when a collaborator resolves the ticket. */
  ownerId: AccountId | null;
  collaboratorIds: AccountId[];
  /** When the current owner took the ticket (claim or admin assignment). */
  assignedAt: string | null;
  waitingReason: string | null;
  solution: string | null;
  resolvedById: AccountId | null;
  resolvedAt: string | null;
  /** How the resolution was made. Defaults to `user` for tickets resolved before attribution existed. */
  resolvedVia?: PerformedVia;
  /** Model that assisted the resolution, when `resolvedVia` is `ai`. */
  resolvedAiModel?: string | null;
  cancelReason: string | null;
}

/**
 * The whole prototype dataset. Mirrors the table set proposed in
 * TICKETING-PLAN.md so M2 can map it onto Postgres relations directly.
 */
export interface HelpdeskData {
  accounts: Account[];
  requesters: Requester[];
  tickets: Ticket[];
  deviceObservations: DeviceObservation[];
  notes: WorkNote[];
  workLogs: WorkLog[];
  activity: ActivityEvent[];
  /** Monotonic counters standing in for database sequences. */
  sequences: {
    ticketNumber: number;
    entity: number;
  };
}

/** Result of a mutation: either new data, or a validation/permission failure. */
export type OperationResult =
  | { ok: true; data: HelpdeskData; ticketId?: TicketId; message?: string }
  | { ok: false; error: string; field?: string };

/** Context every mutation needs: who is acting and what time it is. */
export interface OperationContext {
  actorId: AccountId;
  /** ISO timestamp used for records written by this operation. */
  now: string;
  /** School-local calendar date (`YYYY-MM-DD`) used for defaults. */
  today: string;
}

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Sentence case, and named the way a technician would say it out loud rather
 * than the way the column stores it. Insertion order is the order the intake and
 * detail selects offer them in: the common calls first, `Other` last.
 */
export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  chromebook: 'Chromebook',
  laptop_desktop: 'Laptop or desktop',
  projector_display: 'Projector or display',
  network: 'Network or Wi-Fi',
  printer: 'Printer',
  account: 'Account or password',
  software: 'Software',
  phone: 'Phone',
  other: 'Other',
};

export const TICKET_CATEGORIES = Object.keys(TICKET_CATEGORY_LABELS) as TicketCategory[];

/**
 * `Object.hasOwn`, not `in`: every object inherits `toString`, `constructor`
 * and `__proto__` from its prototype, so `in` would accept all three as
 * categories. This guard decides what reaches the database from a URL, and the
 * database would then refuse the value with a message about choosing a
 * category — which is a confusing way to learn that `?category=constructor`
 * was treated as real.
 */
export function isTicketCategory(value: unknown): value is TicketCategory {
  return typeof value === 'string' && Object.hasOwn(TICKET_CATEGORY_LABELS, value);
}

export const CHANNEL_LABELS: Record<IntakeChannel, string> = {
  walk_in: 'Walk-in',
  email: 'Email',
  phone_call: 'Phone call',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  setup_pending: 'Setup pending',
  pending_approval: 'Waiting for approval',
  denied: 'Access declined',
};

export const WAITING_REASONS = [
  'Awaiting user',
  'Awaiting parts',
  'Awaiting vendor',
] as const;

/** Statuses that still represent live work. */
export const ACTIVE_STATUSES: TicketStatus[] = [
  'open',
  'assigned',
  'in_progress',
  'waiting',
];

export function isActiveStatus(status: TicketStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/* --- Directory and inventory ------------------------------------------- */

/**
 * The district's own directory and inventory.
 *
 * Both live in the owner's tables — `public.requesters` and
 * `public.inventory_devices` — and both are read and written only through
 * SECURITY DEFINER functions. The shapes below are the JSON those functions
 * return, key for key: `app_person_json` and `app_inventory_device_json`.
 * Every text field arrives as a string, never null, because the database
 * coalesces them; a missing value is an empty string.
 */

export type PersonKind = 'student' | 'staff';

export const PERSON_KIND_LABELS: Record<PersonKind, string> = {
  student: 'Student',
  staff: 'Staff',
};

export function isPersonKind(value: unknown): value is PersonKind {
  return value === 'student' || value === 'staff';
}

/** Where a student is in their time at the school. Staff always read `current`. */
export type StudentStatus = 'current' | 'graduated' | 'other';

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  current: 'Current',
  graduated: 'Graduated',
  other: 'Other',
};

export const STUDENT_STATUSES = Object.keys(STUDENT_STATUS_LABELS) as StudentStatus[];

export function isStudentStatus(value: unknown): value is StudentStatus {
  return typeof value === 'string' && value in STUDENT_STATUS_LABELS;
}

/**
 * One person in the directory, exactly as `app_person_json` returns them.
 *
 * Carries a home address and a guardian's phone number, so it is only ever
 * loaded by an active account. `version` is the optimistic lock: a form must
 * send back the version it read, or the save is refused.
 */
export interface Person {
  id: string;
  kind: PersonKind;
  displayName: string;
  /** OSIS for a student; the staff id derived from the email for staff. */
  externalId: string;
  firstName: string;
  lastName: string;
  email: string;
  schoolDbn: string;
  department: string;
  staffRole: string;
  classOf: string;
  studentStatus: StudentStatus;
  officialClass: string;
  guardianName: string;
  guardianPhone: string;
  homePhone: string;
  address: string;
  notes: string;
  /**
   * When they left the school, or null while they are still here.
   *
   * Students also carry `studentStatus`, which says graduated or other; this is
   * the one field that means the same thing for a member of staff. Today's
   * "devices due back" reads it to raise a machine whose holder has gone.
   */
  archivedAt: string | null;
  version: number;
  updatedAt: string;
  /** Machines assigned to them right now. */
  deviceCount: number;
}

/**
 * A directory list row. The owner's `app_list_people` returns whole person
 * records rather than a narrower row, so a list entry and a detail record are
 * the same shape and nothing has to be re-fetched to open one.
 */
export type PersonSummary = Person;

/**
 * What a person's page may change. `id`, `version`, `updatedAt` and
 * `deviceCount` are the database's to set; `kind` is fixed once the record
 * exists, because a student does not become a member of staff.
 *
 * `archivedAt` becomes `archived`, because nobody types the moment somebody
 * left: a form ticks a box and `app_save_person` stamps the time. Ticking a box
 * that is already ticked leaves the original date where it is.
 */
export type PersonInput = Omit<
  Person,
  'id' | 'version' | 'updatedAt' | 'deviceCount' | 'archivedAt'
> & { archived: boolean };

/**
 * An inventory status.
 *
 * Deliberately a plain string. `inventory_devices.status` has no CHECK
 * constraint: the vocabulary is whatever the district has written, and
 * `app_inventory_statuses()` is the authority on what to offer — every value
 * in use, plus the five it seeds. A closed union here would quietly drop the
 * statuses the real inventory already carries.
 */
export type DeviceStatus = string;

/** What `app_inventory_statuses()` seeds, for a screen that has not loaded it yet. */
export const SEED_DEVICE_STATUSES: DeviceStatus[] = [
  'Available',
  'Assigned',
  'In repair',
  'Retired',
  'Lost',
];

/** The status app_assign_inventory_device sets, and the one it clears to. */
export const ASSIGNED_STATUS = 'Assigned';
export const AVAILABLE_STATUS = 'Available';

/**
 * No database check constrains an assignment note; the RPCs cap it at 500
 * characters, and the form uses the same number so a note a person types is
 * never longer than one the database will take.
 */
export const DEVICE_NOTE_MAX = 500;

/** One machine in the inventory, exactly as `app_inventory_device_json` returns it. */
export interface Device {
  id: string;
  /** The inventory's own identifier, e.g. `DEV-4F2A9C1B77E0`. Never empty. */
  externalId: string;
  deviceType: string;
  manufacturer: string;
  model: string;
  osVersion: string;
  serialNumber: string;
  assetTag: string;
  status: DeviceStatus;
  location: string;
  notes: string;
  /** Null when nobody is holding it. */
  assignedRequesterId: string | null;
  assignedName: string | null;
  assignedKind: PersonKind | null;
  version: number;
  updatedAt: string;
}

export type DeviceSummary = Device;

/** What a device's page may change. The external id is generated on save. */
export type DeviceInput = Omit<
  Device,
  'id' | 'externalId' | 'assignedName' | 'assignedKind' | 'version' | 'updatedAt'
>;

/** One entry in the device catalogue: the tuples intake and the editor offer. */
export interface DeviceCatalogEntry {
  deviceType: string;
  manufacturer: string;
  model: string;
}

/** A ticket named on a person's or a device's page: enough to link to it. */
export interface RecordTicketRef {
  id: string;
  number: string;
  title: string;
  status: TicketStatus;
  createdAt: string;
}

/**
 * One line of a directory or inventory record's history (`record_events`).
 *
 * `actorId` is null when a trusted server flow made the change rather than a
 * person in their own session. Detail text never carries a link or a token.
 */
export interface RecordEvent {
  id: string;
  entityType: 'requester' | 'inventory_device' | 'invite' | 'import' | 'account';
  entityId: string;
  kind: string;
  actorId: AccountId | null;
  performedVia: PerformedVia;
  aiModel: string | null;
  at: string;
  summary: string;
  detail: string | null;
}

export interface PersonDetail {
  person: Person;
  /** The machines they are holding now. */
  devices: Device[];
  /** The tickets they asked for that the viewer may see, newest first. */
  tickets: RecordTicketRef[];
  /** Newest first. */
  events: RecordEvent[];
}

export interface DeviceDetail {
  device: Device;
  /** The tickets naming this machine that the viewer may see, newest first. */
  tickets: RecordTicketRef[];
  /** Newest first. */
  events: RecordEvent[];
}

/**
 * How a machine is named everywhere: asset tag first, because that is the
 * label stuck on the lid; then the serial; then the inventory's own external
 * id. The same order as `app_device_label` in the database, so a machine reads
 * the same way on screen as it does in the history.
 */
export function deviceLabel(device: {
  assetTag?: string | null;
  serialNumber?: string | null;
  externalId?: string | null;
}): string {
  return (
    nonBlank(device.assetTag) ??
    nonBlank(device.serialNumber) ??
    nonBlank(device.externalId) ??
    'Unlabelled device'
  );
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
