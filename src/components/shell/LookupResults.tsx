'use client';

import { Command } from 'cmdk';
import { Laptop, Ticket, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/Badges';
import { Icon, type LucideIcon } from '@/components/ui/Icon';
import { TICKET_STATUS_LABELS, type TicketStatus } from '@/lib/domain/types';
import {
  splitTicketTitle,
  type GroupedHits,
  type RecentItem,
  type SearchHit,
  type SearchKind,
} from '@/lib/data/search';

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  ticket: Ticket,
  person: User,
  device: Laptop,
};

const KIND_LABEL: Record<SearchKind, string> = {
  ticket: 'Ticket',
  person: 'Person',
  device: 'Device',
};

/** A command the palette offers beside the records it finds. */
export interface LookupAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Words that also match, beyond the label. */
  keywords: string[];
  subtitle?: ReactNode;
  meta?: ReactNode;
  /** Shown whatever was typed; the filter does not apply. */
  always?: boolean;
  run: () => void | Promise<void>;
}

/** The value cmdk tracks selection by; unique across records and actions. */
export function hitValue(hit: Pick<SearchHit, 'kind' | 'id'>): string {
  return `${hit.kind}:${hit.id}`;
}

export function actionValue(action: Pick<LookupAction, 'id'>): string {
  return `action:${action.id}`;
}

function Row({
  icon,
  title,
  subtitle,
  meta,
}: {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <>
      <span className="palette-item-icon">
        <Icon icon={icon} size={16} />
      </span>
      <span className="palette-item-text">
        <span className="palette-item-title">{title}</span>
        {subtitle ? <span className="palette-item-subtitle">{subtitle}</span> : null}
      </span>
      {meta ? <span className="palette-item-meta">{meta}</span> : null}
    </>
  );
}

/**
 * The status a ticket hit's meta names, or null.
 *
 * `app_search` renders its meta column as the label the interface shows
 * ("In progress"), so the badge is derived from the label; the raw key is
 * accepted too, so a row from an older build still gets its badge.
 */
export function ticketStatusFromMeta(meta: string): TicketStatus | null {
  for (const [status, label] of Object.entries(TICKET_STATUS_LABELS) as Array<[TicketStatus, string]>) {
    if (meta === label || meta === status) return status;
  }
  return null;
}

/** The title of a hit, with its identifier in mono where it carries one. */
function hitTitle(hit: SearchHit): ReactNode {
  if (hit.kind === 'ticket') {
    const { number, rest } = splitTicketTitle(hit.title);
    if (!number) return hit.title;
    return (
      <>
        <span className="mono palette-item-id">{number}</span>
        {rest}
      </>
    );
  }
  if (hit.kind === 'device') return <span className="mono">{hit.title}</span>;
  return hit.title;
}

/** What sits on the right: a status badge for a ticket, the identifier for a person, the state for a device. */
function hitMeta(hit: SearchHit): ReactNode {
  if (!hit.meta) return null;
  if (hit.kind === 'ticket') {
    const status = ticketStatusFromMeta(hit.meta);
    return status ? <StatusBadge status={status} /> : hit.meta;
  }
  if (hit.kind === 'person') return <span className="mono">{hit.meta}</span>;
  return hit.meta;
}

export function HitItem({ hit, onSelect }: { hit: SearchHit; onSelect: (hit: SearchHit) => void }) {
  return (
    <Command.Item value={hitValue(hit)} onSelect={() => onSelect(hit)}>
      <Row icon={KIND_ICON[hit.kind]} title={hitTitle(hit)} subtitle={hit.subtitle} meta={hitMeta(hit)} />
    </Command.Item>
  );
}

/** The three record groups, each rendered only when it has something to show. */
export function HitGroups({
  groups,
  onSelect,
}: {
  groups: GroupedHits;
  onSelect: (hit: SearchHit) => void;
}) {
  const sections: Array<[string, SearchHit[]]> = [
    ['Tickets', groups.tickets],
    ['People', groups.people],
    ['Devices', groups.devices],
  ];
  return (
    <>
      {sections.map(([heading, hits]) =>
        hits.length > 0 ? (
          <Command.Group key={heading} heading={heading}>
            {hits.map((hit) => (
              <HitItem key={hitValue(hit)} hit={hit} onSelect={onSelect} />
            ))}
          </Command.Group>
        ) : null,
      )}
    </>
  );
}

/** A remembered selection. It knows its kind and title, nothing more, so the kind is the meta. */
export function RecentRow({
  item,
  onSelect,
}: {
  item: RecentItem;
  onSelect: (item: RecentItem) => void;
}) {
  const title =
    item.kind === 'ticket' ? hitTitle({ ...item, subtitle: null, meta: null }) : item.kind === 'device' ? (
      <span className="mono">{item.title}</span>
    ) : (
      item.title
    );
  return (
    <Command.Item value={`recent:${hitValue(item)}`} onSelect={() => onSelect(item)}>
      <Row icon={KIND_ICON[item.kind]} title={title} meta={KIND_LABEL[item.kind]} />
    </Command.Item>
  );
}

export function ActionItem({ action }: { action: LookupAction }) {
  return (
    <Command.Item value={actionValue(action)} onSelect={() => void action.run()}>
      <Row icon={action.icon} title={action.label} subtitle={action.subtitle} meta={action.meta} />
    </Command.Item>
  );
}
