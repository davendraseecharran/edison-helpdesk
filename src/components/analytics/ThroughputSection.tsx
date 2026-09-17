import { bucketLabel, type Bucket, type ThroughputPoint } from '@/lib/domain/analytics';
import { ChartLegend, Columns } from './charts/Columns';
import { Section } from './Section';

const BUCKET_WORD: Record<Bucket, string> = { day: 'day', week: 'week', month: 'month' };

/** What came in against what went out, slice by slice, and the queue that resulted. */
export function ThroughputSection({
  throughput,
  bucket,
}: {
  throughput: ThroughputPoint[];
  bucket: Bucket;
}) {
  const word = BUCKET_WORD[bucket];
  const labels = throughput.map((point) => bucketLabel(point.key, bucket));

  return (
    <Section
      id="throughput"
      title="Throughput"
      note={`Tickets created and resolved per ${word}, and how many were still open at the end of each. Cancellations are in neither.`}
    >
      {throughput.length === 0 ? (
        <p className="analytics-quiet">Nothing in this period yet.</p>
      ) : (
        <>
          <ChartLegend
            items={[
              { key: 'created', label: 'Created', kind: 'soft' },
              { key: 'resolved', label: 'Resolved', kind: 'ink' },
              { key: 'backlog', label: `Open at the end of the ${word}`, kind: 'line' },
            ]}
          />
          <Columns
            labels={labels}
            series={[
              {
                key: 'created',
                label: 'Created',
                values: throughput.map((point) => point.created),
                tone: 'soft',
              },
              {
                key: 'resolved',
                label: 'Resolved',
                values: throughput.map((point) => point.resolved),
              },
            ]}
            line={{
              label: `Open at the end of the ${word}`,
              values: throughput.map((point) => point.backlog),
              unit: 'open now',
            }}
            slotTitles={throughput.map(
              (point, i) =>
                `${labels[i]}: ${point.created} created, ${point.resolved} resolved, ${point.backlog} open at the end`,
            )}
            describe={`Tickets created and resolved per ${word}, with the number open at the end of each`}
            height={180}
          />
        </>
      )}
    </Section>
  );
}
