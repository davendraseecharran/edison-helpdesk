import type { CSSProperties } from 'react';

export interface SkeletonProps {
  /** Any CSS width; defaults to filling the container. */
  width?: number | string;
  /** Any CSS height; defaults to one line of text. */
  height?: number | string;
  /** Round shape for avatars and icons. */
  circle?: boolean;
  className?: string;
}

/**
 * A shimmering placeholder the exact shape of the content it stands in for.
 *
 * The shimmer is the only decorative animation in the application and stops
 * under `prefers-reduced-motion`, where the bar simply stays flat.
 */
export function Skeleton({ width, height, circle, className }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  const classes = ['skeleton'];
  if (circle) classes.push('skeleton-circle');
  if (className) classes.push(className);
  return <span className={classes.join(' ')} style={style} aria-hidden="true" />;
}

/** A paragraph's worth of bars, the last one shorter as real text would be. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}

/**
 * Wraps a loading region so assistive technology hears one announcement and
 * the visual placeholders stay silent.
 */
export function LoadingRegion({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}
