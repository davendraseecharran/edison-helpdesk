import type { CSSProperties, ReactNode } from 'react';
import { maxOf } from './scale';

export interface BarCell {
  key: string;
  content: ReactNode;
  /** Column width on the desk, in px. */
  width?: number;
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** What the bar's length is drawn from. */
  value: number;
  /** The figures after the bar: the count, the share, a median, a sparkline. */
  cells: BarCell[];
  title?: string;
}

/**
 * Horizontal bars, one a row, each against the longest.
 *
 * The bar carries the comparison and nothing else; every number is in a cell
 * beside it, named once in a header row on the desk and once per cell on a
 * phone, where the header would not fit. A row with work always draws
 * something: at 1 against 40 the honest width is a pixel, which reads as
 * nothing, and the number is right there anyway.
 */
export function Bars({
  rows,
  max,
  labelWidth = 150,
  describe,
}: {
  rows: BarRow[];
  /** A shared maximum, for two lists that should be read against each other. */
  max?: number;
  labelWidth?: number;
  /** An accessible name for the list. */
  describe: string;
}) {
  const most = max ?? maxOf(rows.map((row) => row.value));
  const cells = rows[0]?.cells ?? [];
  const columns = `${labelWidth}px minmax(0, 1fr) auto`;
  const style = { '--bars-cols': columns } as CSSProperties;

  return (
    <div className="bars-wrap">
      {cells.length > 0 ? (
        <div className="bars-head" style={style} aria-hidden="true">
          <span />
          <span />
          <span className="bars-head-cells">
            {cells.map((cell) => (
              <span
                key={cell.key}
                className="bars-head-cell"
                style={{ '--w': `${cell.width ?? 48}px` } as CSSProperties}
              >
                {cell.key}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      <ul className="bars" aria-label={describe}>
        {rows.map((row, i) => {
          const percent = row.value > 0 && most > 0 ? Math.max(1.5, (row.value / most) * 100) : 0;
          return (
            <li key={row.key} className="bar-row" style={style} title={row.title}>
              <span className="bar-label">{row.label}</span>
              <svg className="bar-track" aria-hidden="true">
                <rect className="bar-bg" width="100%" height="100%" rx="2" />
                {percent > 0 ? (
                  <rect
                    className="bar-fill"
                    width={`${percent}%`}
                    height="100%"
                    rx="2"
                    style={{ '--i': i } as CSSProperties}
                  />
                ) : null}
              </svg>
              <span className="bar-cells">
                {row.cells.map((cell) => (
                  <span
                    key={cell.key}
                    className="bar-cell"
                    style={{ '--w': `${cell.width ?? 48}px` } as CSSProperties}
                  >
                    <span className="bar-cell-key">{cell.key} </span>
                    {cell.content}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  opacity: number;
}

/**
 * One bar split into parts: staff, students, everybody else. Segments are the
 * same ink a step apart in opacity with a 2px gap of surface between them,
 * and the legend beneath names each with its count, so nothing rides on
 * telling two grays apart.
 */
export function StackedBar({ segments, describe }: { segments: StackSegment[]; describe: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  // Where each segment begins: the sum of everything before it.
  const starts: number[] = [];
  let running = 0;
  for (const segment of segments) {
    starts.push(running);
    running += segment.value;
  }
  return (
    <div className="chart">
      <svg className="stack-bar" role="img" aria-label={describe}>
        <rect className="bar-bg" width="100%" height="100%" rx="3" />
        {segments.map((segment, i) => {
          if (total <= 0 || segment.value <= 0) return null;
          const start = (starts[i] / total) * 100;
          const width = (segment.value / total) * 100;
          return (
            <rect
              key={segment.key}
              className="stack-seg"
              x={`${start}%`}
              width={`${width}%`}
              height="100%"
              rx="3"
              style={{ opacity: segment.opacity, '--i': i } as CSSProperties}
            >
              <title>{`${segment.label}: ${segment.value}`}</title>
            </rect>
          );
        })}
        {/* The gaps, painted in the surface over the seams. */}
        {segments.slice(0, -1).map((segment, i) => {
          const before = starts[i] + segment.value;
          if (total <= 0 || before <= 0 || before >= total) return null;
          return (
            <rect
              key={`gap-${segment.key}`}
              x={`calc(${(before / total) * 100}% - 1px)`}
              width="2"
              height="100%"
              fill="var(--surface)"
            />
          );
        })}
      </svg>
      <div className="chart-legend">
        {segments.map((segment) => (
          <span key={segment.key}>
            <span className="chart-key" style={{ opacity: segment.opacity }} aria-hidden="true" />
            {segment.label} {segment.value}
          </span>
        ))}
      </div>
    </div>
  );
}
