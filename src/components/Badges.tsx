/**
 * Status, priority, channel and role badges.
 *
 * Colour is never the only signal: each badge always renders its text label, and
 * priority adds a glyph so High/Urgent are distinguishable in greyscale.
 */

import {
  type AccountStatus,
  type IntakeChannel,
  type Priority,
  type Role,
  type TicketStatus,
  ACCOUNT_STATUS_LABELS,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/domain/types';

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`badge badge-dot status-${status}`}>{TICKET_STATUS_LABELS[status]}</span>
  );
}

const PRIORITY_GLYPH: Record<Priority, string> = {
  low: '↓',
  normal: '',
  high: '▲',
  urgent: '▲▲',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  const glyph = PRIORITY_GLYPH[priority];
  return (
    <span className={`badge priority-${priority}`}>
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: IntakeChannel }) {
  return <span className="badge badge-neutral">{CHANNEL_LABELS[channel]}</span>;
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={role === 'admin' ? 'badge badge-role' : 'badge badge-neutral'}>
      {role === 'admin' ? 'Administrator' : 'Technician'}
    </span>
  );
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const className =
    status === 'active'
      ? 'badge badge-dot status-resolved'
      : status === 'setup_pending'
        ? 'badge badge-dot status-waiting'
        : 'badge badge-dot badge-neutral';
  return <span className={className}>{ACCOUNT_STATUS_LABELS[status]}</span>;
}

export function SimulatedBadge({ children = 'Simulated' }: { children?: string }) {
  return <span className="badge badge-simulated">{children}</span>;
}
