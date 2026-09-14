import type { TicketDetailView } from '@/lib/data/tickets';
import { TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';

/**
 * The recorded outcome: the solution of a resolved ticket, the previous
 * solution kept on a reopened one, or the reason a ticket was cancelled.
 * Rendered only when there is something to show.
 */
export function SolutionPanel({ detail }: { detail: TicketDetailView }) {
  const ticket = detail.ticket;
  const resolved = ticket.status === 'resolved';
  const cancelled = ticket.status === 'cancelled';
  if (!ticket.solution && !cancelled) return null;

  return (
    <section className="panel" aria-labelledby={`solution-heading-${ticket.id}`}>
      <div className="panel-head">
        <h2 className="panel-title" id={`solution-heading-${ticket.id}`}>
          {cancelled ? 'Cancelled' : resolved ? 'Solution' : 'Previous solution'}
        </h2>
        {resolved && detail.resolver ? (
          <span className="panel-aside">
            Resolved by{' '}
            <ActorLabel
              name={detail.resolver.displayName}
              via={ticket.resolvedVia}
              model={ticket.resolvedAiModel}
            />
            {ticket.resolvedAt ? (
              <>
                {' '}
                <TimeAgo iso={ticket.resolvedAt} />
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="panel-body stack-sm">
        {cancelled ? (
          <p className="callout callout-warn">
            <strong>Cancelled.</strong> {ticket.cancelReason} A cancellation is not a resolution.
          </p>
        ) : null}

        {ticket.solution ? (
          <div className={resolved ? 'solution' : 'solution solution-previous'}>
            {!resolved ? (
              <span className="solution-label">Kept from before the ticket was reopened</span>
            ) : null}
            {ticket.solution}
          </div>
        ) : null}

        {resolved ? (
          <p className="panel-note">
            {detail.owner
              ? `${detail.owner.displayName} stays recorded as the owner.`
              : 'Resolved without an owner.'}
            {detail.time.recorded ? '' : ' No time was recorded, which is not the same as zero minutes.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
