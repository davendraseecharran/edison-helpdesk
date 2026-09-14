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
 *
 * Both links REPLACE rather than push. The page number lives in the same URL
 * as the filters beside it, and every filter control already replaces
 * (`TicketListView.updateParam`, and the same pattern in the people and device
 * lists), so pushing here made the back button mean two different things on
 * one screen: it undid a page change but left a filter change alone. Paging to
 * the end of a long queue and then wanting to leave meant pressing back once
 * per page. Replacing keeps the link a real link — middle-click and "open in
 * new tab" still work, and the URL is still shareable — while back goes to the
 * page the reader actually came from.
 */
export function Pagination({ page, pageCount, hrefFor, label = 'Pagination' }: PaginationProps) {
  if (pageCount <= 1) return null;
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <nav className="pagination" aria-label={label}>
      {hasPrevious ? (
        <Link href={hrefFor(page - 1)} replace className="btn btn-secondary btn-sm" rel="prev">
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
        <Link href={hrefFor(page + 1)} replace className="btn btn-secondary btn-sm" rel="next">
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
