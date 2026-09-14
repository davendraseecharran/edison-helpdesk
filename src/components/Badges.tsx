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
  type PersonKind,
  type Priority,
  type Role,
  type TicketStatus,
  ACCOUNT_STATUS_LABELS,
  PERSON_KIND_LABELS,
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/domain/types';
import { ACCOUNT_ROLES, ROLE_LABELS, type AccountRole } from '@/lib/auth/roles';

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

/**
 * One chip for the derived single-value role, where that is all a record
 * carries — a ticket's owner, for instance. `technician` is the internal
 * spelling of NetRider and is never shown as itself.
 */
export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={role === 'admin' ? 'badge badge-chip badge-role' : 'badge badge-chip'}>
      {role === 'admin' ? ROLE_LABELS.admin : ROLE_LABELS.netrider}
    </span>
  );
}

/** Every role an account holds, in a fixed order so a row never reshuffles. */
export function RoleBadges({ roles }: { roles: readonly AccountRole[] }) {
  return (
    <span className="role-badges">
      {ACCOUNT_ROLES.filter((role) => roles.includes(role)).map((role) => (
        <span
          key={role}
          className={role === 'admin' ? 'badge badge-chip badge-role' : 'badge badge-chip'}
        >
          {ROLE_LABELS[role]}
        </span>
      ))}
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

/**
 * Inventory status: a coloured dot beside its label.
 *
 * `inventory_devices.status` is free text with no CHECK constraint, so the
 * status IS the label and there is nothing to look up. The class name is the
 * status slugged, which gives the five seeded words their tone and leaves
 * anything the district invents on the default one — a word this application
 * has never seen is better plain than miscoloured.
 */
export function deviceStatusClass(status: DeviceStatus): string {
  const slug = status.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `device-${slug}` : 'device-no-status';
}

export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  const label = status.trim() || 'No status';
  return (
    <span className={`badge badge-status ${deviceStatusClass(label)}`}>
      <span className="badge-dot" aria-hidden="true" />
      {label}
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
