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
 * not chosen a password yet. Such accounts must not be able to reach ticket data
 * (enforced server-side in M3; here it only shapes the prototype's lists).
 */
export type AccountStatus = 'active' | 'inactive' | 'setup_pending';

export type IntakeChannel = 'walk_in' | 'email' | 'phone_call';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type TicketStatus =
  | 'open'
  | 'assigned'
  | 'in_progress'
  | 'waiting'
  | 'resolved'
  | 'cancelled';

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
}

export interface WorkNote {
  id: string;
  ticketId: TicketId;
  authorId: AccountId;
  body: string;
  createdAt: string;
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
  | 'cancelled';

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
  /** School-local submission date, backdatable by an admin (`YYYY-MM-DD`). */
  submittedOn: string;
  /** Actual creation timestamp. Backdating never rewrites this. */
  createdAt: string;
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

export const CHANNEL_LABELS: Record<IntakeChannel, string> = {
  walk_in: 'Walk-in',
  email: 'Email',
  phone_call: 'Phone call',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  setup_pending: 'Setup pending',
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
