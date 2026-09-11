'use client';

import type { ActivityEvent } from '@/lib/domain/types';
import { TimeAgo } from '@/components/Primitives';

/**
 * Chronological history. Detail text is shown for reasons, notes and solutions;
 * credentials such as setup or recovery links are never recorded here.
 */
export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return <p className="small muted">No activity recorded yet.</p>;
  }

  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id} data-kind={event.kind}>
          <div className="timeline-head">
            <span className="timeline-summary">{event.summary}</span>
            <span className="timeline-time">
              <TimeAgo iso={event.at} />
            </span>
          </div>
          {event.detail ? <div className="timeline-detail">{event.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
