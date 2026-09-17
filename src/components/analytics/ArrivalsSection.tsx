import { hourLabel, WEEKDAY_LABELS, type Arrivals } from '@/lib/domain/analytics';
import { Columns } from './charts/Columns';
import { Heatmap } from './charts/Heatmap';
import { maxOf } from './charts/scale';
import { count } from './format';
import { Section } from './Section';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** When tickets arrive: by weekday, by hour, and both at once. */
export function ArrivalsSection({ arrivals }: { arrivals: Arrivals }) {
  const total = arrivals.byWeekday.reduce((sum, n) => sum + n, 0);
  const busiestDay = arrivals.byWeekday.indexOf(maxOf(arrivals.byWeekday));
  const busiestHour = arrivals.byHour.indexOf(maxOf(arrivals.byHour));

  return (
    <Section
      id="arrivals"
      title="When tickets arrive"
      note="By weekday, by hour of the day, and both together, in school time. Counted over tickets created in the period."
    >
      {total === 0 ? (
        <p className="analytics-quiet">Nothing was created in this period.</p>
      ) : (
        <>
          <div className="analytics-grid">
            <div className="analytics-block">
              <h3 className="analytics-block-title">By weekday</h3>
              <Columns
                labels={[...WEEKDAY_LABELS]}
                series={[{ key: 'weekday', label: 'Tickets', values: arrivals.byWeekday }]}
                slotTitles={arrivals.byWeekday.map(
                  (n, i) => `${WEEKDAY_LABELS[i]}: ${count(n, 'ticket')}`,
                )}
                describe="Tickets created by weekday"
                height={140}
                labelEvery={1}
                thick={7}
              />
            </div>
            <div className="analytics-block">
              <h3 className="analytics-block-title">By hour</h3>
              <Columns
                labels={HOURS.map(hourLabel)}
                series={[{ key: 'hour', label: 'Tickets', values: arrivals.byHour }]}
                slotTitles={arrivals.byHour.map((n, h) => `${hourLabel(h)}: ${count(n, 'ticket')}`)}
                describe="Tickets created by hour of the day"
                height={140}
                labelEvery={6}
                thick={2.6}
              />
            </div>
          </div>
          <div className="analytics-block">
            <h3 className="analytics-block-title">Weekday by hour</h3>
            <Heatmap
              rows={arrivals.heat}
              rowLabels={WEEKDAY_LABELS}
              columnLabel={hourLabel}
              cellTitle={(r, c, n) => `${WEEKDAY_LABELS[r]} ${hourLabel(c)}: ${count(n, 'ticket')}`}
              describe={`Tickets created by weekday and hour. Busiest: ${WEEKDAY_LABELS[busiestDay] ?? 'none'} around ${hourLabel(busiestHour)}.`}
            />
          </div>
        </>
      )}
    </Section>
  );
}
