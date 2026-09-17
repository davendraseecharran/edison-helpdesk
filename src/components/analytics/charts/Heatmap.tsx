import type { CSSProperties } from 'react';
import { maxOf } from './scale';

/** Five steps of the one ink; a count is shaded by its fifth of the busiest cell. */
const STEPS = [0.16, 0.32, 0.5, 0.7, 0.9];

export function heatOpacity(count: number, most: number): number {
  if (count <= 0 || most <= 0) return 0;
  const step = Math.min(STEPS.length, Math.ceil((count / most) * STEPS.length));
  return STEPS[step - 1];
}

/**
 * A grid of counts, rows by columns, each cell shaded by its count.
 *
 * Rows are named at the left and a few columns beneath; every cell names
 * itself on hover. Cells are percentage rectangles, so the grid stretches to
 * its container and keeps a real 2px radius, and the container scrolls
 * sideways on a phone rather than squeezing twenty-four columns into 300px.
 */
export function Heatmap({
  rows,
  rowLabels,
  columnLabel,
  columnEvery = 3,
  cellTitle,
  describe,
  rowHeight = 20,
}: {
  rows: number[][];
  rowLabels: readonly string[];
  columnLabel: (column: number) => string;
  columnEvery?: number;
  cellTitle: (row: number, column: number, count: number) => string;
  describe: string;
  rowHeight?: number;
}) {
  const columns = rows[0]?.length ?? 0;
  const most = maxOf(rows.flat());
  const style = { '--heat-h': `${rows.length * rowHeight}px` } as CSSProperties;
  const cellW = columns > 0 ? 100 / columns : 100;
  const cellH = rows.length > 0 ? 100 / rows.length : 100;

  return (
    <div className="heat">
      <div className="heat-grid" style={style}>
        <div className="heat-rows" aria-hidden="true">
          {rowLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <svg className="heat-cells" role="img" aria-label={describe}>
          {rows.map((row, r) =>
            row.map((count, c) => {
              const opacity = heatOpacity(count, most);
              return (
                <rect
                  key={`${r}-${c}`}
                  className={opacity > 0 ? 'heat-cell' : 'heat-cell heat-cell-empty'}
                  x={`${(c * cellW + cellW * 0.08).toFixed(3)}%`}
                  y={`${(r * cellH + cellH * 0.1).toFixed(3)}%`}
                  width={`${(cellW * 0.84).toFixed(3)}%`}
                  height={`${(cellH * 0.8).toFixed(3)}%`}
                  rx="2"
                  style={opacity > 0 ? ({ opacity, '--i': r } as CSSProperties) : undefined}
                >
                  <title>{cellTitle(r, c, count)}</title>
                </rect>
              );
            }),
          )}
        </svg>
        <div className="heat-hours" aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <span key={c}>{c % columnEvery === 0 ? columnLabel(c) : ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
