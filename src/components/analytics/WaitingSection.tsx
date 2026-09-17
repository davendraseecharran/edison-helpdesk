import { percentOf, type Waiting } from '@/lib/domain/analytics';
import { Bars } from './charts/Bars';
import { hoursOr } from './format';
import { Section } from './Section';

/** Tickets that stopped for something before they could be resolved. */
export function WaitingSection({ waiting }: { waiting: Waiting }) {
  return (
    <Section
      id="waiting"
      title="Waiting"
      note="Resolved tickets that spent time waiting for a reply, a part or a vendor, and what they were waiting for."
    >
      {waiting.ticketsWaited === 0 ? (
        <p className="analytics-quiet">Nothing resolved in this period had to wait.</p>
      ) : (
        <>
          <dl className="stat-strip">
            <div>
              <dt>Tickets that waited</dt>
              <dd>{waiting.ticketsWaited}</dd>
            </div>
            <div>
              <dt>Share of resolutions</dt>
              <dd>{percentOf(waiting.share)}</dd>
            </div>
            <div>
              <dt>Median wait</dt>
              <dd>{hoursOr(waiting.medianWaitHours)}</dd>
            </div>
          </dl>
          {waiting.reasons.length > 0 ? (
            <Bars
              describe="Reasons tickets waited"
              labelWidth={150}
              rows={waiting.reasons.map((entry) => ({
                key: entry.reason,
                label: entry.reason,
                value: entry.count,
                cells: [{ key: 'Tickets', content: entry.count, width: 44 }],
              }))}
            />
          ) : null}
        </>
      )}
    </Section>
  );
}
