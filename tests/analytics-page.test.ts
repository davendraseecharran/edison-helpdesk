/**
 * The analytics page, rendered against the invented month.
 *
 * Three things are worth holding still: the fixture agrees with itself (a
 * chart checked against numbers that do not add up proves nothing), the page
 * shows every section in the order the owner reads them and hides the one
 * table that is an administrator's, and the chart arithmetic picks ticks a
 * person would say out loud.
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
}));

import { AnalyticsScreen } from '../src/components/analytics/AnalyticsScreen';
import { heatOpacity } from '../src/components/analytics/charts/Heatmap';
import { fillPercent, linePoints, niceScale, ticksOf } from '../src/components/analytics/charts/scale';
import { SAMPLE_ANALYTICS, SAMPLE_ANALYTICS_FOR_NETRIDER } from './fixtures/analytics';

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function render(analytics: typeof SAMPLE_ANALYTICS | null): string {
  return renderToStaticMarkup(h(AnalyticsScreen, { period: 'month', analytics }));
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]);
}

describe('the sample month', () => {
  const a = SAMPLE_ANALYTICS;

  it('adds up: throughput to the overview, the backlog to what is open now', () => {
    expect(sum(a.throughput.map((p) => p.created))).toBe(a.overview.created);
    expect(sum(a.throughput.map((p) => p.resolved))).toBe(a.overview.resolved);
    expect(a.throughput[a.throughput.length - 1].backlog).toBe(a.overview.openNow);
    expect(a.throughput).toHaveLength(30);
  });

  it('splits the resolutions the same way by category, priority and person', () => {
    expect(sum(a.categories.map((c) => c.resolved))).toBe(a.overview.resolved);
    expect(sum(a.priorities.map((p) => p.resolved))).toBe(a.overview.resolved);
    expect(sum(a.people.rows.map((r) => r.resolved))).toBe(a.overview.resolved);
    expect(sum(a.categories.map((c) => c.share))).toBeCloseTo(1);
    expect(sum(a.priorities.map((p) => p.share))).toBeCloseTo(1);
    for (const category of a.categories) expect(sum(category.trend)).toBe(category.resolved);
  });

  it('splits the arrivals the same way by weekday, hour and channel', () => {
    expect(sum(a.arrivals.byWeekday)).toBe(a.overview.created);
    expect(sum(a.arrivals.byHour)).toBe(a.overview.created);
    expect(sum(a.channels.map((c) => c.count))).toBe(a.overview.created);
    expect(a.requesters.staff + a.requesters.student + a.requesters.other).toBe(a.overview.created);
    a.arrivals.heat.forEach((row, day) => expect(sum(row)).toBe(a.arrivals.byWeekday[day]));
    expect(a.arrivals.heat).toHaveLength(7);
    expect(a.arrivals.heat.every((row) => row.length === 24)).toBe(true);
  });

  it('lists the hardest tickets hardest first, some of them unnamed', () => {
    const scores = a.hardest.map((t) => t.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(a.hardest.some((t) => t.number === null && t.title === null)).toBe(true);
    expect(a.hardest.length).toBeLessThanOrEqual(8);
  });
});

describe('AnalyticsScreen', () => {
  it('reads top to bottom in the order the owner asked for', () => {
    expect(headings(render(SAMPLE_ANALYTICS))).toEqual([
      'Overview',
      'Throughput',
      'When tickets arrive',
      'Common issues',
      'Priority',
      'Where and how',
      'Waiting',
      'People',
      'Hardest tickets',
      'How these are counted',
    ]);
  });

  it('leads with the sentence and the period control', () => {
    const html = render(SAMPLE_ANALYTICS);
    expect(html).toContain('60 tickets resolved this month, about 2.7 a school day.');
    expect(html).toContain('aria-label="Period"');
    expect(html).toContain('This month');
  });

  it('shows the per-person table to an administrator only', () => {
    const admin = render(SAMPLE_ANALYTICS);
    expect(admin).toContain('Everybody');
    expect(admin).toContain('Morgan Ellis');
    const netrider = render(SAMPLE_ANALYTICS_FOR_NETRIDER);
    expect(netrider).not.toContain('Everybody');
    // The honours and their own row still name people.
    expect(netrider).toContain('Fastest on urgent');
    expect(netrider).toContain('Priya Raman');
    expect(netrider).toContain('>You<');
  });

  it('links a hard ticket the reader may open and names nothing about one they may not', () => {
    const html = render(SAMPLE_ANALYTICS);
    expect(html).toContain('href="/tickets/t_1037"');
    expect(html).toContain('EDT-1037');
    expect(html).toContain('A colleague&#x27;s ticket');
    expect(html).not.toContain('t_1029');
  });

  it('notes a category that was created but never resolved', () => {
    expect(render(SAMPLE_ANALYTICS)).toContain('No resolutions yet for Phone (1 ticket created).');
  });

  it('says Nobody yet for an honour nobody has earned', () => {
    const html = render({
      ...SAMPLE_ANALYTICS,
      people: {
        ...SAMPLE_ANALYTICS.people,
        honours: SAMPLE_ANALYTICS.people.honours.map((honour) => ({
          ...honour,
          accountId: null,
          name: null,
          value: null,
        })),
      },
    });
    expect(html.match(/Nobody yet/g)).toHaveLength(4);
  });

  it('keeps the header and the control when the document could not be read', () => {
    const html = render(null);
    expect(html).toContain('The analytics could not be read just now.');
    expect(html).toContain('aria-label="Period"');
    expect(headings(html)).toEqual([]);
  });

  it('gives a screen reader the throughput as a table', () => {
    const html = render(SAMPLE_ANALYTICS);
    expect(html).toContain('<caption>Tickets created and resolved per day, with the number open at the end of each</caption>');
    expect(html).toContain('<th scope="row">Tue 1</th>');
  });
});

describe('niceScale', () => {
  it('picks ticks a person would say', () => {
    expect(niceScale(6)).toEqual({ top: 6, step: 2 });
    expect(niceScale(14)).toEqual({ top: 15, step: 5 });
    expect(niceScale(17)).toEqual({ top: 20, step: 10 });
    expect(niceScale(3)).toEqual({ top: 3, step: 1 });
    expect(niceScale(340)).toEqual({ top: 400, step: 200 });
  });

  it('never divides a count into fractions and gives an empty series a scale', () => {
    expect(niceScale(1)).toEqual({ top: 1, step: 1 });
    expect(niceScale(0)).toEqual({ top: 1, step: 1 });
    expect(ticksOf(niceScale(14))).toEqual([5, 10, 15]);
    expect(ticksOf(niceScale(2))).toEqual([1, 2]);
  });

  it('fills a mark by its share of the top and clamps', () => {
    expect(fillPercent(5, 20)).toBe(25);
    expect(fillPercent(0, 20)).toBe(0);
    expect(fillPercent(30, 20)).toBe(100);
    expect(linePoints([0, 10], 10)).toBe('0,100 100,0');
    expect(linePoints([10], 10)).toBe('50,0');
  });
});

describe('heatOpacity', () => {
  it('shades a count by its fifth of the busiest cell, and leaves nothing blank', () => {
    expect(heatOpacity(0, 9)).toBe(0);
    expect(heatOpacity(1, 9)).toBe(0.16);
    expect(heatOpacity(9, 9)).toBe(0.9);
    expect(heatOpacity(5, 9)).toBe(0.5);
  });
});
