'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';

export interface FilterBarProps {
  /** The controls: search field, selects, segmented controls. */
  children: ReactNode;
  /** Whether any filter differs from its default. */
  active: boolean;
  /** Link that drops every filter. Preferred; works without JavaScript. */
  clearHref?: string;
  /** Handler alternative for client-managed filters. */
  onClear?: () => void;
  /** Result summary, for example "12 tickets". Announced when it changes. */
  summary?: ReactNode;
  label?: string;
}

/**
 * A wrapping row of filter controls with the result count at the end and a
 * "Clear filters" action that only appears once there is something to clear.
 *
 * From 1024px up the bar stays put while the list scrolls under it, so
 * narrowing a long queue never means scrolling back to the top first. Two
 * things about that are measured rather than guessed, because the bar's height
 * depends on how many controls the list has and how many rows they wrap onto:
 *
 *   * `--filter-h`, published to the panel, is what the sticky table header
 *     below adds to its own `top` so the two never overlap.
 *   * `data-tall` marks a bar that has wrapped onto more than one row. A bar
 *     that deep is not worth pinning — at 1024px the widest list wraps to 216px,
 *     a quarter of the viewport spent on controls nobody is touching — so it
 *     scrolls away like anything else, and the header goes back to the top bar.
 *
 * A ResizeObserver rather than a one-off read: the bar regrows when the window
 * narrows, when a filter brings in the "Clear filters" action, and when the
 * summary changes width.
 */

/** Above this the bar has wrapped, and pinning it would cost more than it gives. */
const MAX_STICKY_HEIGHT = 120;
export function FilterBar({
  children,
  active,
  clearHref,
  onClear,
  summary,
  label = 'Filters',
}: FilterBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    const panel = bar?.parentElement;
    if (!bar || !panel) return;
    const publish = () => {
      const height = Math.round(bar.getBoundingClientRect().height);
      const tall = height > MAX_STICKY_HEIGHT;
      if (tall) bar.setAttribute('data-tall', '');
      else bar.removeAttribute('data-tall');
      panel.style.setProperty('--filter-h', tall ? '0px' : `${height}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      panel.style.removeProperty('--filter-h');
    };
  }, []);

  return (
    <div className="filter-bar" role="group" aria-label={label} ref={barRef}>
      <div className="filter-bar-fields">{children}</div>
      <div className="filter-bar-end">
        {active ? (
          clearHref ? (
            <Link href={clearHref} className="btn btn-ghost btn-sm">
              Clear filters
            </Link>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
              Clear filters
            </button>
          )
        ) : null}
        {summary !== undefined ? (
          <span className="filter-bar-summary" aria-live="polite">
            {summary}
          </span>
        ) : null}
      </div>
    </div>
  );
}
