'use client';

/**
 * The week in review.
 *
 * Built to be read in ten seconds and forwarded in one: the numbers somebody
 * is asked about ("how many did you close?", "how many came to the meeting?")
 * at the top of each section, the arrows against the week before, and a Copy
 * button that turns the page into sentences for a message to an advisor or the
 * IT lead. Tickets appear only for somebody who works them; events and forms
 * for everybody.
 */

import Link from 'next/link';
import { ChevronLeft, ChevronRight, ClipboardCopy } from 'lucide-react';
import { deltaOf } from '@/lib/domain/analytics';
import { shiftWeek, summaryText, type WeeklySummary } from '@/lib/domain/summary';
import { TICKET_CATEGORY_LABELS, type TicketCategory } from '@/lib/domain/types';
import { copyText } from '@/lib/groups/clipboard';
import { useRuntime } from '@/components/AppRuntime';
import { EmptyState, PageHeader } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { StatCard } from '@/components/analytics/charts/StatCard';
import { Section } from '@/components/analytics/Section';

function weekLabel(start: string): string {
  const from = new Date(`${start}T12:00:00Z`);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);
  const month = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = (date: Date) => date.getUTCDate();
  return month(from) === month(to)
    ? `${month(from)} ${day(from)}–${day(to)}`
    : `${month(from)} ${day(from)} – ${month(to)} ${day(to)}`;
}

function categoryLabel(value: string | null): string | null {
  if (!value) return null;
  return TICKET_CATEGORY_LABELS[value as TicketCategory] ?? value;
}

export function WeeklySummaryScreen({
  summary,
  week,
  thisWeek,
  name,
}: {
  summary: WeeklySummary | null;
  week: string;
  thisWeek: string;
  name: string;
}) {
  const { notify } = useRuntime();
  const label = weekLabel(week);
  const current = week === thisWeek;

  async function copy() {
    if (!summary) return;
    const ok = await copyText(summaryText(summary, name || 'My', label));
    notify(ok ? 'success' : 'error', ok ? 'Summary copied.' : 'That did not copy. Try again.');
  }

  const nav = (
    <>
      <ButtonLink href={`/summary?week=${shiftWeek(week, -1)}`} icon={ChevronLeft} aria-label="The week before" />
      {current ? (
        <Button icon={ChevronRight} aria-label="Next week" disabled />
      ) : (
        <ButtonLink href={`/summary?week=${shiftWeek(week, 1)}`} icon={ChevronRight} aria-label="The week after" />
      )}
      <Button icon={ClipboardCopy} onClick={() => void copy()} disabled={!summary}>
        Copy summary
      </Button>
    </>
  );

  const t = summary?.tickets ?? null;
  const quiet =
    summary !== null &&
    (t === null || (t.youResolved === 0 && t.deskCreated === 0 && t.deskResolved === 0)) &&
    summary.events.length === 0 &&
    summary.formResponses === 0;

  return (
    <>
      <PageHeader
        title={current ? 'This week' : `Week of ${label}`}
        description={current ? `${label}, so far.` : 'What you did, and what happened around you.'}
        actions={nav}
      />
      {summary === null ? (
        <p className="analytics-lead">The week could not be read just now.</p>
      ) : quiet ? (
        <EmptyState
          title="A quiet week"
          action={
            <ButtonLink href={`/summary?week=${shiftWeek(week, -1)}`} icon={ChevronLeft}>
              The week before
            </ButtonLink>
          }
        >
          Nothing was resolved, held or answered in {label}.
        </EmptyState>
      ) : (
        <div className="analytics-sections summary-sections">
          {t ? (
            <Section id="summary-tickets" title="Tickets" note="Yours first, then the desk's. Arrows compare with the week before.">
              <div className="stat-grid">
                <StatCard
                  label="You resolved"
                  value={t.youResolved}
                  delta={deltaOf(t.youResolved, t.youResolvedPrev)}
                  lines={[`${t.youResolvedPrev} the week before`]}
                />
                <StatCard
                  label="The desk resolved"
                  value={t.deskResolved}
                  delta={deltaOf(t.deskResolved, t.deskResolvedPrev)}
                  lines={[`${t.deskCreated} came in`]}
                />
                <StatCard
                  label="Your median time"
                  value={t.youMedianHours === null ? '—' : `${t.youMedianHours}h`}
                  lines={['From opened to resolved']}
                />
                <StatCard
                  label="Still with you"
                  value={t.youOwnOpen}
                  lines={[
                    <Link key="mine" href="/my-tickets">
                      Open My tickets
                    </Link>,
                  ]}
                />
                <StatCard
                  label="Waiting on the queue"
                  value={t.unassignedNow}
                  lines={[
                    <Link key="queue" href="/queue">
                      Open the queue
                    </Link>,
                  ]}
                />
                {t.workflowRuns > 0 ? (
                  <StatCard
                    label="Devices through workflows"
                    value={t.workflowDevices}
                    lines={[`${t.workflowRuns} ${t.workflowRuns === 1 ? 'run' : 'runs'}`]}
                  />
                ) : null}
              </div>
              {t.busiestDay || t.topCategory ? (
                <p className="summary-facts">
                  {t.busiestDay ? <>Busiest day: <strong>{t.busiestDay}</strong>. </> : null}
                  {categoryLabel(t.topCategory) ? (
                    <>
                      Most asked about: <strong>{categoryLabel(t.topCategory)}</strong>.
                    </>
                  ) : null}
                </p>
              ) : null}
            </Section>
          ) : null}

          {summary.events.length > 0 ? (
            <Section
              id="summary-events"
              title="Events"
              note={`${summary.checkins} ${summary.checkins === 1 ? 'check-in' : 'check-ins'} across ${summary.events.length} ${summary.events.length === 1 ? 'event' : 'events'}.`}
            >
              <ul className="summary-events">
                {summary.events.map((event) => {
                  const share = event.members > 0 ? Math.min(1, event.present / event.members) : 0;
                  return (
                    <li key={event.id}>
                      <Link href={`/events/${event.id}`} className="summary-event">
                        <span className="summary-event-text">
                          <span className="summary-event-name">{event.name}</span>
                          <span className="summary-event-meta">
                            {event.group},{' '}
                            {new Date(`${event.heldOn}T12:00:00Z`).toLocaleDateString('en-US', {
                              weekday: 'short',
                              timeZone: 'UTC',
                            })}
                          </span>
                        </span>
                        <span className="summary-bar" aria-hidden="true">
                          <span style={{ transform: `scaleX(${share})` }} />
                        </span>
                        <span className="summary-event-count">
                          {event.present}
                          <span className="summary-quiet"> of {event.members}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}

          {summary.formResponses > 0 ? (
            <Section
              id="summary-forms"
              title="Forms"
              note={`${summary.formResponses} ${summary.formResponses === 1 ? 'response' : 'responses'} this week.`}
            >
              <ul className="summary-forms">
                {summary.forms.map((form) => (
                  <li key={form.id}>
                    <Link href={`/forms/${form.id}/responses`} className="summary-form">
                      <span>{form.title}</span>
                      <span className="summary-event-count">{form.responses}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      )}
    </>
  );
}
