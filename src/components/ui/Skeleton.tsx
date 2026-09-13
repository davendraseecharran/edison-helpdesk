import { Fragment, type CSSProperties, type ReactNode } from 'react';

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
  children: ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

/*
 * Composites for the route skeletons in `loading.tsx`. Each borrows the real
 * layout's classes (`page-header`, `panel`, `filter-bar`, `facts`) so the
 * placeholder occupies exactly the space the content will, and the swap when
 * the page streams in moves nothing.
 */

/** The page header: a title bar and one line of description, optionally an action. */
export function SkeletonPageHeader({ action = false }: { action?: boolean }) {
  return (
    <div className="page-header" aria-hidden="true">
      <div className="page-header-text skeleton-header-text">
        <Skeleton width={168} height={24} />
        <Skeleton width="min(520px, 70%)" />
      </div>
      {action ? <Skeleton width={112} height={36} /> : null}
    </div>
  );
}

/** A panel with a titled head and either `lines` of body text or the children given. */
export function SkeletonPanel({
  title = 120,
  lines = 3,
  children,
}: {
  title?: number;
  lines?: number;
  children?: ReactNode;
}) {
  return (
    <section className="panel" aria-hidden="true">
      <div className="panel-head">
        <Skeleton width={title} height={16} />
      </div>
      <div className="panel-body">{children ?? <SkeletonText lines={lines} />}</div>
    </section>
  );
}

/** One form field: a label and a control. */
export function SkeletonField({ full = false }: { full?: boolean }) {
  return (
    <span className={full ? 'skeleton-field skeleton-field-full' : 'skeleton-field'}>
      <Skeleton width={72} height={12} />
      <Skeleton height={36} />
    </span>
  );
}

/** The filter bar of a list: a search field, `selects` selects and the count. */
export function SkeletonFilterBar({ selects = 3 }: { selects?: number }) {
  return (
    <div className="filter-bar skeleton-filter-bar" aria-hidden="true">
      <div className="filter-bar-fields">
        <span className="skeleton-field skeleton-field-search">
          <Skeleton width={56} height={12} />
          <Skeleton height={36} />
        </span>
        {Array.from({ length: selects }, (_, index) => (
          <SkeletonField key={index} />
        ))}
      </div>
      <div className="filter-bar-end">
        <Skeleton width={64} />
      </div>
    </div>
  );
}

/** Table rows under a header row: an identifier, a two-line title and `facts` short values. */
export function SkeletonRows({ rows = 8, facts = 3 }: { rows?: number; facts?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      <div className="skeleton-row skeleton-row-head">
        <Skeleton width={56} className="skeleton-id" />
        <span className="skeleton-title-cell">
          <Skeleton width={48} />
        </span>
        {Array.from({ length: facts }, (_, index) => (
          <Skeleton key={index} width={56} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="skeleton-row">
          <Skeleton width={56} className="skeleton-id" />
          <span className="skeleton-title-cell">
            <Skeleton width={row % 3 === 1 ? 'min(260px, 55%)' : 'min(340px, 70%)'} />
            <Skeleton width="min(200px, 40%)" height={10} />
          </span>
          {Array.from({ length: facts }, (_, index) => (
            <Skeleton key={index} width={index === 0 ? 40 : 72} height={20} className="skeleton-pill" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A definition list of `count` label and value pairs, on the real `.facts` grid. */
export function SkeletonFacts({ count = 5 }: { count?: number }) {
  return (
    <dl className="facts" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Fragment key={index}>
          <dt>
            <Skeleton width={64} height={10} />
          </dt>
          <dd>
            <Skeleton width={index % 2 === 0 ? '60%' : '45%'} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** An activity list: a dot and two lines per event. */
export function SkeletonTimeline({ items = 3 }: { items?: number }) {
  return (
    <div className="skeleton-timeline" aria-hidden="true">
      {Array.from({ length: items }, (_, index) => (
        <div key={index} className="skeleton-timeline-item">
          <Skeleton width={10} height={10} circle />
          <span className="skeleton-title-cell">
            <Skeleton width="min(320px, 70%)" />
            <Skeleton width="min(160px, 35%)" height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
