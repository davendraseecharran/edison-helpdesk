/**
 * The arithmetic behind the charts: a scale with clean ticks, and the
 * percentages a mark is drawn at. Pure, so the choices can be tested without
 * rendering anything.
 */

/** How a value axis is divided: the top of the scale and the step between ticks. */
export interface Scale {
  top: number;
  step: number;
}

/**
 * A scale whose ticks are numbers a person would say — 5, 10, 15 rather than
 * 4.67 — with two to four of them, and never a fraction for a count of tickets.
 * An empty series still gets a scale, so an empty chart has a baseline and a
 * gridline rather than a division by zero.
 */
export function niceScale(max: number): Scale {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, step: 1 };
  const rough = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 2.5, 5, 10].map((unit) => unit * magnitude);
  const step = Math.max(1, candidates.find((candidate) => candidate >= rough) ?? candidates[4]);
  return { top: Math.ceil(max / step) * step, step };
}

/** Every tick above zero, up to and including the top. */
export function ticksOf({ top, step }: Scale): number[] {
  const ticks: number[] = [];
  for (let at = step; at <= top + step / 1000; at += step) ticks.push(Number(at.toFixed(6)));
  return ticks;
}

export function maxOf(values: readonly number[]): number {
  return values.reduce((most, value) => Math.max(most, value), 0);
}

/** A value as the percentage of the scale it fills, clamped. */
export function fillPercent(value: number, top: number): number {
  if (top <= 0 || value <= 0) return 0;
  return Math.min(100, (value / top) * 100);
}

/**
 * Points for a polyline in a 0–100 box, one per value, `y` up. `centred`
 * puts each point in the middle of its slot, to sit over a column; otherwise
 * the first and last points touch the edges, as a sparkline does.
 */
export function linePoints(values: readonly number[], top: number, centred = false): string {
  const n = values.length;
  if (n === 0) return '';
  return values
    .map((value, i) => {
      const x = n === 1 ? 50 : centred ? ((i + 0.5) / n) * 100 : (i / (n - 1)) * 100;
      const y = 100 - fillPercent(value, top);
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
