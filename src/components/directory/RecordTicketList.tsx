'use client';

/**
 * The tickets a person asked for, or that name a device: live ones first,
 * then the most recent closed ones. Each row links to the ticket. The list is
 * viewer-relative (only tickets the account may see are here), which the
 * heading beside it says for technicians.
 */

import Link from 'next/link';
import type { RecordTicketRef } from '@/lib/domain/types';
import { splitRecordTickets } from '@/lib/domain/records';
import { StatusBadge } from '@/components/Badges';
import { TimeAgo } from '@/components/Primitives';

function TicketRows({ tickets }: { tickets: RecordTicketRef[] }) {
  return (
    <ul className="record-tickets">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="record-ticket">
          <Link href={`/tickets/${ticket.id}`} className="record-ticket-link">
            <span className="record-ticket-number mono">{ticket.number}</span>
            <span className="record-ticket-title">{ticket.title}</span>
          </Link>
          <span className="record-ticket-end">
            <StatusBadge status={ticket.status} />
            <span className="record-ticket-time">
              <TimeAgo iso={ticket.createdAt} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RecordTicketList({ tickets, emptyText }: {
  tickets: RecordTicketRef[];
  emptyText: string;
}) {
  const { open, recent } = splitRecordTickets(tickets);
  if (open.length === 0 && recent.length === 0) {
    return <p className="panel-empty">{emptyText}</p>;
  }
  return (
    <div className="stack-sm">
      {open.length > 0 ? (
        <div className="stack-xs">
          <p className="people-label">Open</p>
          <TicketRows tickets={open} />
        </div>
      ) : null}
      {recent.length > 0 ? (
        <div className="stack-xs">
          <p className="people-label">Recent</p>
          <TicketRows tickets={recent} />
        </div>
      ) : null}
    </div>
  );
}
