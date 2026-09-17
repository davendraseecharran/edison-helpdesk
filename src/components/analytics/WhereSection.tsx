import { percentOf, type ChannelStat, type LocationStat, type Requesters } from '@/lib/domain/analytics';
import { CHANNEL_LABELS } from '@/lib/domain/types';
import { PersonKindBadge } from '@/components/Badges';
import { Bars, StackedBar } from './charts/Bars';
import { count } from './format';
import { Section } from './Section';

/** The rooms, the channels and the people tickets come from. */
export function WhereSection({
  locations,
  remote,
  channels,
  requesters,
}: {
  locations: LocationStat[];
  remote: number;
  channels: ChannelStat[];
  requesters: Requesters;
}) {
  const people = requesters.staff + requesters.student + requesters.other;

  return (
    <Section
      id="where"
      title="Where and how"
      note="The rooms tickets name, how they reached the desk, and who opened them. Counted over tickets created in the period."
    >
      <div className="analytics-grid">
        <div className="analytics-block">
          <h3 className="analytics-block-title">Locations</h3>
          {locations.length === 0 ? (
            <p className="analytics-quiet">No room named yet.</p>
          ) : (
            <Bars
              describe="Tickets by location, the eight most frequent"
              labelWidth={110}
              rows={locations.map((stat) => ({
                key: stat.location,
                label: stat.location,
                value: stat.count,
                cells: [{ key: 'Tickets', content: stat.count, width: 44 }],
              }))}
            />
          )}
          <p className="analytics-quiet">Remote, with no room: {count(remote, 'ticket')}.</p>
        </div>

        <div className="analytics-block">
          <h3 className="analytics-block-title">Channels</h3>
          {channels.length === 0 ? (
            <p className="analytics-quiet">Nothing yet.</p>
          ) : (
            <Bars
              describe="Tickets by the channel they arrived through"
              labelWidth={90}
              rows={channels.map((stat) => ({
                key: stat.channel,
                label: CHANNEL_LABELS[stat.channel],
                value: stat.count,
                cells: [
                  { key: 'Tickets', content: stat.count, width: 44 },
                  { key: 'Share', content: percentOf(stat.share), width: 40 },
                ],
              }))}
            />
          )}
        </div>

        <div className="analytics-block">
          <h3 className="analytics-block-title">Requesters</h3>
          {people === 0 ? (
            <p className="analytics-quiet">Nothing yet.</p>
          ) : (
            <StackedBar
              describe={`Who opened tickets: ${requesters.staff} staff, ${requesters.student} students, ${requesters.other} other`}
              segments={[
                { key: 'staff', label: 'Staff', value: requesters.staff, opacity: 1 },
                { key: 'student', label: 'Students', value: requesters.student, opacity: 0.55 },
                { key: 'other', label: 'Other', value: requesters.other, opacity: 0.25 },
              ]}
            />
          )}
          {requesters.repeat.length > 0 ? (
            <ol className="repeat-list" aria-label="People who opened the most tickets">
              {requesters.repeat.map((person) => (
                <li key={`${person.kind}:${person.name}`} className="repeat-row">
                  <span className="repeat-name">{person.name}</span>
                  {person.kind === 'staff' || person.kind === 'student' ? (
                    <PersonKindBadge kind={person.kind} />
                  ) : person.kind === 'role' ? (
                    <span className="repeat-kind">Role</span>
                  ) : null}
                  <span className="repeat-count">{count(person.count, 'ticket')}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
