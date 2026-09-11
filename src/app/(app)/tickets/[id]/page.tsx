import Link from 'next/link';
import { CHANNEL_LABELS } from '@/lib/domain/types';
import { loadDirectory, loadTicketDetail } from '@/lib/data/tickets';
import { formatDateKey, formatDateTime, toDateKey } from '@/lib/format';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { ChannelBadge, PriorityBadge, StatusBadge } from '@/components/Badges';
import { ActivityTimeline } from '@/components/ticket/ActivityTimeline';
import { AdminActionsPanel } from '@/components/ticket/AdminActionsPanel';
import { DevicePanel } from '@/components/ticket/DevicePanel';
import { NotesPanel } from '@/components/ticket/NotesPanel';
import { OwnershipPanel } from '@/components/ticket/OwnershipPanel';
import { ProgressPanel } from '@/components/ticket/ProgressPanel';
import { ResolvePanel } from '@/components/ticket/ResolvePanel';
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
      <div className="card">
        <EmptyState
          title="Ticket not available"
          action={
            <Link className="btn" href="/queue">
              Back to the Open Queue
            </Link>
          }
        >
          This ticket does not exist, or it belongs to work you are not part of. Technicians see the
          open queue plus the tickets they own or collaborate on.
        </EmptyState>
      </div>
    );
  }

  const { ticket, requester } = detail;

  return (
    <>
      <div className="page-header">
        <div className="page-header-text">
          <div className="row small" style={{ marginBottom: 6 }}>
            <Link href="/queue">Open Queue</Link>
            <span className="subtle">/</span>
            <span className="mono">{ticket.number}</span>
          </div>
          <h1>{ticket.title}</h1>
          <div className="row" style={{ marginTop: 8 }}>
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            <ChannelBadge channel={ticket.channel} />
            <span className="small subtle">
              Opened <TimeAgo iso={ticket.createdAt} />
            </span>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <div className="card-header">
              <h2>Request</h2>
            </div>
            <div className="card-body stack">
              <dl className="facts">
                <dt>Requester</dt>
                <dd>
                  {ticket.requesterUnknown ? (
                    <span className="muted">Unknown — explicitly recorded as unidentified</span>
                  ) : (
                    <>
                      {requester?.displayName ?? 'Unknown'}
                      {requester?.descriptor ? (
                        <span className="muted"> · {requester.descriptor}</span>
                      ) : null}
                    </>
                  )}
                </dd>

                <dt>Location</dt>
                <dd>
                  {ticket.isRemote
                    ? 'Remote — no physical location'
                    : (ticket.location ?? 'Unknown')}
                </dd>

                <dt>Submitted</dt>
                <dd>
                  {formatDateKey(ticket.submittedOn)}
                  {/* Compare against the school-local creation date, not the UTC slice. */}
                  {ticket.submittedOn !== toDateKey(new Date(ticket.createdAt)) ? (
                    <span className="muted small">
                      {' '}
                      · backdated; recorded {formatDateTime(ticket.createdAt)}
                    </span>
                  ) : null}
                </dd>

                <dt>Recorded by</dt>
                <dd>
                  {detail.creator?.displayName ?? 'Unknown'}{' '}
                  <span className="muted small">
                    · {CHANNEL_LABELS[ticket.channel]} · {formatDateTime(ticket.createdAt)}
                  </span>
                </dd>
              </dl>

              <div>
                <p className="small subtle" style={{ marginBottom: 4 }}>
                  Issue as reported
                </p>
                <p className="note-body">{ticket.issue}</p>
              </div>
            </div>
          </div>

          <DevicePanel detail={detail} />
          <NotesPanel detail={detail} />
          <ResolvePanel detail={detail} />

          <div className="card">
            <div className="card-header">
              <h2>Activity history</h2>
              <span className="small subtle">{detail.activity.length} events</span>
            </div>
            <div className="card-body">
              <ActivityTimeline events={detail.activity} />
            </div>
          </div>
        </div>

        <div>
          <OwnershipPanel detail={detail} />
          <ProgressPanel detail={detail} />
          <TimePanel detail={detail} />
          <AdminActionsPanel key={`${ticket.id}:${ticket.ownerId}`} detail={detail} />
        </div>
      </div>
    </>
  );
}
