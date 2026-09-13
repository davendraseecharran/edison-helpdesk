'use client';

/**
 * The history of a directory or inventory record, newest first.
 *
 * Summaries are written by the database as a plain statement ("Assigned to
 * Amara Whitfield.") rather than as "<name> did a thing", so the actor is
 * shown on a line of their own through `ActorLabel`, which also carries the
 * AI attribution when an assistant made the change. A null actor is a
 * trusted server flow, and is named as such rather than as nobody.
 *
 * A created or updated event's detail is the list of column names the
 * database touched (never their values, since this history is readable by
 * every technician and the fields include home addresses). It is shown in
 * plain words; any other detail is shown as written.
 */

function detailOf(event: RecordEvent): string | null {
  if (event.kind === 'created' || event.kind === 'updated') {
    const fields = describeFieldList(event.detail);
    if (fields) return `${event.kind === 'created' ? 'Recorded' : 'Changed'} ${fields}.`;
  }
  return event.detail;
}

import type { RecordEvent } from '@/lib/domain/types';
import { describeFieldList } from '@/lib/domain/records';
import { nameOf } from '@/lib/directory';
import { useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';

export function RecordHistory({ events, emptyText = 'No history recorded yet.' }: {
  events: RecordEvent[];
  emptyText?: string;
}) {
  const { directory } = useRuntime();

  if (events.length === 0) {
    return <p className="panel-empty">{emptyText}</p>;
  }

  return (
    <ol className="timeline">
      {events.map((event) => {
        const detail = detailOf(event);
        return (
        <li key={event.id} className="timeline-item" data-kind={event.kind}>
          <span className="timeline-dot" aria-hidden="true" />
          <div className="timeline-body">
            <div className="timeline-head">
              <span className="timeline-summary">{event.summary}</span>
              <span className="timeline-time">
                <TimeAgo iso={event.at} />
              </span>
            </div>
            <div className="timeline-by">
              {event.actorId ? (
                <ActorLabel
                  name={nameOf(directory, event.actorId)}
                  via={event.performedVia}
                  model={event.aiModel}
                />
              ) : (
                'The system'
              )}
            </div>
            {detail ? <div className="timeline-detail">{detail}</div> : null}
          </div>
        </li>
        );
      })}
    </ol>
  );
}
