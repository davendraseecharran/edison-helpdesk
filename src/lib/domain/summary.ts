/**
 * The week in review, as the page, the notice and the email read it.
 *
 * Mirrors `app_weekly_summary_core`: counts only, tickets only for somebody who
 * works them. `parseSummary` is defensive in the house style — a field the
 * database did not send reads as zero or empty, never as a crash.
 */

import { isRecord } from '@/lib/guards';

export interface SummaryTickets {
  youResolved: number;
  youResolvedPrev: number;
  youLogged: number;
  youOwnOpen: number;
  youMedianHours: number | null;
  deskCreated: number;
  deskResolved: number;
  deskResolvedPrev: number;
  unassignedNow: number;
  busiestDay: string | null;
  topCategory: string | null;
  workflowRuns: number;
  workflowDevices: number;
}

export interface SummaryEvent {
  id: string;
  name: string;
  group: string;
  heldOn: string;
  present: number;
  members: number;
}

export interface SummaryForm {
  id: string;
  title: string;
  responses: number;
}

export interface WeeklySummary {
  weekStart: string;
  weekEnd: string;
  tickets: SummaryTickets | null;
  events: SummaryEvent[];
  checkins: number;
  formResponses: number;
  forms: SummaryForm[];
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function parseSummary(raw: unknown): WeeklySummary | null {
  if (!isRecord(raw)) return null;
  const t = raw.tickets;
  return {
    weekStart: str(raw.week_start),
    weekEnd: str(raw.week_end),
    tickets: isRecord(t)
      ? {
          youResolved: num(t.you_resolved),
          youResolvedPrev: num(t.you_resolved_prev),
          youLogged: num(t.you_logged),
          youOwnOpen: num(t.you_own_open),
          youMedianHours: t.you_median_hours === null || t.you_median_hours === undefined ? null : num(t.you_median_hours),
          deskCreated: num(t.desk_created),
          deskResolved: num(t.desk_resolved),
          deskResolvedPrev: num(t.desk_resolved_prev),
          unassignedNow: num(t.unassigned_now),
          busiestDay: typeof t.busiest_day === 'string' ? t.busiest_day : null,
          topCategory: typeof t.top_category === 'string' ? t.top_category : null,
          workflowRuns: num(t.workflow_runs),
          workflowDevices: num(t.workflow_devices),
        }
      : null,
    events: (Array.isArray(raw.events) ? raw.events : []).filter(isRecord).map((e) => ({
      id: str(e.id),
      name: str(e.name),
      group: str(e.group),
      heldOn: str(e.held_on),
      present: num(e.present),
      members: num(e.members),
    })),
    checkins: num(raw.checkins),
    formResponses: num(raw.form_responses),
    forms: (Array.isArray(raw.forms) ? raw.forms : []).filter(isRecord).map((f) => ({
      id: str(f.id),
      title: str(f.title),
      responses: num(f.responses),
    })),
  };
}

/** Monday of the school week holding `day` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function weekStartOf(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export function shiftWeek(weekStart: string, weeks: number): string {
  const date = new Date(`${weekStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The week as plain sentences, for "Copy summary" and the email body. Written
 * to be pasted into a message to an advisor or the IT lead as it stands.
 */
export function summaryText(summary: WeeklySummary, name: string, weekLabel: string): string {
  const lines = [`${name}'s week, ${weekLabel}`, ''];
  const t = summary.tickets;
  if (t) {
    lines.push(
      `Tickets: resolved ${t.youResolved} (the desk resolved ${t.deskResolved}, ${t.deskCreated} came in).`,
    );
    if (t.youMedianHours !== null) lines.push(`Median time to resolve: ${t.youMedianHours} hours.`);
    if (t.workflowRuns > 0) {
      lines.push(`Workflows: ${plural(t.workflowRuns, 'run', 'runs')}, ${plural(t.workflowDevices, 'device', 'devices')} handled.`);
    }
    lines.push(`Still open with you: ${t.youOwnOpen}. Waiting on the queue: ${t.unassignedNow}.`);
  }
  if (summary.events.length > 0) {
    lines.push(`Events: ${plural(summary.events.length, 'event', 'events')}, ${plural(summary.checkins, 'check-in', 'check-ins')}.`);
    for (const event of summary.events) {
      lines.push(`  ${event.name} (${event.group}): ${event.present} of ${event.members} present`);
    }
  }
  if (summary.formResponses > 0) {
    lines.push(`Forms: ${plural(summary.formResponses, 'response', 'responses')}.`);
    for (const form of summary.forms) lines.push(`  ${form.title}: ${form.responses}`);
  }
  if (lines.length === 2) lines.push('A quiet week.');
  return lines.join('\n');
}
