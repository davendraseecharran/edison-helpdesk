import { hardScore } from '@/lib/domain/analytics';
import { Section } from './Section';

/** The definitions, in the words the numbers were counted by. */
export function HowCounted() {
  const example = hardScore('urgent', 24, 2, 0).toFixed(1);
  return (
    <Section
      id="counting"
      title="How these are counted"
      note="Every figure on this page is measured in school time, and by these rules."
    >
      <dl className="analytics-defs">
        <div>
          <dt>Resolved and cancelled</dt>
          <dd>
            A ticket counts as resolved in the period it was marked resolved in, whoever created it.
            A cancelled ticket is counted separately and never as a resolution; it is left out of
            the backlog too, since a cancellation carries no instant of its own.
          </dd>
        </div>
        <div>
          <dt>School day</dt>
          <dd>
            Monday to Friday, inside the period and up to today. Per school day divides the
            resolutions by those days; per week divides by seven-day spans of the period.
          </dd>
        </div>
        <div>
          <dt>From claim</dt>
          <dd>
            Hours from the resolver taking the ticket — claiming it, or joining it as a
            collaborator — to resolving it. Median time counts from creation instead, so the gap
            between the two is how long a ticket sat before anybody had it.
          </dd>
        </div>
        <div>
          <dt>Hard score</dt>
          <dd>
            Priority weight (urgent 4, high 3, normal 2, low 1) times the natural log of one plus
            the hours it was open, plus half a point for every extra pair of hands, plus one for
            every reopen. An urgent ticket open a day with two people on it scores {example}.
          </dd>
        </div>
        <div>
          <dt>The previous period</dt>
          <dd>
            The span of equal length just before this one: last week for this week, the month
            before for this month, the same number of days before the term began for a term. All
            time has nothing to compare with.
          </dd>
        </div>
        <div>
          <dt>Whose tickets</dt>
          <dd>
            Every count is the whole desk&apos;s. The one place a ticket is named is the hardest
            list, and there it carries its number only when you could open it.
          </dd>
        </div>
      </dl>
    </Section>
  );
}
