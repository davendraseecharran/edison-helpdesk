import { useId, type CSSProperties } from 'react';
import { fillPercent, linePoints, maxOf, niceScale, round, ticksOf } from './scale';

export interface ColumnSeries {
  key: string;
  label: string;
  values: number[];
  /** `soft` is the quieter of two series: the same ink at a lower opacity. */
  tone?: 'ink' | 'soft';
}

/** A line drawn in its own band above the columns, on its own scale. */
export interface ColumnLine {
  label: string;
  values: number[];
  /** Follows the last value: "open now". */
  unit?: string;
}

interface ColumnsProps {
  /** One label per slot; every `labelEvery`-th is shown on the axis. */
  labels: string[];
  series: ColumnSeries[];
  line?: ColumnLine;
  /** Hover text per slot; the numbers, spelled out. */
  slotTitles?: string[];
  /** What the chart is, for the table a screen reader gets instead. */
  describe: string;
  height?: number;
  labelEvery?: number;
  /** The widest a column may be, in percent of the plot. */
  thick?: number;
}

/**
 * Columns per slot, one or two series side by side, with an optional line
 * band above them.
 *
 * Drawn with percentage coordinates in an SVG that fills its box, so the
 * radii and the hairlines stay in pixels however wide the panel is, and the
 * axis labels are HTML in a grid of the same slot count rather than text
 * scaled with a viewBox. The line band is the one part on a normalised
 * viewBox, because a polyline cannot take percentages; its stroke is
 * non-scaling so it is 2px everywhere.
 *
 * Two measures of different scale — how many were closed on a day and how
 * many were open at the end of it — never share one axis. The backlog gets a
 * band of its own, over the same slots, with its own top tick.
 *
 * The line is revealed on first paint by a clip that widens from the left,
 * not by a dash: a dash pattern over `pathLength` misbehaves under a
 * non-scaling stroke in a stretched viewBox and leaves gaps in the resting
 * line, and a clip has no resting state to get wrong.
 */
export function Columns({
  labels,
  series,
  line,
  slotTitles,
  describe,
  height = 160,
  labelEvery,
  thick = 2.8,
}: ColumnsProps) {
  const n = labels.length;
  const scale = niceScale(maxOf(series.flatMap((s) => s.values)));
  const ticks = ticksOf(scale);
  const every = labelEvery ?? Math.max(1, Math.ceil(n / 6));

  const slot = n > 0 ? 100 / n : 100;
  const bar = Math.min(slot * (series.length > 1 ? 0.3 : 0.56), thick);
  const gap = series.length > 1 ? Math.min(slot * 0.06, 0.35) : 0;
  const group = series.length * bar + (series.length - 1) * gap;

  const clipId = useId();
  const lineScale = line ? niceScale(maxOf(line.values)) : null;
  const last = line && line.values.length > 0 ? line.values[line.values.length - 1] : null;

  const style = { '--chart-h': `${height}px` } as CSSProperties;

  return (
    <figure className="chart" style={style}>
      <div className="chart-frame">
        {line && lineScale ? (
          <>
            <div className="chart-band-title">
              <span>{line.label}</span>
              {last !== null ? (
                <span className="chart-band-now">
                  {last}
                  {line.unit ? ` ${line.unit}` : ''}
                </span>
              ) : null}
            </div>
            <div className="chart-band-ticks" aria-hidden="true">
              <span style={{ top: '0%' }}>{lineScale.top}</span>
            </div>
            <div className="chart-band">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <clipPath id={clipId}>
                    <rect className="chart-reveal" x="0" y="0" width="100" height="100" />
                  </clipPath>
                </defs>
                <g className="chart-grid">
                  <line x1="0" x2="100" y1="0" y2="0" />
                </g>
                <line className="chart-baseline" x1="0" x2="100" y1="100" y2="100" />
                {line.values.length > 1 ? (
                  <g clipPath={`url(#${clipId})`}>
                    <polygon
                      className="chart-area"
                      points={`0,100 ${linePoints(line.values, lineScale.top, true)} 100,100`}
                    />
                    <polyline
                      className="chart-line"
                      points={linePoints(line.values, lineScale.top, true)}
                    />
                  </g>
                ) : null}
              </svg>
            </div>
          </>
        ) : null}

        <div className="chart-ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ top: `${round(100 - fillPercent(tick, scale.top))}%` }}>
              {tick}
            </span>
          ))}
        </div>
        <div className="chart-plot">
          <svg aria-hidden="true">
            <g className="chart-grid">
              {ticks.map((tick) => {
                const y = `${round(100 - fillPercent(tick, scale.top))}%`;
                return <line key={tick} x1="0" x2="100%" y1={y} y2={y} />;
              })}
            </g>
            {labels.map((label, i) => {
              const start = i * slot + (slot - group) / 2;
              return (
                <g key={label + i} className="chart-slot">
                  {slotTitles?.[i] ? <title>{slotTitles[i]}</title> : null}
                  <rect
                    className="chart-hit"
                    x={`${round(i * slot)}%`}
                    y="0"
                    width={`${round(slot)}%`}
                    height="100%"
                  />
                  {series.map((s, k) => {
                    const value = s.values[i] ?? 0;
                    if (value <= 0) return null;
                    const h = fillPercent(value, scale.top);
                    return (
                      <rect
                        key={s.key}
                        className={s.tone === 'soft' ? 'chart-col chart-col-soft' : 'chart-col'}
                        x={`${round(start + k * (bar + gap))}%`}
                        y={`${round(100 - h)}%`}
                        width={`${round(bar)}%`}
                        height={`${round(h)}%`}
                        rx="1.5"
                        style={{ '--i': i } as CSSProperties}
                      />
                    );
                  })}
                </g>
              );
            })}
            <line className="chart-baseline" x1="0" x2="100%" y1="100%" y2="100%" />
          </svg>
        </div>
        <div
          className="chart-axis"
          aria-hidden="true"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, n)}, minmax(0, 1fr))` }}
        >
          {labels.map((label, i) => (
            <span
              key={label + i}
              className="chart-axis-label"
              data-shown={i % every === 0 ? '' : undefined}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* The numbers, as a table, for anyone not looking at the marks. In a
          hidden box rather than hidden itself: a table will not shrink to a
          pixel, and one left to its own width scrolled the phone sideways. */}
      <div className="visually-hidden">
        <table>
        <caption>{describe}</caption>
        <thead>
          <tr>
            <th scope="col">Slice</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            {line ? <th scope="col">{line.label}</th> : null}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={label + i}>
              <th scope="row">{label}</th>
              {series.map((s) => (
                <td key={s.key}>{s.values[i] ?? 0}</td>
              ))}
              {line ? <td>{line.values[i] ?? 0}</td> : null}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </figure>
  );
}

/** A legend line for a chart with more than one series. */
export function ChartLegend({
  items,
}: {
  items: Array<{ key: string; label: string; kind: 'ink' | 'soft' | 'line' }>;
}) {
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <span key={item.key}>
          <span
            className={
              item.kind === 'line'
                ? 'chart-key chart-key-line'
                : item.kind === 'soft'
                  ? 'chart-key chart-key-soft'
                  : 'chart-key'
            }
            aria-hidden="true"
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
