import { Clock, User } from 'lucide-react';
import { CHANNEL_LABELS } from '@/lib/domain/types';
import { loadDirectory, loadTicketDetail } from '@/lib/data/tickets';
import { formatDateKey, formatDateTime, toDateKey } from '@/lib/format';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel';
import { PriorityBadge, StatusBadge } from '@/components/Badges';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ActivityTimeline } from '@/components/ticket/ActivityTimeline';
import { AdminActionsPanel } from '@/components/ticket/AdminActionsPanel';
import { CategoryFact } from '@/components/ticket/CategoryFact';
import { DevicePanel } from '@/components/ticket/DevicePanel';
import { LinkedDevicesPanel } from '@/components/ticket/LinkedDevicesPanel';
import { NotesPanel } from '@/components/ticket/NotesPanel';
import { OwnershipPanel } from '@/components/ticket/OwnershipPanel';
import { ProgressPanel } from '@/components/ticket/ProgressPanel';
import { ResolvePanel } from '@/components/ticket/ResolvePanel';
import { SolutionPanel } from '@/components/ticket/SolutionPanel';
import { TicketActionBar } from '@/components/ticket/TicketActionBar';
import { TimePanel } from '@/components/ticket/TimePanel';

export const metadata = { title: 'Ticket — Edison Helpdesk' };

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const directory = await loadDirectory();
  const detail = await loadTicketDetail(id, directory);

  if (!detail) {
    // Identical whether the ticket is missing or simply not visible to this
    // account — including for a former owner who has lost access after someone
    // else claimed the ticket they returned.
    return (
      <div className="panel">
        <EmptyState
          title="Ticket not available"
          action={<ButtonLink href="/queue">Back to the queue</ButtonLink>}
        >
          This ticket does not exist, or it belongs to work you are not part of. Technicians see
          the queue plus the tickets they own or collaborate on.
        </EmptyState>
      </div>
    );
  }

  const { ticket, requester } = detail;
  const requesterName = ticket.requesterUnknown
    ? 'Requester unknown'
    : (requester?.displayName ?? 'Unknown');
  // Compare against the school-local creation date, not the UTC slice.
  const backdated = ticket.submittedOn !== toDateKey(new Date(ticket.createdAt));

  return (
    <div
      className="ticket"
      data-page-kind="ticket"
      data-page-id={ticket.id}
      data-page-label={ticket.number}
    >
      <header className="ticket-head">
        <div className="ticket-head-text">
          <span className="ticket-number mono">{ticket.number}</span>
          <h1 className="ticket-title">{ticket.title}</h1>
          <div className="ticket-meta">
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            <span className="ticket-meta-item">
              <Icon icon={Clock} size={14} />
              <span>
                Opened <TimeAgo iso={ticket.createdAt} />
              </span>
            </span>
            <span className="ticket-meta-item">
              <Icon icon={User} size={14} />
              <span>{requesterName}</span>
            </span>
          </div>
        </div>
      </header>

      <div className="ticket-grid">
        <div className="ticket-column">
          <SolutionPanel detail={detail} />

          <section className="panel" aria-labelledby="issue-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="issue-heading">
                Issue as reported
              </h2>
              <span className="panel-aside">{CHANNEL_LABELS[ticket.channel]}</span>
            </div>
            <div className="panel-body">
              <p className="ticket-issue">{ticket.issue}</p>
            </div>
          </section>

          <NotesPanel detail={detail} />
          {/* Under the notes, because a photograph of a cracked screen is the
              same kind of contribution: what somebody saw, recorded against the
              ticket. Anyone who can read the ticket sees the files; only a
              contributor is offered the upload control, and the database
              decides which of those this is. */}
          <AttachmentsPanel ticketId={ticket.id} />
          {/* Inventory machines first, then what a technician wrote down: the
              link is the stronger statement, and the observation may describe a
              machine the inventory has never heard of. */}
          <LinkedDevicesPanel detail={detail} />
          <DevicePanel detail={detail} />

          <section className="panel" aria-labelledby="activity-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="activity-heading">
                Activity
              </h2>
              <span className="panel-aside">
                {detail.activity.length} {detail.activity.length === 1 ? 'event' : 'events'}
              </span>
            </div>
            <div className="panel-body">
              <ActivityTimeline events={detail.activity} />
            </div>
          </section>
        </div>

        <div className="ticket-column">
          <section className="panel" aria-labelledby="details-heading">
            <div className="panel-head">
              <h2 className="panel-title" id="details-heading">
                Details
              </h2>
            </div>
            <div className="panel-body">
              <dl className="facts">
                <dt>Requester</dt>
                <dd>
                  {ticket.requesterUnknown ? (
                    <span className="muted">Unknown, recorded as unidentified</span>
                  ) : (
                    <>
                      {requester?.displayName ?? 'Unknown'}
                      {requester?.descriptor ? (
                        <span className="facts-sub">{requester.descriptor}</span>
                      ) : null}
                    </>
                  )}
                </dd>

                <CategoryFact detail={detail} />

                <dt>Channel</dt>
                <dd>{CHANNEL_LABELS[ticket.channel]}</dd>

                <dt>Location</dt>
                <dd>
                  {ticket.isRemote ? 'Remote, no physical location' : (ticket.location ?? 'Unknown')}
                </dd>

                <dt>Submitted</dt>
                <dd>
                  {formatDateKey(ticket.submittedOn)}
                  {backdated ? (
                    <span className="facts-sub">
                      Backdated. Recorded {formatDateTime(ticket.createdAt)}
                    </span>
                  ) : null}
                </dd>

                <dt>Recorded by</dt>
                <dd>
                  {detail.creator?.displayName ?? 'Unknown'}
                  <span className="facts-sub">{formatDateTime(ticket.createdAt)}</span>
                </dd>
              </dl>
            </div>
          </section>

          <OwnershipPanel detail={detail} />
          <ProgressPanel detail={detail} />
          <ResolvePanel detail={detail} />
          <TimePanel detail={detail} />
          <AdminActionsPanel key={`${ticket.id}:${ticket.ownerId}`} detail={detail} />
        </div>
      </div>

      <TicketActionBar detail={detail} />
    </div>
  );
}
