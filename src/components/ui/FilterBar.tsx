import type { ReactNode } from 'react';
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
 */
export function FilterBar({
  children,
  active,
  clearHref,
  onClear,
  summary,
  label = 'Filters',
}: FilterBarProps) {
  return (
    <div className="filter-bar" role="group" aria-label={label}>
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
