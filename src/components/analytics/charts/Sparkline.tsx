import { useId } from 'react';
import { linePoints, maxOf } from './scale';

/**
 * A trend in the corner of a row: one line, no axes, the shape and nothing
 * else. The values are on the title for a hover; the row it sits in carries
 * the figures a screen reader needs. Revealed from the left by a clip on
 * first paint, like the backlog line, for the same reason.
 */
export function Sparkline({ values, title }: { values: number[]; title?: string }) {
  const clipId = useId();
  const top = maxOf(values);
  // Eight percent of headroom, so a peak is not cut by the box's edge.
  const points = top > 0 ? linePoints(values.map((v) => v * 0.92), top, false) : '';
  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {title ? <title>{title}</title> : null}
      {values.length > 1 && top > 0 ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect className="chart-reveal" x="0" y="0" width="100" height="100" />
            </clipPath>
          </defs>
          <polyline className="chart-line" points={points} clipPath={`url(#${clipId})`} />
        </>
      ) : (
        <line className="chart-baseline" x1="0" x2="100" y1="98" y2="98" />
      )}
    </svg>
  );
}
