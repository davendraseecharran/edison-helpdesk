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
 * Summaries are written by the database as "<name> did a thing" and are shown
 * as written. The one edit is for an action an assistant performed: when the
 * summary starts with the actor's exact name, that name is replaced by
 * `ActorLabel`, which reads "<name>'s AI did a thing". A summary that does
 * not start with the name (the account was renamed since) stays intact and
 * the attribution follows it in parentheses.
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
        const byAi = event.performedVia === 'ai';
        const prefixed = byAi && event.summary.startsWith(`${name} `);
        return (
          <li key={event.id} className="timeline-item" data-kind={event.kind}>
            <span className="timeline-dot" aria-hidden="true" />
            <div className="timeline-body">
              <div className="timeline-head">
                <span className="timeline-summary">
                  {prefixed ? (
                    <>
                      <ActorLabel
                        name={name}
                        via="ai"
                        model={event.aiModel}
                        className="timeline-actor"
                      />
                      {event.summary.slice(name.length)}
                    </>
                  ) : (
                    event.summary
                  )}
                  {byAi && !prefixed ? (
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
