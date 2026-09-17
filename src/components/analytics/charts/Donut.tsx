import type { CSSProperties } from 'react';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** How dark the arc is: the one ink, stepped. */
  opacity: number;
}

/** A gap of about 2px between arcs, in hundredths of the ring. */
const GAP = 0.8;

/**
 * Shares as arcs of one ring, the figure they add up to in the middle.
 *
 * Every arc is the same circle with a dash pattern over a `pathLength` of
 * 100, so a share of 0.6 is a 60-unit dash, offset by the shares before it.
 * That is also what lets each arc sweep open on first paint: the keyframe
 * starts from an empty dash and ends at the arc's own. The table beside the
 * ring carries the exact numbers; the ring is for the proportion.
 */
export function Donut({
  slices,
  figure,
  caption,
  describe,
  size = 152,
}: {
  slices: DonutSlice[];
  figure: string;
  caption: string;
  describe: string;
  size?: number;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  // Where each arc begins, in hundredths of the ring: the shares before it.
  const starts: number[] = [];
  let before = 0;
  for (const slice of slices) {
    starts.push(before);
    before += total > 0 ? (slice.value / total) * 100 : 0;
  }
  const style = { '--donut-size': `${size}px` } as CSSProperties;

  return (
    <svg className="donut" viewBox="0 0 120 120" role="img" aria-label={describe} style={style}>
      <circle className="donut-track" cx="60" cy="60" r="46" strokeWidth="14" />
      <g transform="rotate(-90 60 60)">
        {slices.map((slice, i) => {
          if (total <= 0 || slice.value <= 0) return null;
          const share = (slice.value / total) * 100;
          const start = starts[i];
          const length = Math.max(0, share - GAP);
          return (
            <circle
              key={slice.key}
              className="donut-slice"
              cx="60"
              cy="60"
              r="46"
              strokeWidth="14"
              pathLength={100}
              strokeDasharray={`${length} ${100 - length}`}
              strokeDashoffset={-(start + GAP / 2)}
              style={{ opacity: slice.opacity, '--i': i } as CSSProperties}
            >
              <title>{`${slice.label}: ${slice.value} (${Math.round(share)}%)`}</title>
            </circle>
          );
        })}
      </g>
      <text className="donut-figure" x="60" y="58" textAnchor="middle" dominantBaseline="central">
        {figure}
      </text>
      <text className="donut-caption" x="60" y="76" textAnchor="middle" dominantBaseline="central">
        {caption}
      </text>
    </svg>
  );
}
