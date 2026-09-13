/**
 * Status, priority, channel and role badges.
 *
 * Colour is never the only signal: a status is a coloured dot beside its text
 * label, and a priority is a glyph beside its label, so High and Urgent stay
 * distinguishable in greyscale and to a screen reader.
 */

import {
  type AccountStatus,
  type DeviceStatus,
  type IntakeChannel,
  type PersonKind,
  type Priority,
  type Role,
  type TicketStatus,
  ACCOUNT_STATUS_LABELS,
  CHANNEL_LABELS,
  DEVICE_STATUS_LABELS,
  PERSON_KIND_LABELS,
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/domain/types';

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`badge badge-status status-${status}`}>
      <span className="badge-dot" aria-hidden="true" />
      {TICKET_STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_GLYPH: Record<Priority, string> = {
  low: '▽',
  normal: '–',
  high: '▲',
  urgent: '▲▲',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`badge badge-priority priority-${priority}`}>
      <span className="badge-glyph" aria-hidden="true">
        {PRIORITY_GLYPH[priority]}
      </span>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: IntakeChannel }) {
  return <span className="badge badge-chip">{CHANNEL_LABELS[channel]}</span>;
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={role === 'admin' ? 'badge badge-chip badge-role' : 'badge badge-chip'}>
      {role === 'admin' ? 'Administrator' : 'Technician'}
    </span>
  );
}

const ACCOUNT_STATUS_TONE: Record<AccountStatus, string> = {
  active: 'status-resolved',
  setup_pending: 'status-waiting',
  // A request nobody has answered yet is live work for an administrator, so it
  // carries the same tone as an unclaimed ticket rather than a warning.
  pending_approval: 'status-open',
  inactive: 'status-cancelled',
  denied: 'status-cancelled',
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return (
    <span className={`badge badge-status ${ACCOUNT_STATUS_TONE[status]}`}>
      <span className="badge-dot" aria-hidden="true" />
      {ACCOUNT_STATUS_LABELS[status]}
    </span>
  );
}

export function SimulatedBadge({ children = 'Simulated' }: { children?: string }) {
  return <span className="badge badge-chip badge-simulated">{children}</span>;
}

/**
 * Inventory status: a coloured dot beside its label. Deployed is the working
 * state and sits in the signal blue; in stock is ready and green; in repair is
 * the amber of waiting; retired and surplus are slate; lost is the one red.
 */
export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <span className={`badge badge-status device-${status}`}>
      <span className="badge-dot" aria-hidden="true" />
      {DEVICE_STATUS_LABELS[status]}
    </span>
  );
}

export function PersonKindBadge({ kind }: { kind: PersonKind }) {
  return <span className="badge badge-chip">{PERSON_KIND_LABELS[kind]}</span>;
}

/** A record that has left the directory listing but stays on its tickets and devices. */
export function ArchivedBadge() {
  return <span className="badge badge-chip badge-archived">Archived</span>;
}
