'use client';

import type { ActivityEvent } from '@/lib/domain/types';
import { nameOf } from '@/lib/directory';
import { useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';

/**
 * Chronological history. Detail text is shown for reasons, notes and solutions;
 * credentials such as setup or recovery links are never recorded here.
 *
 * Summaries are written by the database as "<name> did a thing". The name is
 * split off and rendered through `ActorLabel`, which is what turns an action an
 * assistant performed into "<name>'s AI did a thing".
 */
export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  const { directory } = useRuntime();

  if (events.length === 0) {
    return <p className="panel-empty">No activity recorded yet.</p>;
  }

  return (
    <ol className="timeline">
      {events.map((event) => {
        const name = nameOf(directory, event.actorId);
        const prefixed = event.summary.startsWith(`${name} `);
        const rest = prefixed ? event.summary.slice(name.length) : event.summary;
        return (
          <li key={event.id} className="timeline-item" data-kind={event.kind}>
            <span className="timeline-dot" aria-hidden="true" />
            <div className="timeline-body">
              <div className="timeline-head">
                <span className="timeline-summary">
                  {prefixed ? (
                    <ActorLabel
                      name={name}
                      via={event.performedVia}
                      model={event.aiModel}
                      className="timeline-actor"
                    />
                  ) : null}
                  {rest}
                  {!prefixed && event.performedVia === 'ai' ? (
                    <>
                      {' '}
                      (<ActorLabel name={name} via="ai" model={event.aiModel} />)
                    </>
                  ) : null}
                </span>
                <span className="timeline-time">
                  <TimeAgo iso={event.at} />
                </span>
              </div>
              {event.detail ? <div className="timeline-detail">{event.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
