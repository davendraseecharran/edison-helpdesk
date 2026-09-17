import Link from 'next/link';
import { HARD_SCORE_NOTE, type HardTicket } from '@/lib/domain/analytics';
import { formatHours } from '@/lib/domain/resolved-stats';
import { TICKET_CATEGORY_LABELS } from '@/lib/domain/types';
import { PriorityBadge } from '@/components/Badges';
import { Section } from './Section';

/**
 * The eight hardest tickets of the period. A ticket the reader may not open
 * is still on the list — the desk did the work — but carries no number and
 * no name.
 */
export function HardestSection({ hardest }: { hardest: HardTicket[] }) {
  return (
    <Section id="hardest" title="Hardest tickets" note={HARD_SCORE_NOTE}>
      {hardest.length === 0 ? (
        <p className="analytics-quiet">Nothing resolved in this period yet.</p>
      ) : (
        <ol className="hard-list">
          {hardest.slice(0, 8).map((ticket, i) => (
            <li key={ticket.ticketId} className="hard-row">
              <span className="hard-rank">{i + 1}</span>
              <div className="hard-text">
                {ticket.number !== null && ticket.title !== null ? (
                  <span className="hard-title">
                    <Link href={`/tickets/${ticket.ticketId}`}>
                      <span className="hard-number">{ticket.number}</span>
                      {ticket.title}
                    </Link>
                  </span>
                ) : (
                  <span className="hard-title" data-hidden="">
                    A colleague&apos;s ticket
                  </span>
                )}
                <span className="hard-meta">
                  <PriorityBadge priority={ticket.priority} />
                  <span>{TICKET_CATEGORY_LABELS[ticket.category]}</span>
                  {ticket.resolverName ? <span>Resolved by {ticket.resolverName}</span> : null}
                </span>
              </div>
              <div className="hard-figures">
                <div className="hard-figure">
                  {formatHours(ticket.hours)}
                  <span>open</span>
                </div>
                <div className="hard-figure">
                  {ticket.fromClaimHours === null ? '—' : formatHours(ticket.fromClaimHours)}
                  <span>from claim</span>
                </div>
                <div className="hard-figure">
                  {ticket.hands}
                  <span>{ticket.hands === 1 ? 'person' : 'people'}</span>
                </div>
                <div className="hard-figure hard-score">
                  {ticket.score.toFixed(1)}
                  <span>score</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
