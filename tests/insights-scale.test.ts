/**
 * The arithmetic behind the insights charts.
 *
 * Axis scales, path geometry, label thinning and the duration wording are the
 * parts of a chart that are easy to get subtly wrong and impossible to check by
 * looking at a screenshot: a tick that rounds down hides a bar, a path that
 * divides by zero renders nothing at all. They are pure functions here so they
 * can be asserted directly, and the components that draw the pixels are
 * rendered to static markup to pin the structure a screen reader depends on.
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  LineChart,
  endLabelsFit,
  niceTicks,
  pathFor,
  tickIndexes,
} from '../src/components/insights/LineChart';
import { BarChart } from '../src/components/insights/BarChart';
import { StatTile, formatHours } from '../src/components/insights/StatTile';

describe('niceTicks', () => {
  it('never collapses to a single line when there is no data', () => {
    expect(niceTicks(0, 4)).toEqual([0, 1]);
    expect(niceTicks(-5, 4)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN, 4)).toEqual([0, 1]);
  });

  it('counts by one for small maxima, so a count axis shows whole tickets', () => {
    expect(niceTicks(1, 4)).toEqual([0, 1]);
    expect(niceTicks(3, 4)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(4, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it('steps in ones, twos, fives and their decades', () => {
    expect(niceTicks(7, 4)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(9, 4)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(23, 4)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(niceTicks(140, 4)).toEqual([0, 50, 100, 150]);
  });

  it('always reaches the largest value, so no bar can overflow its axis', () => {
    for (const max of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
      const ticks = niceTicks(max, 4);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      // Every step is the same size and every tick is a whole number.
      const step = ticks[1] - ticks[0];
      ticks.forEach((tick, index) => {
        expect(tick).toBe(index * step);
        expect(Number.isInteger(tick)).toBe(true);
      });
    }
  });
});

describe('pathFor', () => {
  it('draws nothing for no points', () => {
    expect(pathFor([], 100, 50)).toBe('');
  });

  it('centres a lone point rather than dividing by zero', () => {
    expect(pathFor([0.5], 100, 50)).toBe('M50,25');
  });

  it('maps 0 to the baseline and 1 to the top of the plot', () => {
    expect(pathFor([0, 1], 100, 50)).toBe('M0,50 L100,0');
  });

  it('spaces points evenly across the width', () => {
    expect(pathFor([1, 1, 1], 100, 50)).toBe('M0,0 L50,0 L100,0');
  });

  it('rounds to two decimals so the markup stays readable', () => {
    expect(pathFor([0, 1, 0], 100, 30)).toBe('M0,30 L50,0 L100,30');
    expect(pathFor([1 / 3, 2 / 3], 100, 30)).toBe('M0,20 L100,10');
    expect(pathFor([0.5, 0.5, 0.5, 0.5], 100, 30)).toBe('M0,15 L33.33,15 L66.67,15 L100,15');
  });
});

describe('tickIndexes', () => {
  it('has nothing to label when there is nothing to plot', () => {
    expect(tickIndexes(0, 7)).toEqual([]);
    expect(tickIndexes(1, 7)).toEqual([0]);
  });

  it('labels every point while they all fit', () => {
    expect(tickIndexes(7, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('thins evenly and always keeps the first and last day', () => {
    const thirty = tickIndexes(30, 7);
    expect(thirty[0]).toBe(0);
    expect(thirty[thirty.length - 1]).toBe(29);
    expect(thirty.length).toBeLessThanOrEqual(7);

    const ninety = tickIndexes(90, 7);
    expect(ninety[0]).toBe(0);
    expect(ninety[ninety.length - 1]).toBe(89);
    expect(ninety.length).toBeLessThanOrEqual(7);
    // Strictly increasing: a repeated index would print the same date twice.
    ninety.forEach((index, at) => {
      if (at > 0) expect(index).toBeGreaterThan(ninety[at - 1]);
    });
  });
});

describe('endLabelsFit', () => {
  it('labels the line ends when they are far apart', () => {
    expect(endLabelsFit(0.9, 0.2)).toBe(true);
    expect(endLabelsFit(0.2, 0.9)).toBe(true);
  });

  it('leaves converging ends to the legend rather than overlapping them', () => {
    expect(endLabelsFit(0.5, 0.5)).toBe(false);
    expect(endLabelsFit(0.52, 0.48)).toBe(false);
  });
});

describe('formatHours', () => {
  it('says minutes under an hour', () => {
    expect(formatHours(0)).toBe('0m');
    expect(formatHours(0.25)).toBe('15m');
    expect(formatHours(0.99)).toBe('59m');
  });

  it('says hours and minutes up to two days', () => {
    expect(formatHours(1)).toBe('1h');
    expect(formatHours(3.33)).toBe('3h 20m');
    expect(formatHours(47.5)).toBe('47h 30m');
  });

  it('says days beyond two, and never a stray 24 hours', () => {
    expect(formatHours(48)).toBe('2d');
    expect(formatHours(50.5)).toBe('2d 3h');
    expect(formatHours(71.9)).toBe('3d');
  });

  it('refuses to report a negative duration', () => {
    expect(formatHours(-4)).toBe('0m');
  });
});

const SERIES = [
  { date: '2026-09-07', opened: 4, resolved: 2 },
  { date: '2026-09-08', opened: 0, resolved: 3 },
  { date: '2026-09-09', opened: 6, resolved: 1 },
];

describe('LineChart markup', () => {
  const html = renderToStaticMarkup(
    h(LineChart, { title: 'Opened and resolved per day', series: SERIES, days: 3 }),
  );

  it('names itself for a screen reader and carries a data table', () => {
    expect(html).toContain('role="img"');
    expect(html).toContain('<title');
    expect(html).toContain('Opened and resolved per day');
    expect(html).toContain('visually-hidden');
    expect(html).toContain('<table');
    // Every value is reachable without the chart.
    expect(html).toContain('<td>6</td>');
  });

  it('draws one path per series and no colour-only legend', () => {
    expect(html.match(/<path/g)?.length).toBe(2);
    expect(html).toContain('Opened');
    expect(html).toContain('Resolved');
  });
});

describe('BarChart markup', () => {
  const html = renderToStaticMarkup(
    h(BarChart, {
      caption: 'Open tickets by category',
      rows: [
        { key: 'network', label: 'Network or Wi-Fi', value: 8 },
        { key: 'printer', label: 'Printer', value: 2 },
        { key: 'phone', label: 'Phone', value: 0 },
      ],
    }),
  );

  it('is a real table, so the numbers read without the bars', () => {
    expect(html).toContain('<table');
    expect(html).toContain('Network or Wi-Fi');
    expect(html).toContain('>8<');
    expect(html).toContain('>0<');
  });

  it('scales each bar against the largest value', () => {
    // 8 is the largest, and the axis rounds up to 8, so the longest bar is full.
    expect(html).toContain('width="100%"');
    expect(html).toContain('width="25%"');
  });

  it('hides the decorative bars from the accessibility tree', () => {
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('StatTile markup', () => {
  it('shows the figure, its label and its one line of context', () => {
    const html = renderToStaticMarkup(
      h(StatTile, { label: 'Resolved', value: '18', meta: 'in the last 30 days' }),
    );
    expect(html).toContain('Resolved');
    expect(html).toContain('18');
    expect(html).toContain('in the last 30 days');
  });
});
