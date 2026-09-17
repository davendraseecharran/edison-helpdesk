import { HONOUR_TITLES, type People, type PersonRow } from '@/lib/domain/analytics';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { hoursOr } from './format';
import { Section } from './Section';

function score(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/**
 * The honours, the reader's own row, and — for an administrator — everybody.
 *
 * The four honours are the recognition every NetRider sees; none of them is
 * "most tickets". The table with the counts is the ranking the owner kept
 * for administrators, and it is rendered only when the document carries
 * rows, which the database decides.
 */
export function PeopleSection({ people }: { people: People }) {
  const columns: Column<PersonRow>[] = [
    { key: 'name', header: 'NetRider', hideOnPhone: true, cell: (row) => <span className="stat-who">{row.name}</span> },
    { key: 'resolved', header: 'Resolved', align: 'right', width: 90, cell: (row) => row.resolved },
    { key: 'urgentHigh', header: 'Urgent + high', align: 'right', width: 110, cell: (row) => row.urgentHigh },
    { key: 'median', header: 'Median', align: 'right', width: 90, cell: (row) => hoursOr(row.medianHours) },
    { key: 'claim', header: 'From claim', align: 'right', width: 100, cell: (row) => hoursOr(row.medianFromClaimHours) },
    { key: 'hard', header: 'Hard score', align: 'right', width: 100, cell: (row) => score(row.hardScore) },
    { key: 'joined', header: 'Joined', align: 'right', width: 80, cell: (row) => row.joined },
    { key: 'reopened', header: 'Reopened', align: 'right', width: 90, cell: (row) => row.reopened },
  ];

  return (
    <Section
      id="people"
      title="People"
      note="Four honours, each for one thing done well, and your own figures. None of them is a count of tickets."
    >
      <div className="honours">
        {people.honours.map((honour) => (
          <div key={honour.key} className="honour">
            <span className="honour-title">{HONOUR_TITLES[honour.key]}</span>
            {honour.name === null ? (
              <span className="honour-name" data-empty="">
                Nobody yet
              </span>
            ) : (
              <span className="honour-name">{honour.name}</span>
            )}
            {honour.value !== null ? <span className="honour-value">{honour.value}</span> : null}
            <span className="honour-detail">{honour.detail}</span>
          </div>
        ))}
      </div>

      {people.me ? (
        <div className="analytics-block">
          <h3 className="analytics-block-title">You</h3>
          <dl className="stat-strip">
            <div>
              <dt>Resolved</dt>
              <dd>{people.me.resolved}</dd>
            </div>
            <div>
              <dt>Urgent + high</dt>
              <dd>{people.me.urgentHigh}</dd>
            </div>
            <div>
              <dt>Median</dt>
              <dd>{hoursOr(people.me.medianHours)}</dd>
            </div>
            <div>
              <dt>From claim</dt>
              <dd>{hoursOr(people.me.medianFromClaimHours)}</dd>
            </div>
            <div>
              <dt>Hard score</dt>
              <dd>{score(people.me.hardScore)}</dd>
            </div>
            <div>
              <dt>Joined</dt>
              <dd>{people.me.joined}</dd>
            </div>
            <div>
              <dt>Reopened</dt>
              <dd>{people.me.reopened}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="analytics-quiet">You have not resolved anything in this period.</p>
      )}

      {people.rows.length > 0 ? (
        <div className="analytics-block">
          <h3 className="analytics-block-title">Everybody</h3>
          <div className="analytics-people-table">
            <DataTable
              columns={columns}
              rows={people.rows}
              rowKey={(row) => row.accountId}
              caption="Every resolver for the period, busiest first."
              cardTitle={(row) => row.name}
              cardMeta={(row) => `${row.resolved} resolved`}
            />
          </div>
        </div>
      ) : null}
    </Section>
  );
}
