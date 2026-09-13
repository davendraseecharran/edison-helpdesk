import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Icon } from './Icon';

export interface PaginationProps {
  page: number;
  pageCount: number;
  /** Builds the link for a page number, keeping the current filters. */
  hrefFor: (page: number) => string;
  /** Accessible name for the landmark, in case a page has two. */
  label?: string;
}

/**
 * Previous and next as real links, with the position between them.
 *
 * Renders nothing for a single page. An edge that cannot be crossed is a
 * disabled-looking span rather than a dead link, so it is not announced as
 * navigable.
 */
export function Pagination({ page, pageCount, hrefFor, label = 'Pagination' }: PaginationProps) {
  if (pageCount <= 1) return null;
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <nav className="pagination" aria-label={label}>
      {hasPrevious ? (
        <Link href={hrefFor(page - 1)} className="btn btn-secondary btn-sm" rel="prev">
          <Icon icon={ChevronLeft} size={16} />
          <span>Previous</span>
        </Link>
      ) : (
        <span className="btn btn-secondary btn-sm" aria-disabled="true">
          <Icon icon={ChevronLeft} size={16} />
          <span>Previous</span>
        </span>
      )}
      <span className="pagination-status" aria-current="page">
        Page {page} of {pageCount}
      </span>
      {hasNext ? (
        <Link href={hrefFor(page + 1)} className="btn btn-secondary btn-sm" rel="next">
          <span>Next</span>
          <Icon icon={ChevronRight} size={16} />
        </Link>
      ) : (
        <span className="btn btn-secondary btn-sm" aria-disabled="true">
          <span>Next</span>
          <Icon icon={ChevronRight} size={16} />
        </span>
      )}
    </nav>
  );
}
