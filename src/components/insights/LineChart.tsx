/**
 * Opened against resolved, one point per school-local day.
 *
 * Two series, so there is always a legend; the line ends are labelled as well
 * when they are far enough apart to stay attached to their own line, and the
 * legend carries identity on its own when they are not. Nothing is encoded by
 * colour alone: every value is in the table underneath, which is visually
 * hidden rather than absent.
 *
 * The geometry is deliberately split between SVG and CSS. The two paths live in
 * a `preserveAspectRatio="none"` viewBox so they stretch to whatever width the
 * panel happens to be — `vector-effect="non-scaling-stroke"` keeps the stroke at
 * two pixels while they do — and every label, tick and marker is ordinary HTML
 * positioned by percentage. A chart drawn entirely inside a scaling viewBox has
 * to scale its own text with it, which is how a legible 12px axis becomes 5px on
 * a phone and 19px on a desktop; this way the type is the size the stylesheet
 * says it is at every width.
 */

import { formatDateKey } from '@/lib/format';

export interface SeriesPoint {
  date: string;
  opened: number;
  resolved: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Sep 7" — the axis has no room for the weekday the table shows. */
export function shortDate(key: string): string {
  const match = DATE_KEY.exec(key);
  if (!match) return key;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
}

/**
 * Whole-number axis ticks from zero up to at least `max`, in steps of one, two
 * or five and their decades, aiming for about `count` of them.
 *
 * Counts of tickets are integers, so the ticks are too: an axis labelled 0,
 * 0.5, 1 for a day with one ticket reads as a measurement rather than a tally,
 * which is why the step never falls below one however short the range is. An
 * empty range still gets two ticks, because a plot whose top and bottom are
 * both zero has no height to draw anything in.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / Math.max(1, count);
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  // Rounded to the nearest nice step rather than always up: ceiling turns a
  // maximum of nine into an axis of 0, 5, 10, which throws away half the height.
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  const step = Math.max(1, Math.round(nice * 10 ** exponent));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A polyline through `points`, each given as a fraction of the plot height
 * where 0 is the baseline and 1 is the top.
 *
 * A lone point sits in the middle rather than at x = 0: with one day in the
 * range there is no interval to divide by, and a path pinned to the left edge
 * would read as the start of a line that was never drawn.
 */
export function pathFor(points: number[], width: number, height: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M${round2(width / 2)},${round2((1 - points[0]) * height)}`;
  }
  return points
    .map((value, index) => {
      const x = round2((index / (points.length - 1)) * width);
      const y = round2((1 - value) * height);
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

/**
 * Which points get an x-axis label: evenly spaced, first and last always, never
 * more than `maxLabels` of them. Ninety dates will not fit under a phone, and
 * labels that overlap are worse than labels that are missing.
 */
export function tickIndexes(length: number, maxLabels: number): number[] {
  if (length <= 0) return [];
  if (length === 1 || maxLabels <= 1) return [0];
  if (length <= maxLabels) return Array.from({ length }, (_, index) => index);
  const step = (length - 1) / (maxLabels - 1);
  const indexes: number[] = [];
  for (let i = 0; i < maxLabels; i += 1) {
    const index = Math.round(i * step);
    if (indexes[indexes.length - 1] !== index) indexes.push(index);
  }
  return indexes;
}

/**
 * Whether the two line ends are far enough apart to carry their own labels.
 *
 * Converging series are the one case where a direct label does more harm than
 * good: nudged apart it belongs to neither line, left alone it overlaps the
 * other. Below the gap the legend does the work instead.
 */
export function endLabelsFit(a: number, b: number, minGap = 0.14): boolean {
  return Math.abs(a - b) >= minGap;
}

const PLOT_W = 100;
const PLOT_H = 100;
const MAX_X_LABELS = 7;

export function LineChart({
  title,
  series,
  days,
  titleId = 'insights-series-title',
}: {
  title: string;
  series: SeriesPoint[];
  days: number;
  titleId?: string;
}) {
  const ticks = niceTicks(
    series.reduce((most, point) => Math.max(most, point.opened, point.resolved), 0),
  );
  const top = ticks[ticks.length - 1];
  const fraction = (value: number) => (top === 0 ? 0 : value / top);

  const openedPoints = series.map((point) => fraction(point.opened));
  const resolvedPoints = series.map((point) => fraction(point.resolved));
  const last = series.length - 1;
  const labelled =
    series.length > 0 && endLabelsFit(openedPoints[last], resolvedPoints[last]);

  const totals = series.reduce(
    (sum, point) => ({ opened: sum.opened + point.opened, resolved: sum.resolved + point.resolved }),
    { opened: 0, resolved: 0 },
  );
  const xLabels = tickIndexes(series.length, MAX_X_LABELS);

  return (
    <figure className="chart">
      <div className="chart-legend">
        <span className="chart-key">
          <span className="chart-key-line chart-opened" aria-hidden="true" />
          Opened
        </span>
        <span className="chart-key">
          <span className="chart-key-line chart-resolved" aria-hidden="true" />
          Resolved
        </span>
      </div>

      <div className="chart-frame">
        <div className="chart-y" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className="chart-y-tick" style={{ top: `${(1 - fraction(tick)) * 100}%` }}>
              {tick}
            </span>
          ))}
        </div>

        <div className="chart-main">
          <div className="chart-plot">
            <svg
              className="chart-svg"
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-labelledby={titleId}
            >
              <title id={titleId}>
                {`${title}. ${totals.opened} opened and ${totals.resolved} resolved over the last ${days} days.`}
              </title>
              <g className="chart-grid">
                {ticks.map((tick) => {
                  const y = (1 - fraction(tick)) * PLOT_H;
                  return (
                    <line key={tick} x1={0} x2={PLOT_W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
                  );
                })}
              </g>
              <path
                className="chart-path chart-opened"
                d={pathFor(openedPoints, PLOT_W, PLOT_H)}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="chart-path chart-resolved"
                d={pathFor(resolvedPoints, PLOT_W, PLOT_H)}
                vectorEffect="non-scaling-stroke"
              />
            </svg>

            {series.length > 0 ? (
              <>
                <span
                  className="chart-dot chart-opened"
                  style={{ left: '100%', top: `${(1 - openedPoints[last]) * 100}%` }}
                  aria-hidden="true"
                />
                <span
                  className="chart-dot chart-resolved"
                  style={{ left: '100%', top: `${(1 - resolvedPoints[last]) * 100}%` }}
                  aria-hidden="true"
                />
              </>
            ) : null}

            {labelled ? (
              <>
                <span
                  className="chart-end"
                  style={{ top: `${(1 - openedPoints[last]) * 100}%` }}
                  aria-hidden="true"
                >
                  {`Opened ${series[last].opened}`}
                </span>
                <span
                  className="chart-end"
                  style={{ top: `${(1 - resolvedPoints[last]) * 100}%` }}
                  aria-hidden="true"
                >
                  {`Resolved ${series[last].resolved}`}
                </span>
              </>
            ) : null}

            {/* One hit area per day, so hovering anywhere in a day's column
                names the day and both of its numbers. The table underneath is
                what makes them reachable without a pointer. */}
            <div className="chart-hits" aria-hidden="true">
              {series.map((point) => (
                <span
                  key={point.date}
                  className="chart-hit"
                  style={{ width: `${100 / series.length}%` }}
                  title={`${formatDateKey(point.date)}: ${point.opened} opened, ${point.resolved} resolved`}
                />
              ))}
            </div>
          </div>

          <div className="chart-x" aria-hidden="true">
            {xLabels.map((index) => (
              <span
                key={series[index].date}
                className={
                  index === 0
                    ? 'chart-x-tick chart-x-first'
                    : index === last
                      ? 'chart-x-tick chart-x-last'
                      : 'chart-x-tick'
                }
                style={{ left: `${last === 0 ? 50 : (index / last) * 100}%` }}
              >
                {shortDate(series[index].date)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <table className="visually-hidden">
        <caption>{`${title}, one row per day`}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Opened</th>
            <th scope="col">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.date}>
              <th scope="row">{formatDateKey(point.date)}</th>
              <td>{point.opened}</td>
              <td>{point.resolved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
