import { percentOf, type Bucket, type CategoryStat } from '@/lib/domain/analytics';
import { TICKET_CATEGORY_LABELS } from '@/lib/domain/types';
import { Bars } from './charts/Bars';
import { Sparkline } from './charts/Sparkline';
import { count, hoursOr } from './format';
import { Section } from './Section';

/** What the desk resolves, kind by kind. */
export function IssuesSection({
  categories,
  bucket,
}: {
  categories: CategoryStat[];
  bucket: Bucket;
}) {
  const resolved = [...categories]
    .filter((stat) => stat.resolved > 0)
    .sort((a, b) => b.resolved - a.resolved);
  const unresolved = categories.filter((stat) => stat.resolved === 0 && stat.created > 0);

  return (
    <Section
      id="issues"
      title="Common issues"
      note="What was resolved, by category, with how long each kind takes and how it ran over the period."
    >
      {resolved.length === 0 ? (
        <p className="analytics-quiet">Nothing resolved in this period yet.</p>
      ) : (
        <Bars
          describe="Resolved tickets by category"
          labelWidth={160}
          rows={resolved.map((stat) => ({
            key: stat.category,
            label: TICKET_CATEGORY_LABELS[stat.category],
            value: stat.resolved,
            title: `${TICKET_CATEGORY_LABELS[stat.category]}: ${count(stat.resolved, 'resolution')} of ${count(stat.created, 'ticket')} created`,
            cells: [
              { key: 'Resolved', content: stat.resolved, width: 56 },
              { key: 'Share', content: percentOf(stat.share), width: 44 },
              { key: 'Median', content: hoursOr(stat.medianHours), width: 56 },
              {
                key: 'Trend',
                width: 72,
                content: (
                  <Sparkline
                    values={stat.trend}
                    title={`Resolved per ${bucket}, earliest first: ${stat.trend.join(', ')}`}
                  />
                ),
              },
            ],
          }))}
        />
      )}
      {unresolved.length > 0 ? (
        <p className="analytics-quiet">
          No resolutions yet for{' '}
          {unresolved
            .map((stat) => `${TICKET_CATEGORY_LABELS[stat.category]} (${count(stat.created, 'ticket')} created)`)
            .join(', ')}
          .
        </p>
      ) : null}
    </Section>
  );
}
